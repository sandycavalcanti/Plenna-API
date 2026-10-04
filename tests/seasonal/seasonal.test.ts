import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

process.env.DATABASE_URL = 'postgresql://localhost:1/offline';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'phase-5-test-secret';
process.env.GOOGLE_CLIENT_ID = 'phase-5-client';
process.env.GOOGLE_CLIENT_SECRET = 'phase-5-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost/callback';
process.env.CRON_SECRET = 'cron-secret';
process.env.EXPO_PUSH_ENABLED = 'false';

type Row = Record<string, any>;

let users: Row[] = [];
let notifications: Row[] = [];
let nextNotificationId = 1;
let failureUserId: number | null = null;
let dispatchCalls: Array<{ userId: number; notifications: Row[] }> = [];
let dispatchFailure = false;

function pick(row: Row, select?: Row) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
}

const db = {
  tb_usuario: {
    findMany: async ({ where, take, select }: any) => {
      const minimumId = where.usuario_id?.gt ?? 0;
      return users
        .filter((user) => user.usuario_status === where.usuario_status && user.usuario_id > minimumId)
        .sort((left, right) => left.usuario_id - right.usuario_id)
        .slice(0, take)
        .map((user) => pick(user, select));
    },
  },
  tb_notificacao: {
    findUnique: async ({ where, select }: any) => {
      const row = notifications.find((notification) =>
        notification.notificacao_chave_idempotencia === where.notificacao_chave_idempotencia);
      return row ? pick(row, select) : null;
    },
  },
  $queryRaw: async (_query: unknown, ...values: any[]) => {
    const [usuario_id, notificacao_tipo, notificacao_titulo, notificacao_mensagem,
      notificacao_chave_idempotencia, compra_id, categoria_id, notificacao_evento] = values;
    if (usuario_id === failureUserId) throw new Error('database failure');
    if (notifications.some((row) => row.notificacao_chave_idempotencia === notificacao_chave_idempotencia)) {
      return [];
    }
    const row = {
      notificacao_id: nextNotificationId++,
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
    notifications.push(row);
    return [{ notificacao_id: row.notificacao_id }];
  },
};

(globalThis as any).prismaRuntime = { client: db, pool: { end: async () => {} } };

const {
  BUSINESS_TIME_ZONE,
  SEASONAL_EVENTS,
  SEASONAL_LEAD_DAYS,
  addCivilDays,
  civilDate,
  differenceInCivilDays,
  getBusinessCivilDate,
  lastWeekdayOfMonth,
  nthWeekdayOfMonth,
  resolveEligibleSeasonalEvents,
} = await import('../../src/modules/notification/seasonal-calendar.ts');
const { processSeasonalNotifications, SeasonalNotificationService } =
  await import('../../src/modules/notification/seasonal-notification.service.ts');
const { SeasonalController } = await import('../../src/modules/notification/seasonal.controller.ts');
const { notificationRouter } = await import('../../src/modules/notification/notification.routes.ts');

const eventByCode = (code: string) => SEASONAL_EVENTS.find((event: any) => event.code === code)!;

function successfulDispatch(userId: number, candidates: Row[]) {
  dispatchCalls.push({ userId, notifications: candidates });
  if (dispatchFailure) throw new Error('push unavailable');
  return Promise.resolve({
    attempted: candidates.length,
    succeeded: candidates.length,
    failed: 0,
    deactivated: 0,
    skipped: 0,
  });
}

function reset() {
  users = [];
  notifications = [];
  nextNotificationId = 1;
  failureUserId = null;
  dispatchCalls = [];
  dispatchFailure = false;
}

function addUsers(count: number, inactiveIds: number[] = []) {
  users = Array.from({ length: count }, (_, index) => ({
    usuario_id: index + 1,
    usuario_status: !inactiveIds.includes(index + 1),
  }));
}

function runSeasonal(referenceDate: Date, options: Row = {}) {
  return processSeasonalNotifications(referenceDate, {
    db: db as any,
    dispatch: successfulDispatch,
    ...options,
  });
}

function responseRecorder() {
  const response: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(body: unknown) {
      response.body = body;
      return response;
    },
  };
  return response;
}

