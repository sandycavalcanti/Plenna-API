import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

process.env.DATABASE_URL = 'postgresql://localhost:1/offline';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'rf019-test-secret';
process.env.EMAIL_FISCAL_LINK_FETCH_ENABLED = 'false';

type Row = Record<string, any>;

const categories = [
  { categoria_id: 1, categoria_nome: 'Moda' },
  { categoria_id: 2, categoria_nome: 'Eletrônicos' },
  { categoria_id: 3, categoria_nome: 'Casa' },
];

let state: {
  users: Row[];
  purchases: Row[];
  items: Row[];
  preferences: Row[];
  notifications: Row[];
  metrics: Row[];
  nextPurchaseId: number;
  nextItemId: number;
  nextNotificationId: number;
  nextMetricId: number;
} = createState();
let transactionOpen = false;

function createState() {
  return {
    users: [{
      usuario_id: 1,
      usuario_status: true,
      usuario_meta_valor_compra: null,
      usuario_meta_valor_mensal: null,
    }],
    purchases: [],
    items: [],
    preferences: [],
    notifications: [],
    metrics: [],
    nextPurchaseId: 1,
    nextItemId: 1,
    nextNotificationId: 1,
    nextMetricId: 1,
  };
}

function compareValue(actual: any, expected: any) {
  if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
    if ('in' in expected) return expected.in.includes(actual);
    if ('gte' in expected && !(actual >= expected.gte)) return false;
    if ('lt' in expected && !(actual < expected.lt)) return false;
    if ('not' in expected && actual === expected.not) return false;
    return true;
  }
  return actual === expected;
}

function matches(row: Row, where: Row = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return expected.some((candidate: Row) => matches(row, candidate));
    return compareValue(row[key], expected);
  });
}

function category(categoryId: number | null) {
  return categories.find((item) => item.categoria_id === categoryId) ?? null;
}

function activeItemsForPurchase(compraId: number, where: Row = {}) {
  return state.items
    .filter((item) => item.compra_id === compraId && matches(item, where))
    .map((item) => ({ ...item, tb_categoria: category(item.categoria_id) }));
}

function materializePurchase(purchase: Row) {
  return {
    ...purchase,
    tb_usuario: state.users.find((user) => user.usuario_id === purchase.usuario_id),
    tb_compra_item: activeItemsForPurchase(purchase.compra_id, { compra_item_ativo: 1 }),
  };
}

