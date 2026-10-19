import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
// Imports application source only after environment/database isolation; no real Pool.
process.env.DOTENV_CONFIG_PATH = fileURLToPath(new URL('./.absent-offline-env', import.meta.url));
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost:1/offline', DIRECT_URL: 'postgresql://localhost:1/offline',
  GOOGLE_CLIENT_ID:'offline', GOOGLE_CLIENT_SECRET:'offline', GOOGLE_REDIRECT_URI:'https://example.invalid', JWT_SECRET:'offline-only' });
delete process.env.RF018_LOCAL; delete process.env.VERCEL;
let rows = [], metrics = [];
let user = { usuario_meta_valor_mensal: 200, usuario_meta_valor_compra: 80 };
const fake = {
  tb_usuario: { findFirst: async () => user },
  tb_compra: {
    findMany: async ({where}) => rows.filter(r => r.usuario_id === where.usuario_id && r.compra_ativo === where.compra_ativo &&
      r.compra_status === where.compra_status && r.compra_horario >= where.compra_horario.gte && r.compra_horario < where.compra_horario.lt),
    findFirst: async ({where}) => { const found=rows.find(r => r.compra_id === where.compra_id && (where.usuario_id === undefined || r.usuario_id === where.usuario_id) && (where.compra_ativo === undefined || r.compra_ativo === where.compra_ativo)); return found ? {...found,tb_usuario:user,tb_compra_item:[]} : null; },
    update: async ({where,data}) => Object.assign(rows.find(r=>r.compra_id===where.compra_id),data),
  },
  tb_notificacao: { findFirst: async () => ({notificacao_id:1}) },
  tb_compra_item: { updateMany: async () => ({count:0}) },
  tb_metricas: {
    findFirst: async ({where}) => metrics.find(m=>m.metricas_periodo_referencia.getTime()===where.metricas_periodo_referencia.getTime()),
    create: async ({data}) => { const m={metricas_id:metrics.length+1,...data}; metrics.push(m); return m; },
    update: async ({where,data}) => Object.assign(metrics.find(m=>m.metricas_id===where.metricas_id),data),
  }, $transaction: async cb => cb(fake), $disconnect: async () => {},
};
globalThis.prismaRuntime={client:fake,pool:{end:async()=>{}}};
const { DashboardService }=await import('../../src/modules/dashboard/dashboard.service.ts');
const { DashboardController }=await import('../../src/modules/dashboard/dashboard.controller.ts');
const { CompraService }=await import('../../src/modules/compra/compra.service.ts');
const { MetricasService }=await import('../../src/modules/compra/metricas.service.ts');
const {parseMonth,metricPeriods,summarizeValues}=await import('../../src/modules/compra/financeiro.ts');
const row=(overrides={})=>({compra_id:1,usuario_id:7,compra_ativo:1,compra_status:'CONFIRMADA',compra_horario:new Date('2026-10-15T12:00:00Z'),
  compra_valor:100,compra_desconto:20,compra_classificacao:'PENDENTE',forma_pagamento_id:null,compra_fonte:'Loja',tb_compra_item:[],...overrides});
test.beforeEach(()=>{rows=[];metrics=[];user={usuario_meta_valor_mensal:200,usuario_meta_valor_compra:80};});