function authRequest(value?: string) {
  return { header: () => value };
}

beforeEach(reset);

test('usa America/Sao_Paulo como timezone de negócio', () => {
  assert.equal(BUSINESS_TIME_ZONE, 'America/Sao_Paulo');
});

test('resolve Natal corretamente', () => {
  assert.deepEqual(eventByCode('NATAL').resolveDate(2026), civilDate(2026, 12, 25));
});

test('resolve Ano Novo corretamente', () => {
  assert.deepEqual(eventByCode('ANO_NOVO').resolveDate(2027), civilDate(2027, 1, 1));
});

test('resolve Dia dos Namorados corretamente', () => {
  assert.deepEqual(eventByCode('DIA_DOS_NAMORADOS').resolveDate(2026), civilDate(2026, 6, 12));
});

test('resolve Dia das Crianças corretamente', () => {
  assert.deepEqual(eventByCode('DIA_DAS_CRIANCAS').resolveDate(2026), civilDate(2026, 10, 12));
});

test('resolve Dia das Mães como segundo domingo de maio', () => {
  assert.deepEqual(eventByCode('DIA_DAS_MAES').resolveDate(2026), civilDate(2026, 5, 10));
  assert.deepEqual(eventByCode('DIA_DAS_MAES').resolveDate(2027), civilDate(2027, 5, 9));
});

test('resolve Dia dos Pais como segundo domingo de agosto', () => {
  assert.deepEqual(eventByCode('DIA_DOS_PAIS').resolveDate(2026), civilDate(2026, 8, 9));
  assert.deepEqual(eventByCode('DIA_DOS_PAIS').resolveDate(2027), civilDate(2027, 8, 8));
});

test('resolve Black Friday como última sexta-feira de novembro', () => {
  assert.deepEqual(eventByCode('BLACK_FRIDAY').resolveDate(2026), civilDate(2026, 11, 27));
  assert.deepEqual(eventByCode('BLACK_FRIDAY').resolveDate(2025), civilDate(2025, 11, 28));
});

test('helper de segundo domingo funciona em configurações diferentes', () => {
  assert.deepEqual(nthWeekdayOfMonth(2026, 3, 0, 2), civilDate(2026, 3, 8));
  assert.deepEqual(nthWeekdayOfMonth(2024, 2, 0, 2), civilDate(2024, 2, 11));
});

test('helper de última sexta-feira funciona em meses diferentes', () => {
  assert.deepEqual(lastWeekdayOfMonth(2026, 11, 5), civilDate(2026, 11, 27));
  assert.deepEqual(lastWeekdayOfMonth(2024, 11, 5), civilDate(2024, 11, 29));
});

test('aritmética civil adiciona dias sem depender de horário local', () => {
  assert.deepEqual(addCivilDays(civilDate(2026, 12, 29), 3), civilDate(2027, 1, 1));
  assert.equal(differenceInCivilDays(civilDate(2027, 1, 1), civilDate(2026, 12, 29)), 3);
});

test('D-3 gera evento elegível', () => {
  const events = resolveEligibleSeasonalEvents(new Date('2026-11-24T15:00:00Z'));
  assert.ok(events.some((event: any) => event.definition.code === 'BLACK_FRIDAY'));
  assert.equal(SEASONAL_LEAD_DAYS, 3);
});

test('D-4 não gera evento', () => {
  assert.equal(resolveEligibleSeasonalEvents(new Date('2026-11-23T15:00:00Z')).length, 0);
});

test('D-2 não gera evento', () => {
  assert.equal(resolveEligibleSeasonalEvents(new Date('2026-11-25T15:00:00Z')).length, 0);
});

test('D0 não gera evento', () => {
  assert.equal(resolveEligibleSeasonalEvents(new Date('2026-11-27T15:00:00Z')).length, 0);
});