function makeClient() {
  const client: any = {
    tb_usuario: {
      findFirst: async ({ where }: Row) => state.users.find((row) => matches(row, where)) ?? null,
    },
    tb_categoria: {
      count: async ({ where }: Row) => categories.filter((row) => where.categoria_id.in.includes(row.categoria_id)).length,
      findMany: async ({ where }: Row) => categories.filter((row) => row.categoria_nome.toLowerCase() === where.categoria_nome.equals.toLowerCase()),
    },
    tb_forma_pagamento: {
      findUnique: async ({ where }: Row) => ({ forma_pagamento_id: where.forma_pagamento_id }),
    },
    tb_usuario_preferencia: {},
    tb_preferencia: {
      findMany: async ({ where }: Row) => state.preferences.filter((row) => matches(row, where)),
    },
    tb_compra: {
      findFirst: async ({ where }: Row) => {
        const purchase = state.purchases.find((row) => matches(row, where));
        return purchase ? materializePurchase(purchase) : null;
      },
      findMany: async ({ where, select }: Row) => state.purchases
        .filter((purchase) => matches(purchase, where))
        .map((purchase) => ({
          compra_valor: purchase.compra_valor,
          tb_compra_item: activeItemsForPurchase(
            purchase.compra_id,
            select?.tb_compra_item?.where ?? { compra_item_ativo: 1 },
          ),
        })),
      create: async ({ data }: Row) => {
        const purchase = {
          compra_id: state.nextPurchaseId++,
          compra_status: 'CONFIRMADA',
          compra_ativo: 1,
          compra_acima_limite: null,
          compra_desconto: 0,
          compra_data_criacao: new Date(),
          ...data,
        };
        state.purchases.push(purchase);
        if (data.tb_compra_item?.create) {
          state.items.push(...data.tb_compra_item.create.map((item: Row) => ({
            compra_item_id: state.nextItemId++,
            compra_item_ativo: 1,
            ...item,
          })));
        }
        // Prisma retorna uma cópia do registro criado; a avaliação posterior
        // atualiza o banco sem mutar o objeto retornado por create.
        return { ...purchase };
      },
      update: async ({ where, data }: Row) => {
        const purchase = state.purchases.find((row) => row.compra_id === where.compra_id);
        if (!purchase) throw new Error('purchase not found');
        Object.assign(purchase, data);
        return purchase;
      },
    },
    tb_compra_item: {
      createMany: async ({ data }: Row) => {
        state.items.push(...data.map((item: Row) => ({
          compra_item_id: state.nextItemId++,
          compra_item_ativo: 1,
          ...item,
        })));
        return { count: data.length };
      },
      findMany: async ({ where }: Row) => state.items.filter((item) => matches(item, where)),
      findFirst: async ({ where }: Row) => state.items.find((item) => matches(item, where)) ?? null,
      count: async ({ where }: Row) => state.items.filter((item) => matches(item, where)).length,
      update: async ({ where, data }: Row) => {
        const item = state.items.find((row) => row.compra_item_id === where.compra_item_id);
        if (!item) throw new Error('item not found');
        Object.assign(item, data);
        return item;
      },
      updateMany: async ({ where, data }: Row) => {
        const rows = state.items.filter((item) => matches(item, where));
        rows.forEach((item) => Object.assign(item, data));
        return { count: rows.length };
      },
    },
    tb_notificacao: {
      findUnique: async ({ where }: Row) => state.notifications.find(
        (notification) => notification.notificacao_chave_idempotencia === where.notificacao_chave_idempotencia,
      ) ?? null,
      create: async ({ data }: Row) => {
        const existing = state.notifications.find(
          (notification) => notification.notificacao_chave_idempotencia === data.notificacao_chave_idempotencia,
        );
        if (existing) return existing;
        const notification = {
          notificacao_id: state.nextNotificationId++,
          notificacao_lida: 0,
          notificacao_lida_em: null,
          notificacao_data_criacao: new Date(),
          ...data,
        };
        state.notifications.push(notification);
        return notification;
      },
    },
    $queryRaw: async (_query: unknown, ...values: any[]) => {
      const [usuario_id, notificacao_tipo, notificacao_titulo, notificacao_mensagem,
        notificacao_chave_idempotencia, compra_id, categoria_id, notificacao_evento] = values;
      if (state.notifications.some((notification) => notification.notificacao_chave_idempotencia === notificacao_chave_idempotencia)) {
        return [];
      }
      const notification = {
        notificacao_id: state.nextNotificationId++,
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
      state.notifications.push(notification);
      return [{ notificacao_id: notification.notificacao_id }];
    },
    tb_metricas: {
      findFirst: async ({ where }: Row) => state.metrics.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: Row) => {
        const metric = { metricas_id: state.nextMetricId++, ...data };
        state.metrics.push(metric);
        return metric;
      },
      update: async ({ where, data }: Row) => {
        const metric = state.metrics.find((row) => row.metricas_id === where.metricas_id);
        Object.assign(metric, data);
        return metric;
      },
    },
    $transaction: async (callback: (db: any) => unknown) => {
      transactionOpen = true;
      try {
        return await callback(client);
      } finally {
        transactionOpen = false;
      }
    },
  };
  return client;
}

const client = makeClient();
(globalThis as any).prismaRuntime = { client, pool: { end: async () => {} } };

const { calculatePurchaseAboveLimit, evaluateConfirmedPurchaseLimits } = await import('../../src/modules/compra/limite.service.ts');
const { CompraService } = await import('../../src/modules/compra/compra.service.ts');
const { MetricasService } = await import('../../src/modules/compra/metricas.service.ts');
const { createCompraFromMessage } = await import('../../src/modules/email/email-sync.service.ts');
const { PaymentMethodResolver } = await import('../../src/modules/forma-pagamento/payment-method.resolver.ts');
const { updateUserSchema } = await import('../../src/modules/user/user.schemas.ts');
const { pushService } = await import('../../src/modules/notification/push.service.ts');

function reset() {
  state = createState();
  transactionOpen = false;
}

