import assert from 'node:assert/strict';
import { after, beforeEach, afterEach, mock, test } from 'node:test';

// Nunca usa o Neon: destino local inválido e todos os delegates utilizados são simulados.
process.env.DIRECT_URL = 'postgresql://localhost:1/reconciliacao_offline';
process.env.DATABASE_URL = process.env.DIRECT_URL;
const methods = ['findFirst', 'findUnique', 'findMany', 'groupBy', 'count', 'create', 'createMany', 'update', 'delete', 'deleteMany'];
const client = Object.fromEntries(['tb_compra', 'tb_compra_item', 'tb_usuario', 'tb_metricas',
  'tb_tempo_uso', 'tb_categoria', 'tb_forma_pagamento'].map((name) => [name,
  Object.fromEntries(methods.map((method) => [method, async () => { throw new Error('Consulta não simulada'); }]))]));
client.$transaction = async (callback) => callback(client);
client.$disconnect = async () => {};
// Injeta o runtime em memória antes dos imports. Nenhum Pool real é criado.
globalThis.prismaRuntime = { client, pool: { end: async () => {} } };
const { prisma, disconnectPrisma } = await import('../../src/lib/prisma.ts');
const { DashboardService } = await import('../../src/modules/dashboard/dashboard.service.ts');
const { MetricasService } = await import('../../src/modules/compra/metricas.service.ts');
const { CompraService } = await import('../../src/modules/compra/compra.service.ts');
const responses = await import('../../src/modules/dashboard/dashboard.schemas.ts');

beforeEach(() => {
  for (const delegate of [prisma.tb_compra, prisma.tb_compra_item, prisma.tb_usuario,
    prisma.tb_metricas, prisma.tb_tempo_uso, prisma.tb_categoria, prisma.tb_forma_pagamento]) {
    for (const method of methods) {
      mock.method(delegate, method, async () => { throw new Error(`Consulta não simulada: ${method}`); });
    }
  }
  mock.method(prisma, '$transaction', async (callback) => callback(prisma));
  mock.method(console, 'info', () => {});
});
afterEach(() => mock.restoreAll());
after(disconnectPrisma);

test('categoria exige valor da compra e todas as categorias, sem inventar agrupamentos', async () => {
  mock.method(prisma.tb_compra, 'findMany', async () => [
    { compra_valor: null, tb_compra_item: [{ compra_item_valor: 40, tb_categoria: { categoria_nome: 'A' } }] },
    { compra_valor: 90, tb_compra_item: [{ compra_item_valor: 90, tb_categoria: null }] },
    { compra_valor: 100, tb_compra_item: [{ compra_item_valor: 60, tb_categoria: { categoria_nome: 'A' } }, { compra_item_valor: 40, tb_categoria: { categoria_nome: 'B' } }] },
  ]);
  const result = await DashboardService.findGastosPorCategoria(7);
  assert.deepEqual(result, [{ categoria_nome: 'A', total: 60 }, { categoria_nome: 'B', total: 40 }]);
  assert.equal(responses.gastosCategoriaResponseSchema.safeParse(result).success, true);
  assert.deepEqual(console.info.mock.calls[0].arguments[1], { indicador: 'gastos_categoria', quantidade: 2 });
});

test('pagamento ignora valor ou relação ausente e mantém zero explicitamente conhecido', async () => {
  const pix = { forma_pagamento_nome: 'Pix' };
  mock.method(prisma.tb_compra, 'findMany', async () => [
    { compra_valor: null, tb_forma_pagamento: pix },
    { compra_valor: 70, tb_forma_pagamento: null },
    { compra_valor: 0, tb_forma_pagamento: pix },
    { compra_valor: 30, tb_forma_pagamento: pix },
  ]);
  const result = await DashboardService.findGastosPorFormaPagamento(7);
  assert.deepEqual(result, [{ forma_pagamento_nome: 'Pix', total: 30 }]);
  assert.equal(responses.gastosFormaPagamentoResponseSchema.safeParse(result).success, true);
});

test('null não entra na contagem de false, independentemente da ordem dos grupos', async () => {
  mock.method(prisma.tb_compra, 'groupBy', async () => [
    { compra_acima_limite: false, _count: { _all: 2 } },
    { compra_acima_limite: null, _count: { _all: 9 } },
    { compra_acima_limite: true, _count: { _all: 1 } },
  ]);
  assert.deepEqual(await DashboardService.findComprasAcimaLimite(7), { acima_limite: 1, dentro_limite: 2 });
});

test('impulsividade usa contagem de valores conhecidos e não fabrica soma para grupo nulo', async () => {
  mock.method(prisma.tb_compra, 'groupBy', async () => [
    { compra_classificacao: 'IMPULSIVA', _count: { _all: 3, compra_valor: 2 }, _sum: { compra_valor: 80 } },
    { compra_classificacao: 'PENDENTE', _count: { _all: 1, compra_valor: 0 }, _sum: { compra_valor: null } },
  ]);
  const result = await DashboardService.findImpulsividade(7);
  assert.deepEqual(result, [{ compra_classificacao: 'IMPULSIVA', quantidade: 2, valor_total: 80 }]);
  assert.equal(responses.impulsividadeResponseSchema.safeParse(result).success, true);
});

