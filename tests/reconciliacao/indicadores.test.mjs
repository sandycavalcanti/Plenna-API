import assert from 'node:assert/strict';
import { after, beforeEach, afterEach, mock, test } from 'node:test';

// Nunca usa o Neon: destino local inválido e todos os delegates utilizados são simulados.
process.env.DIRECT_URL = 'postgresql://localhost:1/reconciliacao_offline';
process.env.DATABASE_URL = process.env.DIRECT_URL;
const methods = ['findFirst', 'findUnique', 'findMany', 'groupBy', 'count', 'create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany'];
const client = Object.fromEntries(['tb_compra', 'tb_compra_item', 'tb_usuario', 'tb_metricas',
  'tb_tempo_uso', 'tb_categoria', 'tb_forma_pagamento', 'tb_compra_evento'].map((name) => [name,
  Object.fromEntries(methods.map((method) => [method, async () => { throw new Error('Consulta não simulada'); }]))]));
client.$queryRaw = async () => [];
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
    prisma.tb_metricas, prisma.tb_tempo_uso, prisma.tb_categoria, prisma.tb_forma_pagamento,
    prisma.tb_compra_evento]) {
    for (const method of methods) {
      mock.method(delegate, method, async () => { throw new Error(`Consulta não simulada: ${method}`); });
    }
  }
  mock.method(prisma.tb_compra_evento, 'findMany', async () => []);
  mock.method(prisma.tb_compra_evento, 'findFirst', async () => null);
  mock.method(prisma.tb_compra_evento, 'create', async ({ data }) => ({ evento_id: 1, ...data }));
  mock.method(prisma.tb_compra_item, 'updateMany', async () => ({ count: 0 }));
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

test('F08: categorias multiplicam preço unitário pela quantidade sem ratear descontos', async () => {
  const items = [
    { categoria_id: 1, compra_item_valor: 30, compra_item_quantidade: 3, tb_categoria: { categoria_nome: 'A' } },
    { categoria_id: 2, compra_item_valor: 20, compra_item_quantidade: null, tb_categoria: { categoria_nome: 'B' } },
  ];
  mock.method(prisma.tb_compra, 'findMany', async () => [{
    compra_horario: new Date('2026-11-02T12:00:00Z'), compra_valor: 100, compra_desconto: 10,
    compra_classificacao: 'PENDENTE', compra_acima_limite: null, tb_compra_item: items,
  }]);
  assert.deepEqual(await DashboardService.findGastosPorCategoria(7, '2026-11'), [
    { categoria_nome: 'A', total: 90 }, { categoria_nome: 'B', total: 20 },
  ]);
  const result = await DashboardService.analytics(7, { mode: 'month', month: '2026-11' });
  assert.equal(result.periodos[0].total_centavos, 10000);
  assert.deepEqual(result.periodos[0].categorias.map(c => c.total_centavos), [9000, 2000]);
});

test('F26: classificação conta compras sem valor sem inventar valores financeiros', async () => {
  mock.method(prisma,'$queryRaw',async query=>{
    assert.ok(query.values.includes(7));assert.match(query.text,/eventos_vigentes/);
    return [{periodo:'2026-11',compra_classificacao:'IMPULSIVA',quantidade:3,quantidade_com_valor:2,valor_total_centavos:3000}];
  });
  mock.method(prisma.tb_compra, 'findMany', async () => [null, 0, 30].map(compra_valor => ({
    compra_horario: new Date('2026-11-02T12:00:00Z'), compra_valor, compra_desconto: 0,
    compra_classificacao: 'IMPULSIVA', compra_acima_limite: null, tb_compra_item: [],
  })));
  const period = (await DashboardService.analytics(7, {mode:'month',month:'2026-11'})).periodos[0];
  assert.equal(period.quantidade_compras,3);assert.equal(period.quantidade_compras_com_valor,2);
  assert.equal(period.impulsividade[0].quantidade,3);
  assert.equal(period.impulsividade[0].valor_total_centavos,3000);
});