function configureLimits(purchase: number | null, monthly: number | null, categoryLimit: number | null = null) {
  state.users[0].usuario_meta_valor_compra = purchase;
  state.users[0].usuario_meta_valor_mensal = monthly;
  state.preferences = categoryLimit === null
    ? []
    : [{ usuario_id: 1, categoria_id: 1, preferencia_meta: categoryLimit }];
}

function addPurchase(overrides: Row = {}) {
  const purchase = {
    compra_id: state.nextPurchaseId++,
    usuario_id: 1,
    compra_valor: 0,
    compra_horario: new Date('2026-08-15T12:00:00Z'),
    compra_status: 'CONFIRMADA',
    compra_ativo: 1,
    compra_acima_limite: null,
    compra_desconto: 0,
    ...overrides,
  };
  state.purchases.push(purchase);
  return purchase;
}

function addItem(compraId: number, categoriaId: number | null, valor: number, quantidade: number | null = 1, ativo = 1) {
  state.items.push({
    compra_item_id: state.nextItemId++,
    compra_id: compraId,
    categoria_id: categoriaId,
    compra_item_valor: valor,
    compra_item_quantidade: quantidade,
    compra_item_ativo: ativo,
  });
}

async function evaluateCurrent() {
  return evaluateConfirmedPurchaseLimits(state.purchases.at(-1)?.compra_id ?? 0);
}

beforeEach(reset);

test('abaixo de todos os limites não gera alerta', async () => {
  configureLimits(100, 500, 100);
  const purchase = addPurchase({ compra_valor: 50 });
  addItem(purchase.compra_id, 1, 50);
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts, []);
});

test('gera somente limite por compra', async () => {
  configureLimits(100, 500, 100);
  addPurchase({ compra_valor: 150 });
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_COMPRA']);
});

test('limite de compra zero é configurado e qualquer compra positiva excede', async () => {
  configureLimits(0, null, null);
  const current = addPurchase({ compra_valor: 0.01 });
  const result = await evaluateCurrent();
  assert.equal(result.purchaseAboveLimit, true);
  assert.equal(state.purchases[0].compra_acima_limite, true);
  assert.equal(state.notifications[0].notificacao_evento, null);
});

test('helper único de limite trata nulo, zero, igualdade, abaixo e acima', () => {
  assert.equal(calculatePurchaseAboveLimit(10, null), null);
  assert.equal(calculatePurchaseAboveLimit(10, 0), true);
  assert.equal(calculatePurchaseAboveLimit(100, 100), false);
  assert.equal(calculatePurchaseAboveLimit(99, 100), false);
  assert.equal(calculatePurchaseAboveLimit(101, 100), true);
});

test('contrato de preferência aceita zero e rejeita limite negativo', () => {
  assert.equal(updateUserSchema.parse({ metaValorCompra: 0 }).metaValorCompra, 0);
  assert.throws(() => updateUserSchema.parse({ metaValorCompra: -1 }));
});

test('gera somente limite de categoria', async () => {
  configureLimits(500, 1000, 40);
  const purchase = addPurchase({ compra_valor: 50 });
  addItem(purchase.compra_id, 1, 50);
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_CATEGORIA']);
});

test('limite de categoria usa valor unitário multiplicado pela quantidade', async () => {
  configureLimits(500, null, 100);
  const purchase = addPurchase({ compra_valor: 120 });
  addItem(purchase.compra_id, 1, 60, 2);
  const result = await evaluateCurrent();
  assert.equal(result.categoryTotals[0].monthlyTotalCents, 12000);
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_CATEGORIA']);
});

test('gera somente limite mensal geral acumulado', async () => {
  configureLimits(500, 100, null);
  addPurchase({ compra_valor: 60 });
  addPurchase({ compra_valor: 60 });
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_MENSAL']);
});

test('gera categoria e mensal geral simultaneamente', async () => {
  configureLimits(500, 100, 40);
  addPurchase({ compra_valor: 60 });
  const current = addPurchase({ compra_valor: 60 });
  addItem(current.compra_id, 1, 60);
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_CATEGORIA', 'LIMITE_MENSAL']);
});

test('gera compra e categoria sem mensal', async () => {
  configureLimits(50, null, 40);
  const current = addPurchase({ compra_valor: 60 });
  addItem(current.compra_id, 1, 60);
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_COMPRA', 'LIMITE_CATEGORIA']);
});

