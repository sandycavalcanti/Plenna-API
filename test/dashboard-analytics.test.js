import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

process.env.DIRECT_URL = 'postgresql://localhost:1/dashboard_analytics_offline';
process.env.DATABASE_URL = process.env.DIRECT_URL;

const client = {
  tb_compra: {
    findMany: async () => { throw new Error('Consulta não simulada'); },
  },
  $disconnect: async () => {},
};
globalThis.prismaRuntime = { client, pool: { end: async () => {} } };

const distRoot = process.env.PLENNA_TEST_DIST
  ? resolve(process.env.PLENNA_TEST_DIST)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const compiled = (relativePath) => pathToFileURL(resolve(distRoot, relativePath)).href;

const { prisma, disconnectPrisma } = await import(compiled('src/lib/prisma.js'));
const { DashboardService } = await import(compiled('src/modules/dashboard/dashboard.service.js'));
const { DashboardController } = await import(compiled('src/modules/dashboard/dashboard.controller.js'));
const { analyticsQuerySchema } = await import(compiled('src/modules/dashboard/dashboard.schemas.js'));

beforeEach(() => {
  mock.method(prisma.tb_compra, 'findMany', async () => []);
  mock.method(console, 'info', () => {});
});

afterEach(() => mock.restoreAll());
after(disconnectPrisma);

function purchase(date, value, discount, categories = [], options = {}) {
  return {
    compra_horario: new Date(date),
    compra_valor: value,
    compra_desconto: discount,
    compra_acima_limite: options.aboveLimit ?? null,
    compra_classificacao: options.classification ?? 'PENDENTE',
    tb_forma_pagamento: options.payment === undefined || options.payment === null
      ? null
      : { forma_pagamento_nome: options.payment },
    tb_compra_item: categories.map(({ id, name, value: itemValue }) => ({
      categoria_id: id,
      compra_item_valor: itemValue,
      tb_categoria: { categoria_nome: name },
    })),
  };
}

function responseDouble() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('mode=month agrega compra confirmada, desconto separado e categoria bruta', async () => {
  let query;
  mock.method(prisma.tb_compra, 'findMany', async (args) => {
    query = args;
    return [
      purchase('2026-10-01T02:59:59.999Z', 999, 0, [{ id: 1, name: 'Fora', value: 99 }]),
      purchase('2026-10-01T03:00:00.000Z', 130, 20, [
        { id: 1, name: 'Casa', value: 100 },
        { id: 1, name: 'Casa', value: 50 },
      ]),
      purchase('2026-10-31T12:00:00.000Z', null, 0, [{ id: 1, name: 'Casa', value: 25 }]),
    ];
  });

  const result = await DashboardService.analytics(17, { mode: 'month', month: '2026-10' });
  const period = result.periodos[0];

  assert.equal(query.where.usuario_id, 17);
  assert.equal(query.where.compra_status, 'CONFIRMADA');
  assert.equal(query.where.compra_ativo, 1);
  assert.deepEqual(query.where.compra_horario, {
    gte: new Date('2026-10-01T03:00:00.000Z'),
    lt: new Date('2026-11-01T03:00:00.000Z'),
  });
  assert.equal(result.timezone, 'America/Sao_Paulo');
  assert.equal(period.total_centavos, 13000);
  assert.equal(period.desconto_centavos, 2000);
  assert.equal(period.quantidade_compras, 2);
  assert.equal(period.quantidade_compras_com_valor, 1);
  assert.deepEqual(period.categorias, [{
    categoria_id: 1,
    categoria_nome: 'Casa',
    total_centavos: 17500,
    total: 175,
    quantidade_itens: 3,
  }]);
  assert.deepEqual(period.formas_pagamento, [{
    forma_pagamento_nome: 'Sem forma de pagamento',
    total_centavos: 13000,
    total: 130,
    quantidade_compras: 1,
  }]);
  assert.deepEqual(period.compras_acima_limite, { acima_limite: 0, dentro_limite: 0 });
  assert.deepEqual(period.impulsividade, [{
    compra_classificacao: 'PENDENTE',
    quantidade: 1,
    valor_total_centavos: 13000,
    valor_total: 130,
  }]);
});

