import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Prisma } from '@prisma/client';

process.env.DATABASE_URL = 'postgresql://localhost:1/offline';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'phase-2-test-secret';

type NotificationRow = Record<string, any>;
type DeviceRow = Record<string, any>;

let state: { notifications: NotificationRow[]; devices: DeviceRow[] } = {
  notifications: [],
  devices: [],
};
let forcedQueryError: unknown = null;
let nextNotificationId = 1;

function pick(row: Record<string, any>, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
}

function matches(row: Record<string, any>, where: Record<string, any>) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && 'in' in expected) {
      return expected.in.includes(row[key]);
    }
    return row[key] === expected;
  });
}

function sortRows(rows: NotificationRow[], orderBy: any) {
  const rules = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((left, right) => {
    for (const rule of rules) {
      const [key, direction] = Object.entries(rule)[0] as [string, string];
      const leftValue = left[key] instanceof Date ? left[key].getTime() : left[key];
      const rightValue = right[key] instanceof Date ? right[key].getTime() : right[key];
      if (leftValue === rightValue) continue;
      const result = leftValue > rightValue ? 1 : -1;
      return direction === 'desc' ? -result : result;
    }
    return 0;
  });
}

function duplicateError(target: string) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.6.0',
    meta: { target: [target] },
  });
}