test('gera compra e mensal sem categoria', async () => {
  configureLimits(50, 100, null);
  addPurchase({ compra_valor: 60 });
  addPurchase({ compra_valor: 60 });
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_COMPRA', 'LIMITE_MENSAL']);
});

test('gera os três tipos independentes', async () => {
  configureLimits(50, 100, 40);
  const current = addPurchase({ compra_valor: 60 });
  addItem(current.compra_id, 1, 60);
  addPurchase({ compra_valor: 60 });
  const result = await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_COMPRA', 'LIMITE_CATEGORIA', 'LIMITE_MENSAL']);
});

test('não cria limite de compra, mensal ou categoria sem configuração correspondente', async () => {
  configureLimits(null, null, null);
  const current = addPurchase({ compra_valor: 500 });
  addItem(current.compra_id, 1, 500);
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts, []);
});

test('preferência existente mas total de categoria ainda abaixo não alerta', async () => {
  configureLimits(500, 1000, 100);
  const current = addPurchase({ compra_valor: 50 });
  addItem(current.compra_id, 1, 50);
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts, []);
});

test('igualdade ao limite não é ultrapassagem nos três níveis', async () => {
  configureLimits(100, 100, 100);
  const current = addPurchase({ compra_valor: 100 });
  addItem(current.compra_id, 1, 100);
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts, []);
  assert.equal(state.purchases[0].compra_acima_limite, false);
});

test('uma compra com múltiplas categorias soma cada categoria separadamente', async () => {
  configureLimits(1000, 1000, 40);
  state.preferences.push({ usuario_id: 1, categoria_id: 2, preferencia_meta: 30 });
  const current = addPurchase({ compra_valor: 70 });
  addItem(current.compra_id, 1, 45);
  addItem(current.compra_id, 2, 25);
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts.map((alert: Row) => alert.categoryId), [1]);
  assert.equal(state.notifications.some((notification) => notification.categoria_id === 2), false);
});

test('duas categorias excedidas geram duas notificações e duas chaves', async () => {
  configureLimits(1000, 1000, 40);
  state.preferences.push({ usuario_id: 1, categoria_id: 2, preferencia_meta: 20 });
  const current = addPurchase({ compra_valor: 70 });
  addItem(current.compra_id, 1, 45);
  addItem(current.compra_id, 2, 25);
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_CATEGORIA', 'LIMITE_CATEGORIA']);
  assert.equal(new Set(result.alerts.map((alert: Row) => alert.idempotencyKey)).size, 2);
});

test('item soft-deleted não entra no total da categoria', async () => {
  configureLimits(1000, 1000, 40);
  const current = addPurchase({ compra_valor: 50 });
  addItem(current.compra_id, 1, 50, 1, 0);
  const result = await evaluateCurrent();
  assert.equal(result.alerts.some((alert: Row) => alert.type === 'LIMITE_CATEGORIA'), false);
});

test('compra soft-deleted não é elegível', async () => {
  configureLimits(1, 1, 1);
  const current = addPurchase({ compra_valor: 100, compra_ativo: 0 });
  const result = await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.equal(result.eligible, false);
  assert.equal(state.notifications.length, 0);
});

test('compra AGUARDANDO_CONFIRMACAO não alerta', async () => {
  configureLimits(1, 1, 1);
  const current = addPurchase({ compra_valor: 100, compra_status: 'AGUARDANDO_CONFIRMACAO' });
  const result = await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.equal(result.eligible, false);
  assert.equal(state.notifications.length, 0);
});

test('compra IGNORADA não alerta', async () => {
  configureLimits(1, 1, 1);
  const current = addPurchase({ compra_valor: 100, compra_status: 'IGNORADA' });
  const result = await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.equal(result.eligible, false);
  assert.equal(state.notifications.length, 0);
});

test('Gmail pendente não alerta', async () => {
  configureLimits(1, 1, 1);
  const current = addPurchase({ compra_valor: 100, compra_email: true, compra_status: 'AGUARDANDO_CONFIRMACAO' });
  const result = await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.equal(result.eligible, false);
  assert.equal(state.notifications.length, 0);
});

test('Gmail confirmada usa a mesma avaliação central', async () => {
  configureLimits(50, null, null);
  const current = addPurchase({ compra_valor: 80, compra_email: true, compra_status: 'CONFIRMADA' });
  const result = await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_COMPRA']);
  assert.equal(state.purchases[0].compra_acima_limite, true);
});