test('29/12 gera Ano Novo do ano seguinte', () => {
  const events = resolveEligibleSeasonalEvents(new Date('2026-12-29T15:00:00Z'));
  const newYear = events.find((event: any) => event.definition.code === 'ANO_NOVO');
  assert.deepEqual(newYear?.eventDate, civilDate(2027, 1, 1));
});

test('timezone usa a data civil de São Paulo perto da meia-noite UTC', () => {
  assert.deepEqual(getBusinessCivilDate(new Date('2026-12-29T02:59:59Z')), civilDate(2026, 12, 28));
  assert.deepEqual(getBusinessCivilDate(new Date('2026-12-29T03:00:00Z')), civilDate(2026, 12, 29));
});

test('virada de mês é tratada por data civil', () => {
  const events = resolveEligibleSeasonalEvents(new Date('2026-12-22T15:00:00Z'));
  assert.ok(events.some((event: any) => event.definition.code === 'NATAL'));
});

test('virada de ano é tratada por data civil', () => {
  const events = resolveEligibleSeasonalEvents(new Date('2026-12-29T15:00:00Z'));
  assert.ok(events.some((event: any) => event.eventDate.year === 2027));
});

test('ano bissexto não altera as regras móveis', () => {
  assert.deepEqual(eventByCode('DIA_DAS_MAES').resolveDate(2024), civilDate(2024, 5, 12));
  assert.deepEqual(eventByCode('BLACK_FRIDAY').resolveDate(2024), civilDate(2024, 11, 29));
});

test('catálogo contém somente os sete eventos aprovados', () => {
  assert.deepEqual(SEASONAL_EVENTS.map((event: any) => event.code).sort(), [
    'ANO_NOVO', 'BLACK_FRIDAY', 'DIA_DAS_CRIANCAS', 'DIA_DAS_MAES',
    'DIA_DOS_NAMORADOS', 'DIA_DOS_PAIS', 'NATAL',
  ]);
});

test('sem evento elegível não consulta usuários nem cria notificação', async () => {
  addUsers(2);
  const result = await runSeasonal(new Date('2026-11-23T15:00:00Z'));
  assert.equal(result.eventsMatched, 0);
  assert.equal(result.usersProcessed, 0);
  assert.equal(notifications.length, 0);
});

test('evento elegível cria sazonal para usuário ativo', async () => {
  addUsers(1);
  const result = await runSeasonal(new Date('2026-11-24T15:00:00Z'));
  assert.equal(result.eventsMatched, 1);
  assert.equal(result.usersProcessed, 1);
  assert.equal(result.notificationsCreated, 1);
  assert.equal(notifications[0].notificacao_tipo, 'SAZONAL');
  assert.equal(notifications[0].notificacao_evento, 'BLACK_FRIDAY');
  assert.equal(notifications[0].compra_id, null);
  assert.equal(notifications[0].categoria_id, null);
});

test('usuário inativo não recebe sazonal', async () => {
  addUsers(2, [2]);
  const result = await runSeasonal(new Date('2026-11-24T15:00:00Z'));
  assert.equal(result.usersProcessed, 1);
  assert.equal(result.notificationsCreated, 1);
  assert.equal(notifications[0].usuario_id, 1);
});

test('usuário sem device continua recebendo Central', async () => {
  addUsers(1);
  const result = await runSeasonal(new Date('2026-11-24T15:00:00Z'), {
    dispatch: async () => ({ attempted: 0, succeeded: 0, failed: 0, deactivated: 0, skipped: 1 }),
  });
  assert.equal(result.notificationsCreated, 1);
  assert.equal(result.pushSkipped, 1);
});

test('created true gera push sazonal', async () => {
  addUsers(1);
  const result = await runSeasonal(new Date('2026-11-24T15:00:00Z'));
  assert.equal(result.pushAttempted, 1);
  assert.equal(dispatchCalls.length, 1);
  assert.deepEqual(dispatchCalls[0].notifications[0], { notificationId: 1, type: 'SAZONAL' });
});