test('fonte exige nome e valor; par sem gasto conhecido não recebe zero fictício', async () => {
  mock.method(prisma.tb_tempo_uso, 'findMany', async () => [
    { tempo_uso_nome: 'Loja A', tempo_uso_minutos: null, tempo_uso_duracao_segundos: 600 },
    { tempo_uso_nome: 'Loja B', tempo_uso_minutos: 20, tempo_uso_duracao_segundos: null },
  ]);
  mock.method(prisma.tb_compra, 'groupBy', async () => [
    { compra_fonte: 'Loja A', _sum: { compra_valor: 30 }, _count: { _all: 2, compra_valor: 1 } },
    { compra_fonte: 'Loja B', _sum: { compra_valor: null }, _count: { _all: 1, compra_valor: 0 } },
    { compra_fonte: null, _sum: { compra_valor: 90 }, _count: { _all: 1, compra_valor: 1 } },
  ]);
  const result = await DashboardService.findTempoVsGasto(7);
  assert.deepEqual(result, [{ app: 'Loja A', tempo_total: 10, gasto_total: 30 }]);
  assert.equal(responses.tempoVsGastoResponseSchema.safeParse(result).success, true);
});

function metricasFixture(values, existing = null) {
  mock.method(prisma.tb_usuario, 'findFirst', async () => ({ usuario_meta_valor_mensal: 200 }));
  mock.method(prisma.tb_compra, 'findMany', async () => values.map((compra_valor) => ({ compra_valor })));
  mock.method(prisma.tb_metricas, 'findFirst', async () => existing);
  mock.method(prisma.tb_metricas, 'create', async ({ data }) => data);
  mock.method(prisma.tb_metricas, 'update', async ({ data }) => data);
}

test('métricas: [null, 100, 200] resulta em soma 300 e média 150', async () => {
  metricasFixture([null, 100, 200]);
  const result = await MetricasService.recalculateMonthlyMetrics(7, new Date());
  assert.equal(Number(result.metricas_media_gasto), 300);
  assert.equal(Number(result.metricas_media_valor_compra), 150);
  assert.equal(result.metricas_frequencia_compra, 2);
});

test('métricas preservam valor zero conhecido no denominador', async () => {
  metricasFixture([null, 0, 100]);
  const result = await MetricasService.recalculateMonthlyMetrics(7, new Date());
  assert.equal(Number(result.metricas_media_valor_compra), 50);
  assert.equal(result.metricas_frequencia_compra, 2);
});

for (const values of [[], [null]]) {
  test(`sem valores conhecidos (${values.length} compras): retorna null e não sobrescreve métrica antiga`, async () => {
    metricasFixture(values, { metricas_id: 9, metricas_media_gasto: 500 });
    assert.equal(await MetricasService.recalculateMonthlyMetrics(7, new Date()), null);
    assert.equal(prisma.tb_metricas.create.mock.callCount(), 0);
    assert.equal(prisma.tb_metricas.update.mock.callCount(), 0);
  });
}

test('CRUD delete conclui quando o mês restante só possui valor desconhecido', async () => {
  metricasFixture([null]);
  mock.method(prisma.tb_compra, 'findFirst', async () => ({ compra_id: 10, compra_horario: new Date() }));
  mock.method(prisma.tb_compra_item, 'deleteMany', async () => ({ count: 0 }));
  mock.method(prisma.tb_compra, 'delete', async () => ({ compra_id: 10 }));
  assert.deepEqual(await CompraService.delete(7, 10), { metricas: null });
  assert.equal(prisma.tb_compra.delete.mock.callCount(), 1);
  assert.equal(prisma.tb_metricas.create.mock.callCount(), 0);
});

test('listagem e detalhe selecionam somente os campos públicos anteriores', async () => {
  const expected = ['compra_id', 'usuario_id', 'forma_pagamento_id', 'compra_valor', 'compra_horario', 'compra_fonte', 'compra_email', 'compra_classificacao', 'compra_acima_limite', 'compra_usuario_concorda', 'compra_usuario_anotacao', 'compra_data_criacao', 'tb_compra_item'];
  const row = { compra_id: 10, compra_valor: null, forma_pagamento_id: null, tb_compra_item: [] };
  const verify = ({ select }) => {
    assert.deepEqual(Object.keys(select).sort(), expected.sort());
    assert.equal('compra_item_quantidade' in select.tb_compra_item.select, false);
    assert.equal('compra_item_unidade_medida' in select.tb_compra_item.select, false);
    assert.deepEqual(Object.keys(select.tb_compra_item.select.tb_categoria.select).sort(), ['categoria_data_criacao', 'categoria_id', 'categoria_nome']);
    return row;
  };
  mock.method(prisma.tb_compra, 'findMany', async (args) => [verify(args)]);
  mock.method(prisma.tb_compra, 'findFirst', async (args) => verify(args));
  assert.deepEqual(await CompraService.findAllByUserId(7), [row]);
  assert.deepEqual(await CompraService.findById(7, 10), row);
});