test('nova compra acima de categoria já excedida gera novo alerta', async () => {
  configureLimits(1000, 1000, 50);
  const previous = addPurchase({ compra_valor: 60 });
  addItem(previous.compra_id, 1, 60);
  const current = addPurchase({ compra_valor: 10 });
  addItem(current.compra_id, 1, 10);
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_CATEGORIA']);
  assert.equal(result.alerts[0].idempotencyKey, '1:2:LIMITE_CATEGORIA:1');
});

test('nova compra depois de mensal já excedido gera novo alerta', async () => {
  configureLimits(1000, 100);
  addPurchase({ compra_valor: 110 });
  const current = addPurchase({ compra_valor: 10 });
  const result = await evaluateCurrent();
  assert.deepEqual(result.alerts.map((alert: Row) => alert.type), ['LIMITE_MENSAL']);
  assert.equal(result.alerts[0].idempotencyKey, '1:2:LIMITE_MENSAL');
});

test('retry da mesma compra não duplica alerta', async () => {
  configureLimits(50, null, null);
  const current = addPurchase({ compra_valor: 80 });
  const first = await evaluateConfirmedPurchaseLimits(current.compra_id);
  const second = await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.equal(first.alerts[0].created, true);
  assert.equal(second.alerts[0].created, false);
  assert.equal(state.notifications.length, 1);
});

test('retry não duplica alertas de categoria separados por categoria', async () => {
  configureLimits(1000, null, 10);
  state.preferences.push({ usuario_id: 1, categoria_id: 2, preferencia_meta: 10 });
  const current = addPurchase({ compra_valor: 30 });
  addItem(current.compra_id, 1, 20);
  addItem(current.compra_id, 2, 20);
  await evaluateConfirmedPurchaseLimits(current.compra_id);
  await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.equal(state.notifications.length, 2);
  assert.equal(new Set(state.notifications.map((notification) => notification.notificacao_chave_idempotencia)).size, 2);
});

test('compras diferentes possuem chaves de idempotência diferentes', async () => {
  configureLimits(50, 100, null);
  const first = addPurchase({ compra_valor: 60 });
  const second = addPurchase({ compra_valor: 60 });
  await evaluateConfirmedPurchaseLimits(first.compra_id);
  await evaluateConfirmedPurchaseLimits(second.compra_id);
  assert.deepEqual(
    state.notifications.map((notification) => notification.notificacao_chave_idempotencia),
    ['1:1:LIMITE_COMPRA', '1:1:LIMITE_MENSAL', '1:2:LIMITE_COMPRA', '1:2:LIMITE_MENSAL'],
  );
});

test('virada de mês não mistura compras do mês anterior', async () => {
  configureLimits(1000, 100, 50);
  const previous = addPurchase({ compra_valor: 200, compra_horario: new Date('2026-01-31T23:00:00Z') });
  addItem(previous.compra_id, 1, 200);
  const current = addPurchase({ compra_valor: 40, compra_horario: new Date('2026-02-01T00:00:00Z') });
  addItem(current.compra_id, 1, 40);
  const result = await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.deepEqual(result.alerts, []);
});

test('categoria do mês anterior não contamina o mês atual', async () => {
  configureLimits(1000, null, 50);
  const previous = addPurchase({ compra_valor: 200, compra_horario: new Date('2026-01-31T23:00:00Z') });
  addItem(previous.compra_id, 1, 200);
  const current = addPurchase({ compra_valor: 40, compra_horario: new Date('2026-02-01T00:00:00Z') });
  addItem(current.compra_id, 1, 40);
  const result = await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.equal(result.alerts.length, 0);
});

test('compra_acima_limite é atualizado coerentemente pela avaliação central', async () => {
  configureLimits(100, null, null);
  const current = addPurchase({ compra_valor: 80, compra_acima_limite: true });
  await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.equal(state.purchases[0].compra_acima_limite, false);
  state.purchases[0].compra_valor = 120;
  await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.equal(state.purchases[0].compra_acima_limite, true);
});

