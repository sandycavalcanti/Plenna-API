import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
process.env.DOTENV_CONFIG_PATH = fileURLToPath(new URL('./.absent', import.meta.url));
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost:1/offline', DIRECT_URL: 'postgresql://localhost:1/offline', JWT_SECRET: 'offline-home-only' });
delete process.env.RF018_LOCAL; delete process.env.VERCEL;
Object.assign(process.env, { GOOGLE_CLIENT_ID: 'offline', GOOGLE_CLIENT_SECRET: 'offline', GOOGLE_REDIRECT_URI: 'https://example.invalid' });
let rows, created, budget, active, fail, queries, transactions;
const now = new Date('2026-10-12T12:00:00Z');
const fake = {
  tb_usuario: { findFirst: async ({where, select}) => !active ? null : select.usuario_id ? {usuario_id: where.usuario_id} : select.usuario_data_criacao ? {usuario_data_criacao: created} : {usuario_meta_valor_compra: 100, usuario_meta_valor_mensal: budget} },
  tb_compra: {
    findFirst: async ({where}) => { queries.push(where); return rows.filter(r => r.usuario_id === where.usuario_id && r.compra_ativo === 1 && r.compra_status === 'CONFIRMADA' && r.compra_horario < where.compra_horario.lt).sort((a,b)=>a.compra_horario-b.compra_horario)[0] ?? null; },
    findMany: async ({where}) => { queries.push(where); if(fail) throw new Error('private-db-secret'); return rows.filter(r=>r.usuario_id===where.usuario_id && r.compra_ativo===1 && r.compra_status==='CONFIRMADA' && r.compra_horario>=where.compra_horario.gte && r.compra_horario<where.compra_horario.lt); }
  },
  $transaction: async (cb, options) => { transactions.push(options); return cb(fake); }
};
globalThis.prismaRuntime = {client: fake, pool: {end: async()=>{}}};
const {HomeService} = await import('../../src/modules/home/home.service.ts');
const {homeRouter} = await import('../../src/modules/home/home.routes.ts');
let server, base;
test.before(async()=>{const app=express();app.use('/home',homeRouter);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/home/resumo`;});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
test.beforeEach(()=>{rows=[];created=new Date('2026-09-02Z');budget=200;active=true;fail=false;queries=[];transactions=[];});
const row=(extra={})=>({compra_id:1,usuario_id:1,compra_ativo:1,compra_status:'CONFIRMADA',compra_horario:new Date('2026-10-05Z'),compra_valor:230,compra_email:false,tb_compra_item:[],...extra});
const read=(period='2026-10')=>HomeService.consultar(1,period,now);
const request=(query='?periodo=2026-10', token=jwt.sign({userId:1},process.env.JWT_SECRET,{expiresIn:'5m'}))=>fetch(base+query,{headers:token?{Authorization:`Bearer ${token}`}:{}});
test('empty registered universe preserves zero and unknown coverage',async()=>{const b=await read();assert.equal(b.financeiro.qualidade,'SEM_COMPRAS');assert.equal(b.financeiro.totalCentavos,0);assert.equal(b.orcamento.percentualConhecido,0);assert.equal(b.orcamento.estadoUtilizacao,'NEUTRO');assert.equal(b.financeiro.cobertura,'DESCONHECIDA');});
test('current reference excess is known without claiming historic validity',async()=>{rows=[row()];const b=await read();assert.equal(b.orcamento.percentualConhecido,115);assert.equal(b.orcamento.excessoConhecidoCentavos,3000);assert.equal(b.orcamento.estadoUtilizacao,'VERMELHO');assert.equal(b.orcamento.vigencia,'ATUAL_SEM_HISTORICO');});
test('historic budget absent even when current budget is known',async()=>{rows=[row({compra_horario:new Date('2026-09-05Z')})];const b=await read('2026-09');assert.equal(b.financeiro.totalCentavos,23000);for(const key of ['valorCentavos','percentualConhecido','excessoConhecidoCentavos'])assert.equal(b.orcamento[key],null);assert.equal(b.orcamento.estadoUtilizacao,'NEUTRO');});
test('unknown is not zero',async()=>{rows=[row({compra_valor:null})];const b=await read();assert.equal(b.financeiro.totalCentavos,null);assert.equal(b.financeiro.comprasSemValor,1);assert.equal(b.orcamento.percentualConhecido,null);});
test('partial known lower bound can exceed budget',async()=>{rows=[row(),row({compra_id:2,compra_valor:null})];const b=await read();assert.equal(b.financeiro.qualidade,'PARCIAL');assert.equal(b.orcamento.estadoUtilizacao,'VERMELHO');});
test('partial below budget uses known utilization color',async()=>{rows=[row({compra_valor:50}),row({compra_id:2,compra_valor:null})];assert.equal((await read()).orcamento.estadoUtilizacao,'NEUTRO');});
test('missing or zero budget cannot produce division',async()=>{for(const value of [null,0]){budget=value;const b=await read();assert.equal(b.orcamento.percentualConhecido,null);assert.equal(b.orcamento.disponibilidade,'INDISPONIVEL');}});
test('only eligible own purchases count; items never double the total',async()=>{rows=[row({tb_compra_item:[{categoria_id:1},{categoria_id:2}]}),row({compra_id:2,usuario_id:2}),row({compra_id:3,compra_status:'AGUARDANDO_CONFIRMACAO'}),row({compra_id:4,compra_ativo:0})];const b=await read();assert.equal(b.financeiro.comprasConfirmadas,1);assert.equal(b.financeiro.totalCentavos,23000);assert.ok(queries.every(q=>q.usuario_id===1));assert.equal(transactions.length,1);assert.equal(transactions[0].isolationLevel,'RepeatableRead');assert.doesNotMatch(JSON.stringify(b),/compraId|categoria_nome|usuario_email|compra_fonte/);});
test('legitimate old purchase extends selector; unrelated data cannot',async()=>{rows=[row({compra_horario:new Date('2026-08-05Z')}),row({usuario_id:2,compra_horario:new Date('2020-01-01Z')})];const b=await read('2026-08');assert.equal(b.seletor.periodoMinimo,'2026-08');assert.equal(b.seletor.motivoLimiteInicial,'COMPRA_RETROATIVA');});
test('selector rejects earlier and future periods',async()=>{await assert.rejects(read('2026-08'));await assert.rejects(read('2026-11'));});
test('missing creation metadata is conservative',async()=>{created=null;assert.equal((await read()).seletor.periodoMinimo,'2026-10');});
test('UTC half-open cutoff excludes next month and unobserved purchases',async()=>{rows=[row({compra_horario:new Date('2026-10-01T00:00:00Z')}),row({compra_id:2,compra_horario:new Date('2026-11-01T00:00:00Z')}),row({compra_id:3,compra_horario:now})];assert.equal((await read()).financeiro.comprasConfirmadas,1);});
test('HTTP requires actual JWT and active user',async()=>{for(const token of [null,'bad',jwt.sign({userId:1},process.env.JWT_SECRET,{expiresIn:-1})])assert.equal((await request(undefined,token)).status,401);active=false;assert.equal((await request()).status,401);assert.equal(queries.length,0);});
test('HTTP validates missing duplicate extra malformed and future periods',async()=>{for(const q of ['','?periodo=2026-13','?periodo=2026-10&periodo=2026-09','?periodo=2026-10&usuarioId=2','?periodo=9999-10'])assert.equal((await request(q)).status,400);});
test('HTTP success is noncacheable and errors sanitized',async()=>{assert.equal((await request()).status,200);assert.equal((await request()).headers.get('cache-control'),'no-store');fail=true;const res=await request();assert.equal(res.status,500);assert.doesNotMatch(await res.text(),/private-db-secret/);});
test('same snapshot gives deterministic safe contract',async()=>{rows=[row()];assert.deepEqual(await read(),await read());});
test('perspectives are constant and expose no groups for zero one or many purchases',async()=>{
  const expected=(await read()).perspectivas;
  for(const purchases of [[row()], [row(),row({compra_id:2})]]) {
    rows=purchases;assert.deepEqual((await read()).perspectivas,expected);
  }
  assert.equal(expected.categorias.motivo,'POLITICA_DE_PRIVACIDADE_NAO_VERIFICAVEL');
  assert.equal(expected.pagamentos.disponibilidade,'INDISPONIVEL');
  assert.equal(expected.estabelecimentos.motivo,'SEM_IDENTIFICACAO_CONFIAVEL');
  assert.doesNotMatch(JSON.stringify(expected),/grupos|compras|nome|valor|id"/);
});