test('analytics agrega pagamentos, limite e classificacao de impulsividade por periodo', async () => {
  mock.method(prisma.tb_compra, 'findMany', async () => [
    purchase('2026-10-05T12:00:00.000Z', 100, 10, [], {
      payment: 'Pix',
      aboveLimit: true,
      classification: 'IMPULSIVA',
    }),
    purchase('2026-10-06T12:00:00.000Z', 50, 0, [], {
      payment: null,
      aboveLimit: false,
      classification: 'NAO_IMPULSIVA',
    }),
    purchase('2026-10-07T12:00:00.000Z', null, 0, [], {
      payment: 'Cartao',
      aboveLimit: null,
      classification: 'IMPULSIVA',
    }),
  ]);

  const result = await DashboardService.analytics(17, { mode: 'month', month: '2026-10' });
  const period = result.periodos[0];

  assert.deepEqual(period.formas_pagamento, [
    {
      forma_pagamento_nome: 'Pix',
      total_centavos: 10000,
      total: 100,
      quantidade_compras: 1,
    },
    {
      forma_pagamento_nome: 'Sem forma de pagamento',
      total_centavos: 5000,
      total: 50,
      quantidade_compras: 1,
    },
  ]);
  assert.deepEqual(period.compras_acima_limite, { acima_limite: 1, dentro_limite: 1 });
  assert.deepEqual(period.impulsividade, [
    {
      compra_classificacao: 'IMPULSIVA',
      quantidade: 1,
      valor_total_centavos: 10000,
      valor_total: 100,
    },
    {
      compra_classificacao: 'NAO_IMPULSIVA',
      quantidade: 1,
      valor_total_centavos: 5000,
      valor_total: 50,
    },
  ]);
});

test('analytics exclui pendentes, ignoradas, inativas e compras de outro usuário pelo filtro Prisma', async () => {
  const rows = [
    { userId: 17, status: 'CONFIRMADA', active: 1, purchase: purchase('2026-10-10T12:00:00.000Z', 80, 0) },
    { userId: 17, status: 'AGUARDANDO_CONFIRMACAO', active: 1, purchase: purchase('2026-10-10T12:00:00.000Z', 90, 0) },
    { userId: 17, status: 'IGNORADA', active: 1, purchase: purchase('2026-10-10T12:00:00.000Z', 100, 0) },
    { userId: 17, status: 'CONFIRMADA', active: 0, purchase: purchase('2026-10-10T12:00:00.000Z', 110, 0) },
    { userId: 99, status: 'CONFIRMADA', active: 1, purchase: purchase('2026-10-10T12:00:00.000Z', 120, 0) },
  ];
  mock.method(prisma.tb_compra, 'findMany', async ({ where }) => {
    return rows
      .filter((row) => row.userId === where.usuario_id)
      .filter((row) => row.status === where.compra_status)
      .filter((row) => row.active === where.compra_ativo)
      .map((row) => row.purchase);
  });

  const result = await DashboardService.analytics(17, { mode: 'month', month: '2026-10' });

  assert.equal(result.periodos[0].quantidade_compras, 1);
  assert.equal(result.periodos[0].total, 80);
});

test('mode=evolution retorna 6 e 12 períodos, incluindo meses sem compras', async () => {
  let query;
  mock.method(prisma.tb_compra, 'findMany', async (args) => {
    query = args;
    return [];
  });

  const six = await DashboardService.analytics(17, { mode: 'evolution', months: 6, end: '2026-10' });
  assert.equal(six.periodos.length, 6);
  assert.deepEqual(six.periodos.map((period) => period.periodo), [
    '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
  ]);
  assert.ok(six.periodos.every((period) => (
    period.total_centavos === 0
    && period.categorias.length === 0
    && period.formas_pagamento.length === 0
    && period.impulsividade.length === 0
    && period.compras_acima_limite.acima_limite === 0
    && period.compras_acima_limite.dentro_limite === 0
  )));
  assert.deepEqual(query.where.compra_horario, {
    gte: new Date('2026-05-01T03:00:00.000Z'),
    lt: new Date('2026-11-01T03:00:00.000Z'),
  });

  const twelve = await DashboardService.analytics(17, { mode: 'evolution', months: 12, end: '2026-10' });
  assert.equal(twelve.periodos.length, 12);
  assert.equal(twelve.periodos[0].periodo, '2025-11');
  assert.equal(twelve.periodos.at(-1).periodo, '2026-10');
});