test('compra manual confirmada converge para avaliação e persistência de alerta', async () => {
  configureLimits(50, null, null);
  const result = await CompraService.create(1, {
    compraHorario: new Date('2026-08-15T12:00:00Z'),
    compraClassificacao: 'PENDENTE',
    compraValor: 80,
  });
  assert.equal(result.compra.compra_status, 'CONFIRMADA');
  assert.equal(result.compra.compra_acima_limite, state.purchases[0].compra_acima_limite);
  assert.equal(state.purchases[0].compra_acima_limite, true);
  assert.equal(state.notifications.length, 1);
});

test('fluxo manual persiste valor da linha sem quantidade', async () => {
  configureLimits(null, null, null);
  await CompraService.create(1, {
    compraHorario: new Date('2026-08-15T12:00:00Z'),
    compraClassificacao: 'PENDENTE',
    items: [{ categoriaId: 1, nome: 'Produto manual', valor: 25 }],
  });
  assert.equal(Number(state.items[0].compra_item_valor), 25);
  assert.equal('compra_item_quantidade' in state.items[0], false);
});

test('confirmação manual de compra pendente converge para avaliação', async () => {
  configureLimits(50, null, null);
  const current = addPurchase({ compra_valor: 80, compra_status: 'AGUARDANDO_CONFIRMACAO' });
  await CompraService.confirm(1, current.compra_id);
  assert.equal(state.purchases[0].compra_status, 'CONFIRMADA');
  assert.equal(state.notifications.length, 1);
});

test('atualização de compra confirmada converge para a avaliação central', async () => {
  configureLimits(50, null, null);
  const current = addPurchase({ compra_valor: 40 });
  await CompraService.update(1, current.compra_id, {
    compraValor: 80,
    compraHorario: current.compra_horario,
    compraClassificacao: 'PENDENTE',
  } as any);
  assert.equal(state.purchases[0].compra_acima_limite, true);
  assert.equal(state.notifications.length, 1);
});

test('remoção de item recalcula o total usando quantidade antes da avaliação', async () => {
  configureLimits(100, null, null);
  const current = addPurchase({ compra_valor: 120 });
  addItem(current.compra_id, 1, 50, 2);
  const removed = { compra_item_id: state.nextItemId };
  addItem(current.compra_id, 1, 20, 1);
  await CompraService.deleteItem(1, current.compra_id, removed.compra_item_id);
  assert.equal(Number(state.purchases[0].compra_valor), 100);
  assert.equal(state.purchases[0].compra_acima_limite, false);
  assert.equal(state.notifications.length, 0);
});

test('MetricasService usa total mensal acumulado para metricas_acima_limite', async () => {
  configureLimits(100, 100, null);
  addPurchase({ compra_valor: 60 });
  addPurchase({ compra_valor: 60 });
  const metric = await MetricasService.recalculateMonthlyMetrics(1, new Date('2026-08-15T12:00:00Z'));
  assert.equal(metric.metricas_acima_limite, true);
});

test('Gmail automaticamente confirmada chama a mesma avaliação central', async () => {
  configureLimits(50, null, null);
  const originalResolve = PaymentMethodResolver.resolve;
  PaymentMethodResolver.resolve = async () => ({ id: 1, name: 'Pix' });
  try {
    const result = await createCompraFromMessage(1, {
      id: 'gmail-confirmed-rf019',
      from: 'Loja Teste <vendas@loja.test>',
      subject: 'Pedido confirmado',
      bodyText: 'Produto: Produto Teste\nQuantidade: 1\nValor do produto: R$ 80,00\nTotal da compra: R$ 80,00\nPix',
      snippet: 'Pedido confirmado',
      labelIds: [],
      internalDate: String(Date.parse('2026-08-15T12:00:00Z')),
    } as any);
    assert.equal('created' in result, true);
    assert.equal(state.purchases[0].compra_status, 'CONFIRMADA');
    assert.equal((result as any).created.compra_acima_limite, state.purchases[0].compra_acima_limite);
    assert.equal(state.notifications.length, 1);
  } finally {
    PaymentMethodResolver.resolve = originalResolve;
  }
});

