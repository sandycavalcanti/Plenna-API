import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// O baseline usa apenas delegates simulados. A porta 1 impede qualquer conexão
// acidental com um banco real durante a caracterização.
process.env.DIRECT_URL = 'postgresql://localhost:1/financial_baseline_offline';
process.env.DATABASE_URL = process.env.DIRECT_URL;

const delegateNames = [
  'tb_compra',
  'tb_compra_item',
  'tb_usuario',
  'tb_metricas',
  'tb_preferencia',
  'tb_notificacao',
  'tb_categoria',
  'tb_forma_pagamento',
  'tb_tempo_uso',
];
const methods = [
  'findFirst',
  'findUnique',
  'findMany',
  'groupBy',
  'count',
  'create',
  'createMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
];

const client = Object.fromEntries(delegateNames.map((name) => [
  name,
  Object.fromEntries(methods.map((method) => [
    method,
    async () => { throw new Error(`Consulta não simulada: ${name}.${method}`); },
  ])),
]));
client.$transaction = async (callback) => callback(client);
client.$disconnect = async () => {};
globalThis.prismaRuntime = { client, pool: { end: async () => {} } };

const distRoot = process.env.PLENNA_TEST_DIST
  ? resolve(process.env.PLENNA_TEST_DIST)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const compiled = (relativePath) => pathToFileURL(resolve(distRoot, relativePath)).href;

const { prisma, disconnectPrisma } = await import(compiled('src/lib/prisma.js'));
const { DashboardService } = await import(compiled('src/modules/dashboard/dashboard.service.js'));
const { MetricasService, getMonthBounds } = await import(compiled('src/modules/compra/metricas.service.js'));
const {
  CompraService,
} = await import(compiled('src/modules/compra/compra.service.js'));
const {
  calculatePurchaseAboveLimit,
  evaluateConfirmedPurchaseLimits,
  itemTotalCents,
} = await import(compiled('src/modules/compra/limite.service.js'));

beforeEach(() => {
  for (const delegateName of delegateNames) {
    const delegate = prisma[delegateName];
    for (const method of methods) {
      mock.method(delegate, method, async () => {
        throw new Error(`Consulta não simulada: ${delegateName}.${method}`);
      });
    }
  }
  mock.method(prisma, '$transaction', async (callback) => callback(prisma));
  mock.method(console, 'info', () => {});
});

afterEach(() => mock.restoreAll());
after(disconnectPrisma);

test('baseline: dashboard filtra usuário, CONFIRMADA, ativa e mês UTC semiaberto', async () => {
  let query;
  let select;
  mock.method(prisma.tb_compra, 'findMany', async (args) => {
    query = args.where;
    select = args.select;
    return [];
  });

  await DashboardService.findGastosPorCategoria(42);

  const { start, end } = getMonthBounds(new Date());
  assert.equal(query.usuario_id, 42);
  assert.equal(query.compra_ativo, 1);
  assert.equal(query.compra_status, 'CONFIRMADA');
  assert.deepEqual(query.compra_horario, { gte: start, lt: end });
  assert.equal('compra_item_quantidade' in select.tb_compra_item.select, false);
  assert.equal('compra_desconto' in select, false);
});

test('baseline: categoria usa valor bruto dos itens, enquanto pagamento usa total líquido da compra', async () => {
  mock.method(prisma.tb_compra, 'findMany', async ({ select }) => {
    if (select.tb_compra_item) {
      return [{
        compra_valor: 130,
        compra_desconto: 20,
        tb_compra_item: [
          { compra_item_valor: 100, compra_item_quantidade: 1, tb_categoria: { categoria_nome: 'Casa' } },
          { compra_item_valor: 50, compra_item_quantidade: 1, tb_categoria: { categoria_nome: 'Casa' } },
        ],
      }];
    }

    return [{
      compra_valor: 130,
      tb_forma_pagamento: { forma_pagamento_nome: 'Pix' },
    }];
  });

  const category = await DashboardService.findGastosPorCategoria(42);
  const payment = await DashboardService.findGastosPorFormaPagamento(42);

  // Comportamento atual: categoria = bruto dos itens; pagamento = compra líquida.
  assert.deepEqual(category, [{ categoria_nome: 'Casa', total: 150 }]);
  assert.deepEqual(payment, [{ forma_pagamento_nome: 'Pix', total: 130 }]);
});