function makeClient() {
  const client: any = {
    tb_notificacao: {
      findMany: async ({ where, orderBy, select }: any) => {
        const rows = state.notifications.filter((row) => matches(row, where));
        return sortRows(rows, orderBy).map((row) => pick(row, select));
      },
      count: async ({ where }: any) => state.notifications.filter((row) => matches(row, where)).length,
      findFirst: async ({ where, select }: any) => {
        const row = state.notifications.find((candidate) => matches(candidate, where));
        return row ? pick(row, select) : null;
      },
      findUnique: async ({ where, select }: any) => {
        const key = where.notificacao_chave_idempotencia;
        const row = state.notifications.find((candidate) => candidate.notificacao_chave_idempotencia === key);
        return row ? pick(row, select) : null;
      },
      updateMany: async ({ where, data }: any) => {
        const rows = state.notifications.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    $queryRaw: async (_query: unknown, ...values: any[]) => {
      if (forcedQueryError) {
        const error = forcedQueryError;
        forcedQueryError = null;
        throw error;
      }

      const [usuario_id, notificacao_tipo, notificacao_titulo, notificacao_mensagem,
        notificacao_chave_idempotencia, compra_id, categoria_id, notificacao_evento] = values;
      if (state.notifications.some((row) => row.notificacao_chave_idempotencia === notificacao_chave_idempotencia)) {
        return [];
      }

      const row = {
        notificacao_id: state.notifications.length + 1,
        usuario_id,
        notificacao_tipo,
        notificacao_titulo,
        notificacao_mensagem,
        notificacao_chave_idempotencia,
        compra_id,
        categoria_id,
        notificacao_evento,
        notificacao_lida: 0,
        notificacao_lida_em: null,
        notificacao_data_criacao: new Date(),
      };
      state.notifications.push(row);
      return [{ notificacao_id: row.notificacao_id }];
    },
    tb_dispositivo: {
      upsert: async ({ where, update, create, select }: any) => {
        let row = state.devices.find((candidate) => candidate.dispositivo_push_token === where.dispositivo_push_token);
        if (row) {
          Object.assign(row, update);
        } else {
          row = { dispositivo_id: state.devices.length + 1, ...create };
          state.devices.push(row);
        }
        return pick(row, select);
      },
      findFirst: async ({ where, select }: any) => {
        const row = state.devices.find((candidate) => matches(candidate, where));
        return row ? pick(row, select) : null;
      },
      findMany: async ({ where, select }: any) => state.devices
        .filter((row) => matches(row, where))
        .map((row) => pick(row, select)),
      update: async ({ where, data, select }: any) => {
        const row = state.devices.find((candidate) => candidate.dispositivo_id === where.dispositivo_id);
        if (!row) throw new Error('device not found');
        Object.assign(row, data);
        return pick(row, select);
      },
    },
  };

  return client;
}

const client = makeClient();
(globalThis as any).prismaRuntime = { client, pool: { end: async () => {} } };

const { NotificationService } = await import('../../src/modules/notification/notification.service.ts');
const { DeviceService } = await import('../../src/modules/notification/device.service.ts');
const { registerPushDeviceSchema } = await import('../../src/modules/notification/notification.schemas.ts');

function notification(overrides: Partial<NotificationRow> = {}) {
  return {
    notificacao_id: nextNotificationId++,
    usuario_id: 1,
    notificacao_tipo: 'LIMITE_COMPRA',
    notificacao_titulo: 'Alerta',
    notificacao_mensagem: 'Mensagem',
    notificacao_chave_idempotencia: `key-${state.notifications.length + 1}`,
    compra_id: null,
    categoria_id: null,
    notificacao_evento: null,
    notificacao_lida: 0,
    notificacao_lida_em: null,
    notificacao_data_criacao: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function reset() {
  state = { notifications: [], devices: [] };
  forcedQueryError = null;
  nextNotificationId = 1;
}

beforeEach(reset);

test('lista somente notificações do usuário autenticado', async () => {
  state.notifications.push(notification({ usuario_id: 1 }), notification({ usuario_id: 2 }));
  const result = await NotificationService.listByUserId(1);
  assert.equal(result.length, 1);
  assert.equal(result[0].notificacao_id, 1);
});

test('ordena notificações mais recentes primeiro', async () => {
  state.notifications.push(
    notification({ notificacao_data_criacao: new Date('2026-01-01') }),
    notification({ notificacao_data_criacao: new Date('2026-02-01') }),
  );
  const result = await NotificationService.listByUserId(1);
  assert.deepEqual(result.map((item) => item.notificacao_id), [2, 1]);
});

test('usuário sem notificações recebe lista vazia', async () => {
  assert.deepEqual(await NotificationService.listByUserId(1), []);
});

test('unread count retorna zero quando não há notificações não lidas', async () => {
  state.notifications.push(notification({ notificacao_lida: 1 }));
  assert.equal(await NotificationService.countUnread(1), 0);
});

test('unread count considera somente as notificações não lidas do usuário', async () => {
  state.notifications.push(
    notification({ notificacao_lida: 0 }),
    notification({ notificacao_lida: 1 }),
    notification({ usuario_id: 2, notificacao_lida: 0 }),
  );
  assert.equal(await NotificationService.countUnread(1), 1);
});

test('marca notificação própria como lida com timestamp', async () => {
  state.notifications.push(notification());
  const result = await NotificationService.markAsRead(1, 1);
  assert.equal(result?.notificacao_lida, 1);
  assert.ok(result?.notificacao_lida_em instanceof Date);
});

test('marcar notificação já lida é idempotente e preserva timestamp', async () => {
  const readAt = new Date('2026-02-01T00:00:00Z');
  state.notifications.push(notification({ notificacao_lida: 1, notificacao_lida_em: readAt }));
  const result = await NotificationService.markAsRead(1, 1);
  assert.equal(result?.notificacao_lida, 1);
  assert.equal(result?.notificacao_lida_em, readAt);
});

test('usuário A não consegue marcar notificação do usuário B', async () => {
  state.notifications.push(notification({ usuario_id: 2 }));
  await assert.rejects(() => NotificationService.markAsRead(1, 1), (error: any) => error.statusCode === 404);
  assert.equal(state.notifications[0].notificacao_lida, 0);
});

test('notificação inexistente retorna erro de recurso não encontrado', async () => {
  await assert.rejects(() => NotificationService.markAsRead(1, 999), (error: any) => error.statusCode === 404);
});

test('criação interna persiste uma notificação sem expor dados desnecessários', async () => {
  const result = await NotificationService.createNotification({
    userId: 1,
    type: 'SAZONAL',
    title: 'Lembrete',
    message: 'Mensagem',
    idempotencyKey: 'seasonal-2026',
    event: 'NATAL',
  });
  assert.equal(result.created, true);
  assert.equal(result.notification.notificacao_tipo, 'SAZONAL');
  assert.equal('usuario_id' in result.notification, false);
  assert.equal('notificacao_chave_idempotencia' in result.notification, false);
});

test('criação repetida com a mesma chave retorna existente sem duplicar', async () => {
  const input = {
    userId: 1,
    type: 'LIMITE_MENSAL' as const,
    title: 'Limite',
    message: 'Mensagem',
    idempotencyKey: 'monthly-1',
  };
  const first = await NotificationService.createNotification(input);
  const second = await NotificationService.createNotification(input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(state.notifications.length, 1);
});

test('concorrência na mesma chave é resolvida sem abortar a transaction', async () => {
  const input = {
    userId: 1,
    type: 'LIMITE_COMPRA',
    title: 'Alerta',
    message: 'Mensagem',
    idempotencyKey: 'race-1',
  } as const;
  const results = await Promise.all([
    NotificationService.createNotification(input, client),
    NotificationService.createNotification(input, client),
  ]);
  assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
  assert.equal(state.notifications.length, 1);
});

test('erro de integridade diferente da chave de idempotência não é mascarado', async () => {
  forcedQueryError = duplicateError('outra_constraint');
  await assert.rejects(() => NotificationService.createNotification({
    userId: 1,
    type: 'LIMITE_COMPRA',
    title: 'Alerta',
    message: 'Mensagem',
    idempotencyKey: 'other-constraint',
  }), (error: any) => error.code === 'P2002');
});

test('mesma chave para outro usuário retorna conflito de integridade', async () => {
  const input = {
    userId: 1,
    type: 'LIMITE_COMPRA' as const,
    title: 'Alerta',
    message: 'Mensagem',
    idempotencyKey: 'cross-user-key',
  };
  await NotificationService.createNotification(input);
  await assert.rejects(
    () => NotificationService.createNotification({ ...input, userId: 2 }),
    (error: any) => error.statusCode === 409,
  );
  assert.equal(state.notifications[0].usuario_id, 1);
});

test('registra novo Expo Push Token e não retorna o token', async () => {
  const result = await DeviceService.registerPushToken(1, 'ExponentPushToken[token-1]', 'android');
  assert.equal(state.devices.length, 1);
  assert.equal(result.dispositivo_ativo, 1);
  assert.equal('dispositivo_push_token' in result, false);
});

test('registrar novamente o token do mesmo usuário atualiza e mantém um único device', async () => {
  await DeviceService.registerPushToken(1, 'ExponentPushToken[token-1]', 'android');
  const result = await DeviceService.registerPushToken(1, 'ExponentPushToken[token-1]', 'ios');
  assert.equal(state.devices.length, 1);
  assert.equal(state.devices[0].dispositivo_plataforma, 'ios');
  assert.equal(result.dispositivo_ativo, 1);
});

test('token registrado fica ativo', async () => {
  await DeviceService.registerPushToken(1, 'ExponentPushToken[token-1]', 'android');
  const active = await DeviceService.listActiveByUserId(1);
  assert.equal(active.length, 1);
  assert.equal(active[0].dispositivo_push_token, 'ExponentPushToken[token-1]');
});

test('token associado a outro usuário é reassociado com segurança', async () => {
  await DeviceService.registerPushToken(1, 'ExponentPushToken[token-1]', 'android');
  await DeviceService.registerPushToken(2, 'ExponentPushToken[token-1]', 'android');
  assert.equal(state.devices.length, 1);
  assert.equal(state.devices[0].usuario_id, 2);
});

test('desativa token sem apagar o registro', async () => {
  await DeviceService.registerPushToken(1, 'ExponentPushToken[token-1]', 'android');
  await DeviceService.disablePushToken(1, 'ExponentPushToken[token-1]');
  assert.equal(state.devices.length, 1);
  assert.equal(state.devices[0].dispositivo_ativo, 0);
});

test('usuário não desativa vínculo de device pertencente a outro usuário', async () => {
  await DeviceService.registerPushToken(1, 'ExponentPushToken[token-1]', 'android');
  await assert.rejects(
    () => DeviceService.disablePushToken(2, 'ExponentPushToken[token-1]'),
    (error: any) => error.statusCode === 404,
  );
  assert.equal(state.devices[0].dispositivo_ativo, 1);
});

test('lookup interno retorna somente devices ativos do usuário', async () => {
  await DeviceService.registerPushToken(1, 'ExponentPushToken[token-1]', 'android');
  await DeviceService.registerPushToken(1, 'ExponentPushToken[token-2]', 'android');
  await DeviceService.disablePushToken(1, 'ExponentPushToken[token-1]');
  const active = await DeviceService.listActiveByUserId(1);
  assert.deepEqual(active.map((device) => device.dispositivo_push_token), ['ExponentPushToken[token-2]']);
});

test('schema rejeita token e plataforma fora do contrato', () => {
  assert.throws(() => registerPushDeviceSchema.parse({ pushToken: 'token-raw', platform: 'android' }));
  assert.throws(() => registerPushDeviceSchema.parse({ pushToken: 'ExponentPushToken[token-1]', platform: 'web' }));
});