test('mode=compare calcula diferenças totais e por categoria, inclusive categoria nova', async () => {
  let query;
  mock.method(prisma.tb_compra, 'findMany', async (args) => {
    query = args;
    return [
      purchase('2026-09-15T12:00:00.000Z', 100, 0, [{ id: 1, name: 'Casa', value: 100 }]),
      purchase('2026-10-15T12:00:00.000Z', 150, 0, [
        { id: 1, name: 'Casa', value: 100 },
        { id: 2, name: 'Lazer', value: 50 },
      ]),
    ];
  });

  const result = await DashboardService.analytics(17, {
    mode: 'compare',
    monthA: '2026-09',
    monthB: '2026-10',
  });

  assert.equal(query.where.usuario_id, 17);
  assert.equal(query.where.compra_status, 'CONFIRMADA');
  assert.equal(query.where.compra_ativo, 1);
  assert.equal(query.where.compra_horario, undefined);
  assert.deepEqual(query.where.OR, [
    {
      compra_horario: {
        gte: new Date('2026-09-01T03:00:00.000Z'),
        lt: new Date('2026-10-01T03:00:00.000Z'),
      },
    },
    {
      compra_horario: {
        gte: new Date('2026-10-01T03:00:00.000Z'),
        lt: new Date('2026-11-01T03:00:00.000Z'),
      },
    },
  ]);
  assert.equal(result.comparacao.total.base, 10000);
  assert.equal(result.comparacao.total.comparado, 15000);
  assert.equal(result.comparacao.total.diferenca, 5000);
  assert.equal(result.comparacao.total.variacao_percentual, 50);
  assert.deepEqual(result.comparacao.categorias, [
    {
      categoria_id: 1,
      categoria_nome: 'Casa',
      base_total_centavos: 10000,
      comparado_total_centavos: 10000,
      diferenca_centavos: 0,
      base_total: 100,
      comparado_total: 100,
      diferenca: 0,
      variacao_percentual: 0,
    },
    {
      categoria_id: 2,
      categoria_nome: 'Lazer',
      base_total_centavos: 0,
      comparado_total_centavos: 5000,
      diferenca_centavos: 5000,
      base_total: 0,
      comparado_total: 50,
      diferenca: 50,
      variacao_percentual: null,
    },
  ]);
});

test('mode=compare retorna variação percentual null quando a base é zero', async () => {
  mock.method(prisma.tb_compra, 'findMany', async () => [
    purchase('2026-09-15T12:00:00.000Z', 50, 0, [{ id: 1, name: 'Casa', value: 50 }]),
  ]);

  const result = await DashboardService.analytics(17, {
    mode: 'compare',
    monthA: '2026-08',
    monthB: '2026-09',
  });

  assert.equal(result.comparacao.total.base, 0);
  assert.equal(result.comparacao.total.comparado, 5000);
  assert.equal(result.comparacao.total.variacao_percentual, null);
  assert.equal(result.comparacao.quantidade_compras.variacao_percentual, null);
});

test('entrada inválida é rejeitada e não permite mês futuro ou meses fora do contrato', () => {
  assert.equal(analyticsQuerySchema.safeParse({ mode: 'month', month: '2026-13' }).success, false);
  assert.equal(analyticsQuerySchema.safeParse({ mode: 'evolution', months: 3, end: '2026-10' }).success, false);
  assert.equal(analyticsQuerySchema.safeParse({ mode: 'compare', monthA: '2026-08', monthB: '2026-08' }).success, false);
});

test('controller exige usuário autenticado e usa o userId do request para ownership', async () => {
  const unauthorizedResponse = responseDouble();
  await DashboardController.analytics({ query: { mode: 'month', month: '2026-10' } }, unauthorizedResponse);
  assert.equal(unauthorizedResponse.statusCode, 401);

  let query;
  mock.method(prisma.tb_compra, 'findMany', async (args) => {
    query = args;
    return [];
  });
  const authorizedResponse = responseDouble();
  await DashboardController.analytics({
    userId: 73,
    query: { mode: 'month', month: '2026-10' },
  }, authorizedResponse);

  assert.equal(authorizedResponse.statusCode, 200);
  assert.equal(query.where.usuario_id, 73);
});

test('mode=compare consulta somente dois meses distantes, sem intervalo intermediario', async () => {
  let query;
  mock.method(prisma.tb_compra, 'findMany', async (args) => {
    query = args;
    return [
      purchase('2025-01-15T12:00:00.000Z', 100, 0),
      purchase('2026-10-15T12:00:00.000Z', 200, 0),
    ];
  });

  const result = await DashboardService.analytics(17, {
    mode: 'compare',
    monthA: '2025-01',
    monthB: '2026-10',
  });

  assert.equal(query.where.compra_horario, undefined);
  assert.deepEqual(query.where.OR, [
    {
      compra_horario: {
        gte: new Date('2025-01-01T03:00:00.000Z'),
        lt: new Date('2025-02-01T03:00:00.000Z'),
      },
    },
    {
      compra_horario: {
        gte: new Date('2026-10-01T03:00:00.000Z'),
        lt: new Date('2026-11-01T03:00:00.000Z'),
      },
    },
  ]);
  assert.deepEqual(result.periodos.map((period) => period.total_centavos), [10000, 20000]);
});

test('controller responde 400 para entrada de analytics invalida', async () => {
  const invalidResponse = responseDouble();
  await DashboardController.analytics({ userId: 73, query: { mode: 'month', month: '2026-13' } }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
});