test('baseline: quantidade só participa dos limites, não do indicador atual por categoria', async () => {
  let categorySelect;
  mock.method(prisma.tb_compra, 'findMany', async ({ select }) => {
    categorySelect = select;
    return [{
      compra_valor: 75,
      compra_desconto: 0,
      tb_compra_item: [{
        compra_item_valor: 25,
        compra_item_quantidade: 3,
        tb_categoria: { categoria_nome: 'Mercado' },
      }],
    }];
  });

  const result = await DashboardService.findGastosPorCategoria(7);

  assert.deepEqual(result, [{ categoria_nome: 'Mercado', total: 25 }]);
  assert.equal('compra_item_quantidade' in categorySelect.tb_compra_item.select, false);
  assert.equal(itemTotalCents(25, 3), 7500);
  assert.equal(itemTotalCents(25, null), 2500);
  assert.equal(itemTotalCents(25, 0), null);
});

test('baseline: métricas ignoram valores nulos, preservam zero e usam mês UTC', async () => {
  let purchaseWhere;
  mock.method(prisma.tb_usuario, 'findFirst', async () => ({ usuario_meta_valor_mensal: 200 }));
  mock.method(prisma.tb_compra, 'findMany', async ({ where }) => {
    purchaseWhere = where;
    return [{ compra_valor: null }, { compra_valor: 0 }, { compra_valor: 100 }];
  });
  mock.method(prisma.tb_metricas, 'findFirst', async () => null);
  mock.method(prisma.tb_metricas, 'create', async ({ data }) => data);

  const reference = new Date('2026-10-01T00:30:00.000Z');
  const result = await MetricasService.recalculateMonthlyMetrics(7, reference);
  const { start, end } = getMonthBounds(reference);

  assert.deepEqual(purchaseWhere.compra_horario, { gte: start, lt: end });
  assert.equal(purchaseWhere.usuario_id, 7);
  assert.equal(purchaseWhere.compra_ativo, 1);
  assert.equal(purchaseWhere.compra_status, 'CONFIRMADA');
  assert.equal(Number(result.metricas_media_gasto), 100);
  assert.equal(Number(result.metricas_media_valor_compra), 50);
  assert.equal(result.metricas_frequencia_compra, 2);
  assert.equal(result.metricas_acima_limite, false);
});

test('baseline: limites distinguem valor da compra, total de categoria por quantidade e total mensal', async () => {
  const reference = new Date('2026-10-15T12:00:00.000Z');
  let monthlyWhere;
  const purchase = {
    compra_id: 10,
    usuario_id: 7,
    compra_valor: 100,
    compra_horario: reference,
    compra_acima_limite: null,
    tb_usuario: {
      usuario_meta_valor_compra: 90,
      usuario_meta_valor_mensal: 150,
    },
    tb_compra_item: [{
      categoria_id: 3,
      compra_item_valor: 25,
      compra_item_quantidade: 3,
      tb_categoria: { categoria_nome: 'Casa' },
    }],
  };

  mock.method(prisma.tb_compra, 'findFirst', async () => purchase);
  mock.method(prisma.tb_compra, 'update', async ({ data }) => ({ ...purchase, ...data }));
  mock.method(prisma.tb_compra, 'findMany', async ({ where }) => {
    monthlyWhere = where;
    return [{
      compra_valor: 160,
      tb_compra_item: [{
        categoria_id: 3,
        compra_item_valor: 25,
        compra_item_quantidade: 3,
      }],
    }];
  });
  mock.method(prisma.tb_preferencia, 'findMany', async () => [{ categoria_id: 3, preferencia_meta: 50 }]);
  mock.method(prisma.tb_notificacao, 'findFirst', async () => ({ notificacao_id: 99 }));

  const result = await evaluateConfirmedPurchaseLimits(10);
  const { start, end } = getMonthBounds(reference);

  assert.equal(calculatePurchaseAboveLimit(100, 90), true);
  assert.equal(calculatePurchaseAboveLimit(100, 100), false);
  assert.equal(result.purchaseAboveLimit, true);
  assert.equal(result.monthlyTotalCents, 16000);
  assert.equal(result.monthlyExceeded, true);
  assert.deepEqual(result.categoryTotals, [{
    categoriaId: 3,
    categoriaNome: 'Casa',
    totalCents: 7500,
    monthlyTotalCents: 7500,
    limitCents: 5000,
  }]);
  assert.deepEqual(result.violations, [
    { type: 'LIMITE_COMPRA', categoryId: null },
    { type: 'LIMITE_CATEGORIA', categoryId: 3 },
    { type: 'LIMITE_MENSAL', categoryId: null },
  ]);
  assert.equal(monthlyWhere.usuario_id, 7);
  assert.equal(monthlyWhere.compra_ativo, 1);
  assert.equal(monthlyWhere.compra_status, 'CONFIRMADA');
  assert.deepEqual(monthlyWhere.compra_horario, { gte: start, lt: end });
});