test('F08/F23: categoria não presume unidade para item importado sem quantidade', async () => {
  mock.method(prisma.tb_compra,'findMany',async()=>[{
    compra_horario:new Date('2026-11-02T12:00:00Z'),compra_valor:100,compra_email:true,
    compra_desconto:0,compra_classificacao:'PENDENTE',compra_acima_limite:null,
    tb_compra_item:[{categoria_id:1,compra_item_valor:20,compra_item_quantidade:null,tb_categoria:{categoria_nome:'A'}}],
  }]);
  assert.deepEqual(await DashboardService.findGastosPorCategoria(7,'2026-11'),[]);
  const period=(await DashboardService.analytics(7,{mode:'month',month:'2026-11'})).periodos[0];
  assert.deepEqual(period.categorias,[]);assert.equal(period.total_centavos,10000);
});

test('F02: Dashboard conta somente compras anteriores ao instante observado', async t => {
  const now = new Date('2026-11-03T12:00:00Z');
  t.mock.timers.enable({apis:['Date'],now});
  const purchases = ['2026-11-02T12:00:00Z','2026-11-04T12:00:00Z'].map(date => ({
    compra_horario:new Date(date),compra_valor:100,compra_desconto:0,compra_classificacao:'PENDENTE',
    compra_acima_limite:null,tb_compra_item:[],
  }));
  mock.method(prisma.tb_compra,'findMany',async ({where}) => {
    assert.equal(where.compra_horario.lt.toISOString(),now.toISOString());
    return purchases.filter(row=>row.compra_horario>=where.compra_horario.gte && row.compra_horario<where.compra_horario.lt);
  });
  const period=(await DashboardService.analytics(7,{mode:'month',month:'2026-11'})).periodos[0];
  assert.equal(period.quantidade_compras,1);assert.equal(period.total_centavos,10000);
});

test('null não entra na contagem de false, independentemente da ordem dos grupos', async () => {
  mock.method(prisma.tb_compra, 'groupBy', async () => [
    { compra_acima_limite: false, _count: { _all: 2 } },
    { compra_acima_limite: null, _count: { _all: 9 } },
    { compra_acima_limite: true, _count: { _all: 1 } },
  ]);
  assert.deepEqual(await DashboardService.findComprasAcimaLimite(7), { acima_limite: 1, dentro_limite: 2 });
});