test('Gmail incompleto permanece pendente e não chama RF019', async () => {
  configureLimits(50, null, null);
  const originalResolve = PaymentMethodResolver.resolve;
  PaymentMethodResolver.resolve = async () => null;
  try {
    const result = await createCompraFromMessage(1, {
      id: 'gmail-pending-rf019',
      from: 'Loja Teste <vendas@loja.test>',
      subject: 'Pedido recebido',
      bodyText: 'Produto: Produto Teste\nQuantidade: 1\nValor do produto: R$ 80,00\nTotal da compra: R$ 80,00',
      snippet: 'Pedido recebido',
      labelIds: [],
      internalDate: String(Date.parse('2026-08-15T12:00:00Z')),
    } as any);
    assert.equal('created' in result, true);
    assert.equal(state.purchases[0].compra_status, 'AGUARDANDO_CONFIRMACAO');
    assert.equal(state.notifications.length, 0);
  } finally {
    PaymentMethodResolver.resolve = originalResolve;
  }
});

test('reprocessamento da avaliação central preserva a idempotência por compra', async () => {
  configureLimits(50, null, null);
  const current = addPurchase({ compra_valor: 80 });
  await evaluateConfirmedPurchaseLimits(current.compra_id);
  await evaluateConfirmedPurchaseLimits(current.compra_id);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].notificacao_chave_idempotencia, '1:1:LIMITE_COMPRA');
});

test('push manual é aguardado somente depois do commit da transação', async () => {
  configureLimits(50, null, null);
  const originalDispatch = pushService.dispatchForUser;
  let observedInsideTransaction = true;
  pushService.dispatchForUser = async (_userId, notifications) => {
    observedInsideTransaction = transactionOpen;
    return { attempted: notifications.length, succeeded: notifications.length, failed: 0, deactivated: 0, skipped: 0 };
  };
  try {
    await CompraService.create(1, {
      compraHorario: new Date('2026-08-15T12:00:00Z'),
      compraClassificacao: 'PENDENTE',
      compraValor: 80,
    });
  } finally {
    pushService.dispatchForUser = originalDispatch;
  }
  assert.equal(observedInsideTransaction, false);
});

test('retry de compra confirmada não dispara push quando a notificação já existe', async () => {
  configureLimits(50, null, null);
  const originalDispatch = pushService.dispatchForUser;
  let dispatchCount = 0;
  pushService.dispatchForUser = async (_userId, notifications) => {
    dispatchCount += notifications.length;
    return { attempted: notifications.length, succeeded: notifications.length, failed: 0, deactivated: 0, skipped: 0 };
  };
  try {
    const created = await CompraService.create(1, {
      compraHorario: new Date('2026-08-15T12:00:00Z'),
      compraClassificacao: 'PENDENTE',
      compraValor: 80,
    });
    await CompraService.update(1, created.compra.compra_id, {
      compraHorario: new Date('2026-08-15T12:00:00Z'),
      compraClassificacao: 'PENDENTE',
      compraValor: 80,
    });
  } finally {
    pushService.dispatchForUser = originalDispatch;
  }
  assert.equal(dispatchCount, 1);
});

test('falha do push não desfaz compra nem notificação persistida', async () => {
  configureLimits(50, null, null);
  const originalDispatch = pushService.dispatchForUser;
  pushService.dispatchForUser = async () => {
    throw new Error('Expo unavailable');
  };
  try {
    await CompraService.create(1, {
      compraHorario: new Date('2026-08-15T12:00:00Z'),
      compraClassificacao: 'PENDENTE',
      compraValor: 80,
    });
  } finally {
    pushService.dispatchForUser = originalDispatch;
  }
  assert.equal(state.purchases.length, 1);
  assert.equal(state.notifications.length, 1);
});

test('compra Gmail pendente não chama push', async () => {
  configureLimits(50, null, null);
  const originalResolve = PaymentMethodResolver.resolve;
  const originalDispatch = pushService.dispatchForUser;
  let dispatchCount = 0;
  PaymentMethodResolver.resolve = async () => null;
  pushService.dispatchForUser = async () => {
    dispatchCount += 1;
    return { attempted: 0, succeeded: 0, failed: 0, deactivated: 0, skipped: 0 };
  };
  try {
    await createCompraFromMessage(1, {
      id: 'gmail-pending-push',
      from: 'Loja Teste <vendas@loja.test>',
      subject: 'Pedido recebido',
      bodyText: 'Produto: Produto Teste\nQuantidade: 1\nValor do produto: R$ 80,00\nTotal da compra: R$ 80,00',
      snippet: 'Pedido recebido',
      labelIds: [],
      internalDate: String(Date.parse('2026-08-15T12:00:00Z')),
    } as any);
  } finally {
    PaymentMethodResolver.resolve = originalResolve;
    pushService.dispatchForUser = originalDispatch;
  }
  assert.equal(dispatchCount, 0);
});