test('created false não gera push', async () => {
  addUsers(1);
  await runSeasonal(new Date('2026-11-24T15:00:00Z'));
  dispatchCalls = [];
  const result = await runSeasonal(new Date('2026-11-24T15:00:00Z'));
  assert.equal(result.notificationsCreated, 0);
  assert.equal(result.duplicatesSkipped, 1);
  assert.equal(dispatchCalls.length, 0);
});

test('rerun idempotente não duplica notificação', async () => {
  addUsers(1);
  await runSeasonal(new Date('2026-11-24T15:00:00Z'));
  await runSeasonal(new Date('2026-11-24T15:00:00Z'));
  assert.equal(notifications.length, 1);
});

test('chaves usam o evento correto', async () => {
  addUsers(1);
  await runSeasonal(new Date('2026-11-24T15:00:00Z'));
  assert.equal(notifications[0].notificacao_chave_idempotencia, '1:SAZONAL:BLACK_FRIDAY:2026:3');
});

test('ano seguinte aparece na chave de Ano Novo', async () => {
  addUsers(1);
  await runSeasonal(new Date('2026-12-29T15:00:00Z'));
  const newYear = notifications.find((notification) => notification.notificacao_evento === 'ANO_NOVO');
  assert.equal(newYear?.notificacao_chave_idempotencia, '1:SAZONAL:ANO_NOVO:2027:3');
});

test('dois usuários geram notificações independentes', async () => {
  addUsers(2);
  const result = await runSeasonal(new Date('2026-11-24T15:00:00Z'));
  assert.equal(result.notificationsCreated, 2);
  assert.deepEqual(notifications.map((notification) => notification.usuario_id), [1, 2]);
});

test('dois eventos elegíveis são processados independentemente', async () => {
  addUsers(1);
  const natal = eventByCode('NATAL');
  const anoNovo = { ...eventByCode('ANO_NOVO'), resolveDate: (year: number) => civilDate(year, 12, 25) };
  const result = await runSeasonal(new Date('2026-12-22T15:00:00Z'), { catalog: [natal, anoNovo] });
  assert.equal(result.eventsMatched, 2);
  assert.equal(result.notificationsCreated, 2);
  assert.equal(new Set(notifications.map((notification) => notification.notificacao_chave_idempotencia)).size, 2);
});

test('falha de push mantém notificação sazonal', async () => {
  addUsers(1);
  dispatchFailure = true;
  const result = await runSeasonal(new Date('2026-11-24T15:00:00Z'));
  assert.equal(result.notificationsCreated, 1);
  assert.equal(result.failures, 0);
  assert.equal(result.pushFailed, 1);
  assert.equal(notifications.length, 1);
});

test('falha de banco é contabilizada e processamento continua', async () => {
  addUsers(2);
  failureUserId = 1;
  const result = await runSeasonal(new Date('2026-11-24T15:00:00Z'));
  assert.equal(result.failures, 1);
  assert.equal(result.notificationsCreated, 1);
  assert.equal(notifications[0].usuario_id, 2);
});

test('paginação processa todos os usuários ativos', async () => {
  addUsers(5);
  const result = await runSeasonal(new Date('2026-11-24T15:00:00Z'), { userBatchSize: 2 });
  assert.equal(result.usersProcessed, 5);
  assert.equal(result.notificationsCreated, 5);
});

test('fronteira entre lotes não duplica usuário', async () => {
  addUsers(4);
  const result = await runSeasonal(new Date('2026-11-24T15:00:00Z'), { userBatchSize: 2 });
  assert.equal(result.notificationsCreated, 4);
  assert.equal(new Set(notifications.map((notification) => notification.usuario_id)).size, 4);
});

test('notificação sazonal diferente gera chave diferente', async () => {
  addUsers(1);
  await runSeasonal(new Date('2026-12-22T15:00:00Z'), { catalog: [eventByCode('NATAL')] });
  await runSeasonal(new Date('2026-12-22T15:00:00Z'), {
    catalog: [{ ...eventByCode('NATAL'), code: 'ANO_NOVO', resolveDate: () => civilDate(2026, 12, 25) }],
  });
  assert.equal(notifications.length, 2);
});