test('atenção desativada fica indisponível sem alterar compras ou orçamento mensal', async () => {
 rows=[row({compra_acima_limite:true})];
 const before=structuredClone(rows);
 for(const value of [null,0]) {
  user.usuario_meta_valor_compra=value;
  const summary=await DashboardService.resumoMensal(7,'2026-10');
  assert.equal(summary.limitePorCompra,null);
  assert.equal(summary.comprasAcimaLimiteIndividual,null);
  assert.equal(summary.orcamentoMensal,200);
  assert.deepEqual(rows,before);
 }
});
test('1: confirmed active only, excluding pending ignored deleted and other user',async()=>{
 rows=[row(),row({compra_status:'AGUARDANDO_CONFIRMACAO',compra_valor:50}),row({compra_ativo:0,compra_valor:30}),row({compra_status:'IGNORADA'}),row({usuario_id:8})];
 const s=await DashboardService.resumoMensal(7,'2026-10'); assert.equal(s.total,100);assert.equal(s.comprasConfirmadas,1);
});
test('2: known plus null is partial with explicit coverage',async()=>{
 rows=[row(),row({compra_valor:null})];const s=await DashboardService.resumoMensal(7,'2026-10');
 assert.equal(s.qualidade,'PARCIAL');assert.equal(s.totalConhecido,100);assert.equal(s.comprasSemValor,1);assert.equal(s.estadoOrcamento,'INDETERMINADO');
});
test('3: unknown-only differs from no confirmed purchases',async()=>{
 rows=[row({compra_valor:null})];assert.equal((await DashboardService.resumoMensal(7,'2026-10')).total,null);
 rows=[];const s=await DashboardService.resumoMensal(7,'2026-10');assert.equal(s.total,0);assert.equal(s.qualidade,'SEM_COMPRAS');
});
test('known zero remains complete and in average denominator',()=>{
 const s=summarizeValues([null,0,100],200);assert.equal(s.comprasComValor,2);assert.equal(s.mediaConhecida,50);
 assert.equal(summarizeValues([0],200).qualidade,'COMPLETO');
});
test('4: net purchase value counted once despite discount',async()=>{
 rows=[row({compra_valor:100,compra_desconto:20})];assert.equal((await DashboardService.resumoMensal(7,'2026-10')).total,100);
});
test('5: actual soft delete of last purchase clears old financial aggregate transactionally',async()=>{
 rows=[row()];await MetricasService.recalculateMonthlyMetrics(7,rows[0].compra_horario,fake);
 await CompraService.delete(7,1);assert.equal(rows[0].compra_ativo,0);assert.equal(Number(metrics[0].metricas_media_gasto),0);
 assert.equal((await DashboardService.resumoMensal(7,'2026-10')).qualidade,'SEM_COMPRAS');
});
test('unknown values never return stale cache as monthly summary',async()=>{
 rows=[row({compra_valor:null})];metrics=[{metricas_id:1,metricas_media_gasto:999,metricas_periodo_referencia:new Date('2026-10-01Z')}];
 assert.equal((await DashboardService.resumoMensal(7,'2026-10')).total,null);
});
test('6: inclusive UTC start and exclusive next month, independent of creation date',async()=>{
 rows=[row({compra_horario:new Date('2026-10-01T00:00:00Z')}),row({compra_horario:new Date('2026-11-01T00:00:00Z')})];
 assert.equal((await DashboardService.resumoMensal(7,'2026-10')).comprasConfirmadas,1);
 assert.throws(()=>parseMonth('2026-13'));assert.throws(()=>parseMonth(['2026-10']));
});
test('7: actual update between December and January recalculates both months',async()=>{
 rows=[row({compra_horario:new Date('2026-12-31T23:00:00Z')})];
 await CompraService.update(7,1,{compraHorario:new Date('2027-01-01T00:00:00Z')});
 assert.equal(metrics.length,2);assert.deepEqual(metrics.map(m=>Number(m.metricas_media_gasto)),[0,100]);
 assert.equal(metricPeriods(new Date('2026-10-01Z'),new Date('2026-10-30Z')).length,1);
});
test('8: exact budget is reached not exceeded; partial lower bound is inconclusive',async()=>{
 rows=[row({compra_valor:200})];assert.equal((await DashboardService.resumoMensal(7,'2026-10')).estadoOrcamento,'ATINGIDO');
 rows=[row({compra_valor:201}),row({compra_valor:null})];assert.equal((await DashboardService.resumoMensal(7,'2026-10')).estadoOrcamento,'EXCEDIDO');
});
test('9: individual limit independent from aggregate monthly budget and absent budget',async()=>{
 rows=[row(),row({compra_id:2})];const s=await DashboardService.resumoMensal(7,'2026-10');
 assert.equal(s.comprasAcimaLimiteIndividual,2);assert.equal(s.estadoOrcamento,'ATINGIDO');
 await MetricasService.recalculateMonthlyMetrics(7,rows[0].compra_horario,fake);assert.equal(metrics[0].metricas_acima_limite,false);
 user.usuario_meta_valor_mensal=null;assert.equal((await DashboardService.resumoMensal(7,'2026-10')).estadoOrcamento,'SEM_ORCAMENTO');
});
test('10: controller failure is HTTP error never an empty successful financial summary',async()=>{
 const original=fake.tb_compra.findMany;fake.tb_compra.findMany=async()=>{throw new Error('offline failure');};
 try {let status=200,body;const res={status(code){status=code;return this;},json(value){body=value;return this;}};
 await DashboardController.resumoMensal({userId:7,query:{periodo:'2026-10'}},res);assert.equal(status,500);assert.equal(body.qualidade,undefined);
 }finally{fake.tb_compra.findMany=original;}
});

test('dashboard descriptive queries use the selected UTC month and user before querying', async()=>{
 const calls=[];const originalFind=fake.tb_compra.findMany;
 fake.tb_compra.findMany=async args=>{calls.push(args.where);return [];};
 fake.tb_compra.groupBy=async args=>{calls.push(args.where);return [];};
 fake.tb_tempo_uso={findMany:async()=>[]};
 try {
 for(const method of ['findGastosPorCategoria','findGastosPorFormaPagamento','findImpulsividade','findComprasAcimaLimite','findTempoVsGasto']) await DashboardService[method](7,'2025-12');
 assert.equal(calls.length,5);
 for(const where of calls){assert.equal(where.usuario_id,7);assert.equal(where.compra_ativo,1);assert.equal(where.compra_status,'CONFIRMADA');assert.equal(where.compra_horario.gte.toISOString(),'2025-12-01T00:00:00.000Z');assert.equal(where.compra_horario.lt.toISOString(),'2026-01-01T00:00:00.000Z');}
 for(const method of ['findGastosPorCategoria','findGastosPorFormaPagamento','findImpulsividade','findComprasAcimaLimite','findTempoVsGasto']) await assert.rejects(()=>DashboardService[method](7,'2026-13'));
 assert.equal(calls.length,5);
 }finally{fake.tb_compra.findMany=originalFind;delete fake.tb_compra.groupBy;delete fake.tb_tempo_uso;}
});