test('compra Gmail confirmada aguarda push depois da transação', async () => {
  configureLimits(50, null, null);
  const originalResolve = PaymentMethodResolver.resolve;
  const originalDispatch = pushService.dispatchForUser;
  let observedInsideTransaction = true;
  PaymentMethodResolver.resolve = async () => ({ id: 1, name: 'Pix' });
  pushService.dispatchForUser = async (_userId, notifications) => {
    observedInsideTransaction = transactionOpen;
    return { attempted: notifications.length, succeeded: notifications.length, failed: 0, deactivated: 0, skipped: 0 };
  };
  try {
    await createCompraFromMessage(1, {
      id: 'gmail-confirmed-push',
      from: 'Loja Teste <vendas@loja.test>',
      subject: 'Pedido confirmado',
      bodyText: 'Produto: Produto Teste\nQuantidade: 1\nValor do produto: R$ 80,00\nTotal da compra: R$ 80,00\nPix',
      snippet: 'Pedido confirmado',
      labelIds: [],
      internalDate: String(Date.parse('2026-08-15T12:00:00Z')),
    } as any);
  } finally {
    PaymentMethodResolver.resolve = originalResolve;
    pushService.dispatchForUser = originalDispatch;
  }
  assert.equal(observedInsideTransaction, false);
});

test('falha do push não desfaz confirmação manual', async () => {
  configureLimits(50, null, null);
  const current = addPurchase({ compra_valor: 80, compra_status: 'AGUARDANDO_CONFIRMACAO' });
  const originalDispatch = pushService.dispatchForUser;
  pushService.dispatchForUser = async () => {
    throw new Error('Expo unavailable');
  };
  try {
    await CompraService.confirm(1, current.compra_id);
  } finally {
    pushService.dispatchForUser = originalDispatch;
  }
  assert.equal(state.purchases[0].compra_status, 'CONFIRMADA');
  assert.equal(state.notifications.length, 1);
});

test('falha do push não faz o sync Gmail confirmado falhar', async () => {
  configureLimits(50, null, null);
  const originalResolve = PaymentMethodResolver.resolve;
  const originalDispatch = pushService.dispatchForUser;
  PaymentMethodResolver.resolve = async () => ({ id: 1, name: 'Pix' });
  pushService.dispatchForUser = async () => {
    throw new Error('Expo unavailable');
  };
  try {
    const result = await createCompraFromMessage(1, {
      id: 'gmail-confirmed-push-failure',
      from: 'Loja Teste <vendas@loja.test>',
      subject: 'Pedido confirmado',
      bodyText: 'Produto: Produto Teste\nQuantidade: 1\nValor do produto: R$ 80,00\nTotal da compra: R$ 80,00\nPix',
      snippet: 'Pedido confirmado',
      labelIds: [],
      internalDate: String(Date.parse('2026-08-15T12:00:00Z')),
    } as any);
    assert.equal('created' in result, true);
  } finally {
    PaymentMethodResolver.resolve = originalResolve;
    pushService.dispatchForUser = originalDispatch;
  }
  assert.equal(state.purchases[0].compra_status, 'CONFIRMADA');
  assert.equal(state.notifications.length, 1);
});

test('uma compra com alertas independentes envia somente candidatos novos ao push', async () => {
  configureLimits(50, 50, null);
  const originalDispatch = pushService.dispatchForUser;
  let pushedTypes: string[] = [];
  pushService.dispatchForUser = async (_userId, notifications) => {
    pushedTypes = notifications.map((notification) => String(notification.type));
    return { attempted: notifications.length, succeeded: notifications.length, failed: 0, deactivated: 0, skipped: 0 };
  };
  try {
    await CompraService.create(1, {
      compraHorario: new Date('2026-08-15T12:00:00Z'),
      compraClassificacao: 'PENDENTE',
      compraValor: 80,
      items: [{ categoriaId: 1, nome: 'Produto', valor: 80 }],
    });
  } finally {
    pushService.dispatchForUser = originalDispatch;
  }
  assert.deepEqual(pushedTypes.sort(), ['LIMITE_COMPRA', 'LIMITE_MENSAL']);
});