test('baseline: cadastro manual com múltiplos itens soma linhas, confirma e não persiste quantidade', async () => {
  const reference = new Date('2026-10-15T12:00:00.000Z');
  let createData;
  let itemData;
  const purchase = {
    compra_id: 50,
    usuario_id: 7,
    compra_valor: 75,
    compra_horario: reference,
    compra_status: 'CONFIRMADA',
    compra_ativo: 1,
    compra_acima_limite: null,
    compra_desconto: 0,
    tb_usuario: { usuario_meta_valor_compra: null, usuario_meta_valor_mensal: null },
    tb_compra_item: [],
  };

  mock.method(prisma.tb_usuario, 'findFirst', async () => ({
    usuario_id: 7,
    usuario_meta_valor_mensal: null,
  }));
  mock.method(prisma.tb_categoria, 'count', async () => 2);
  mock.method(prisma.tb_compra, 'create', async ({ data }) => {
    createData = data;
    return purchase;
  });
  mock.method(prisma.tb_compra_item, 'createMany', async ({ data }) => {
    itemData = data;
    purchase.tb_compra_item = data.map((item, index) => ({
      ...item,
      compra_item_id: index + 1,
      tb_categoria: { categoria_nome: `Categoria ${index + 1}` },
    }));
    return { count: data.length };
  });
  mock.method(prisma.tb_compra, 'findFirst', async () => purchase);
  mock.method(prisma.tb_compra, 'findMany', async () => [{
    compra_valor: purchase.compra_valor,
    tb_compra_item: purchase.tb_compra_item,
  }]);
  mock.method(prisma.tb_preferencia, 'findMany', async () => []);
  mock.method(prisma.tb_metricas, 'findFirst', async () => null);
  mock.method(prisma.tb_metricas, 'create', async ({ data }) => data);

  const result = await CompraService.create(7, {
    compraHorario: reference,
    compraClassificacao: 'NAO_IMPULSIVA',
    items: [
      { categoriaId: 1, nome: 'Item 1', valor: 25 },
      { categoriaId: 2, nome: 'Item 2', valor: 50 },
    ],
  });

  assert.equal(Number(result.compra.compra_valor), 75);
  assert.equal(createData.compra_status, 'CONFIRMADA');
  assert.equal(Number(createData.compra_desconto), 0);
  assert.equal(itemData.length, 2);
  assert.equal('compra_item_quantidade' in itemData[0], false);
  assert.equal('compra_item_unidade_medida' in itemData[0], false);
});

test('baseline: exclusão usa ownership e inativa compra e itens sem apagar registros', async () => {
  const excludedPurchase = {
    compra_id: 80,
    usuario_id: 7,
    compra_horario: new Date('2026-10-15T12:00:00.000Z'),
    compra_status: 'AGUARDANDO_CONFIRMACAO',
  };
  let itemDelete;
  let purchaseDelete;
  mock.method(prisma.tb_compra, 'findFirst', async ({ where }) => (
    where.usuario_id === 7 ? excludedPurchase : null
  ));
  mock.method(prisma.tb_compra_item, 'updateMany', async ({ where, data }) => {
    itemDelete = { where, data };
    return { count: 2 };
  });
  mock.method(prisma.tb_compra, 'update', async ({ where, data }) => {
    purchaseDelete = { where, data };
    return { ...excludedPurchase, ...data };
  });

  await CompraService.delete(7, 80);
  await assert.rejects(() => CompraService.delete(8, 80), /Compra não encontrada/);

  assert.deepEqual(itemDelete.where, { compra_id: 80, compra_item_ativo: 1 });
  assert.equal(itemDelete.data.compra_item_ativo, 0);
  assert.ok(itemDelete.data.compra_item_excluido_em instanceof Date);
  assert.deepEqual(purchaseDelete.where, { compra_id: 80 });
  assert.equal(purchaseDelete.data.compra_ativo, 0);
  assert.ok(purchaseDelete.data.compra_excluido_em instanceof Date);
});