test('classificações preservam contagem conhecida e incluem população completa sem fabricar soma', async () => {
  mock.method(prisma, '$queryRaw', async () => [
    { periodo:'2026-11',compra_classificacao:'IMPULSIVA',quantidade:3,quantidade_com_valor:2,valor_total_centavos:8000 },
    { periodo:'2026-11',compra_classificacao:'PENDENTE',quantidade:1,quantidade_com_valor:0,valor_total_centavos:null },
  ]);
  const result = await DashboardService.findImpulsividade(7);
  assert.deepEqual(result, [{ compra_classificacao: 'IMPULSIVA', quantidade: 2, quantidade_total: 3, quantidade_sem_valor: 1, valor_total: 80 }, { compra_classificacao: 'PENDENTE', quantidade: 0, quantidade_total: 1, quantidade_sem_valor: 1, valor_total: null }]);
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

test('F27: indicador derivado respeita supressão do monitoramento sem apagar registros', async () => {
  const original = { tempo_uso_nome: 'Shopee', tempo_uso_package_id: 'com.shopee.br',
    tempo_uso_inicio: new Date('2026-11-02T17:00:00Z'), tempo_uso_fim: new Date('2026-11-02T18:00:00Z'),
    tempo_uso_data_local: new Date('2026-11-02'), tempo_uso_data: new Date('2026-11-02T17:00:00Z'),
    tempo_uso_duracao_segundos: 420, tempo_uso_minutos: 7 };
  const deletion = { id: 'offline-deletion', accountId: 7, target: { kind: 'ACCOUNT' },
    scope: { kind: 'PERIOD', packageIds: ['com.shopee.br'], interval: {
      start: '2026-11-02T17:10:00Z', end: '2026-11-02T17:11:00Z' } } };
  mock.method(prisma, '$queryRaw', async sql => sql.join('').includes('to_regclass')
    ? [{ relation: 'public.rf017_authorization' }]
    : sql.join('').includes('rf017_tombstone') ? [{ document: deletion }] : [{ usuario_id: 7 }]);
  mock.method(prisma.tb_tempo_uso, 'findMany', async () => [original]);
  mock.method(prisma.tb_compra, 'groupBy', async () => [{ compra_fonte: 'Shopee',
    _sum: { compra_valor: 30 }, _count: { _all: 1, compra_valor: 1 } }]);
  assert.deepEqual(await DashboardService.findTempoVsGasto(7, '2026-11'), []);
  assert.equal(original.tempo_uso_duracao_segundos, 420);
});

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

for (const values of [[null]]) {
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
  mock.method(prisma.tb_compra_item, 'updateMany', async () => ({ count: 0 }));
  mock.method(prisma.tb_compra, 'update', async () => ({ compra_id: 10 }));
  assert.equal(await CompraService.delete(7, 10), undefined);
  assert.equal(prisma.tb_compra.update.mock.calls[0].arguments[0].data.compra_ativo,0);
  assert.equal(prisma.tb_compra_item.updateMany.mock.calls[0].arguments[0].data.compra_item_ativo,0);
  assert.equal(prisma.tb_compra.delete.mock.callCount(),0);
  assert.equal(prisma.tb_compra.update.mock.callCount(), 1);
  assert.equal(prisma.tb_metricas.create.mock.callCount(), 0);
});

test('listagem e detalhe selecionam somente campos públicos, incluindo nome da forma de pagamento', async () => {
  const expected = ['compra_id', 'usuario_id', 'forma_pagamento_id', 'compra_valor', 'compra_horario', 'compra_fonte', 'compra_email', 'compra_classificacao', 'compra_acima_limite', 'compra_usuario_concorda', 'compra_usuario_anotacao', 'compra_data_criacao', 'compra_status', 'compra_ativo', 'compra_desconto', 'tb_compra_item','tb_forma_pagamento'];
  const row = { compra_id: 10, compra_valor: null, forma_pagamento_id: null, tb_compra_item: [] };
  const verify = ({ select }) => {
    assert.deepEqual(Object.keys(select).sort(), expected.sort());
    assert.equal('compra_email_mensagem_id' in select,false);assert.equal('compra_pedido_externo_id' in select,false);
    assert.deepEqual(select.tb_forma_pagamento,{select:{forma_pagamento_nome:true}});
    assert.deepEqual(select.tb_compra_item.where,{compra_item_ativo:1});
    assert.equal('compra_item_quantidade' in select.tb_compra_item.select, true);
    assert.equal('compra_item_unidade_medida' in select.tb_compra_item.select, true);
    assert.deepEqual(Object.keys(select.tb_compra_item.select.tb_categoria.select).sort(), ['categoria_data_criacao', 'categoria_id', 'categoria_nome']);
    return row;
  };
  mock.method(prisma.tb_compra, 'findMany', async (args) => [verify(args)]);
  mock.method(prisma.tb_compra, 'findFirst', async (args) => verify(args));
  assert.deepEqual(await CompraService.findAllByUserId(7), [row]);
  assert.deepEqual(await CompraService.findById(7, 10), row);
});

test('empty known universe resets monthly metrics instead of retaining stale spending',async()=>{metricasFixture([], {metricas_id:9,metricas_media_gasto:500});const r=await MetricasService.recalculateMonthlyMetrics(7,new Date());assert.equal(Number(r.metricas_media_gasto),0);assert.equal(r.metricas_frequencia_compra,0);});