test('cron sem Authorization rejeita', async () => {
  const response = responseRecorder();
  await SeasonalController.run(authRequest(), response);
  assert.equal(response.statusCode, 401);
});

test('cron com token incorreto rejeita', async () => {
  const response = responseRecorder();
  await SeasonalController.run(authRequest('Bearer wrong'), response);
  assert.equal(response.statusCode, 401);
});

test('cron com CRON_SECRET correto executa', async () => {
  const original = SeasonalNotificationService.process;
  let called = false;
  SeasonalNotificationService.process = async () => {
    called = true;
    return {
      eventsMatched: 0, usersProcessed: 0, notificationsCreated: 0, duplicatesSkipped: 0,
      failures: 0, pushAttempted: 0, pushSucceeded: 0, pushFailed: 0, pushDeactivated: 0, pushSkipped: 0,
    };
  };
  try {
    const response = responseRecorder();
    await SeasonalController.run(authRequest('Bearer cron-secret'), response);
    assert.equal(response.statusCode, 200);
    assert.equal(called, true);
  } finally {
    SeasonalNotificationService.process = original;
  }
});

test('response do cron é sanitizada', async () => {
  const original = SeasonalNotificationService.process;
  SeasonalNotificationService.process = async () => ({
    eventsMatched: 1, usersProcessed: 2, notificationsCreated: 2, duplicatesSkipped: 0,
    failures: 0, pushAttempted: 2, pushSucceeded: 2, pushFailed: 0, pushDeactivated: 0, pushSkipped: 0,
  });
  try {
    const response = responseRecorder();
    await SeasonalController.run({ headers: { authorization: 'Bearer cron-secret' } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.stringify(response.body).includes('cron-secret'), false);
    assert.equal('users' in response.body, false);
    assert.equal('pushToken' in response.body, false);
  } finally {
    SeasonalNotificationService.process = original;
  }
});

test('cron sem evento retorna sucesso com contadores zerados', async () => {
  const original = SeasonalNotificationService.process;
  SeasonalNotificationService.process = async () => ({
    eventsMatched: 0, usersProcessed: 0, notificationsCreated: 0, duplicatesSkipped: 0,
    failures: 0, pushAttempted: 0, pushSucceeded: 0, pushFailed: 0, pushDeactivated: 0, pushSkipped: 0,
  });
  try {
    const response = responseRecorder();
    await SeasonalController.run(authRequest('Bearer cron-secret'), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.eventsMatched, 0);
    assert.equal(response.body.notificationsCreated, 0);
  } finally {
    SeasonalNotificationService.process = original;
  }
});

test('cron sinaliza falha de processamento sem expor detalhes', async () => {
  const original = SeasonalNotificationService.process;
  SeasonalNotificationService.process = async () => ({
    eventsMatched: 1, usersProcessed: 2, notificationsCreated: 1, duplicatesSkipped: 0,
    failures: 1, pushAttempted: 1, pushSucceeded: 0, pushFailed: 1, pushDeactivated: 0, pushSkipped: 0,
  });
  try {
    const response = responseRecorder();
    await SeasonalController.run(authRequest('Bearer cron-secret'), response);
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.status, 'PARTIAL_FAILURE');
    assert.equal('errorDetails' in response.body, false);
  } finally {
    SeasonalNotificationService.process = original;
  }
});

test('rota sazonal é GET dedicada dentro de notifications', () => {
  const stack = (notificationRouter as any).stack ?? [];
  const seasonalRoute = stack.find((layer: any) => layer.route?.path === '/seasonal/cron');
  assert.ok(seasonalRoute);
  assert.equal(seasonalRoute.route.methods.get, true);
});

test('cron sazonal não usa rota do Gmail', () => {
  const stack = (notificationRouter as any).stack ?? [];
  const paths = stack.map((layer: any) => layer.route?.path).filter(Boolean);
  assert.equal(paths.includes('/sync/cron'), false);
  assert.equal(paths.includes('/seasonal/cron'), true);
});
