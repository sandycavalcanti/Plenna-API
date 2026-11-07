import test from 'node:test';
import assert from 'node:assert/strict';
import {criarFixturePanoramaSql} from './panorama-sql-fixture.mjs';
import express from 'express';
import jwt from 'jsonwebtoken';

// Existing transitive test tooling, no dependency change, tables, migrations,
// persistent database or network. SQL runs against SELECT-only VALUES sources.
process.env.NODE_ENV='test';process.env.DOTENV_CONFIG_PATH='.absent-offline-env';
Object.assign(process.env,{DATABASE_URL:'postgresql://localhost:1/offline',DIRECT_URL:'postgresql://localhost:1/offline',JWT_SECRET:'panorama-offline',GOOGLE_CLIENT_ID:'offline',GOOGLE_CLIENT_SECRET:'offline',GOOGLE_REDIRECT_URI:'https://example.invalid'});
delete process.env.RF018_LOCAL;
let fixtures,queryCount=0,active=true;
const pg=criarFixturePanoramaSql();
async function executar(query) {
  queryCount++;
  return pg.executar(query,fixtures);
}
const db={$queryRaw:executar,tb_usuario:{findFirst:async({where})=>active?{usuario_id:where.usuario_id,usuario_data_criacao:new Date("2026-01-15T15:00:00Z")}:null},tb_compra:{findMany:async({where})=>fixtures.compras.filter(p=>p.usuario_id===where.usuario_id&&p.compra_ativo===1&&p.compra_status==='CONFIRMADA'&&
  new Date(p.compra_horario)>=where.compra_horario.gte&&new Date(p.compra_horario)<where.compra_horario.lt).map(p=>({...p,compra_horario:new Date(p.compra_horario),compra_desconto:0,compra_acima_limite:null,tb_forma_pagamento:null,tb_compra_item:[]}))}};
globalThis.prismaRuntime={client:db,pool:{end:async()=>{}}};
const {PanoramaService,consultaPanoramaSql}=await import('../../src/modules/analise/panorama.service.ts');
const {periodoPanorama}=await import('../../src/modules/analise/panorama.schemas.ts');
const {apresentarComportamentoPanorama,comportamentoPanoramaSchema}=await import('../../src/modules/analise/panorama.comportamento.ts');
const {analisarHistorico}=await import('../../src/modules/analise/historico.engine.ts');
const {entradaHistoricoSchema}=await import('../../src/modules/analise/historico.schemas.ts');
const {resumirEventos}=await import('../../src/modules/compra/eventos.engine.ts');
const {classificacoesAgregadoSql}=await import('../../src/modules/compra/eventos.consulta.ts');
const {DashboardService}=await import('../../src/modules/dashboard/dashboard.service.ts');
const {analyticsResponseSchema,impulsividadeResponseSchema}=await import('../../src/modules/dashboard/dashboard.schemas.ts');
const {analisesRouter}=await import('../../src/modules/analise/analise.routes.ts');
const now=new Date('2026-11-06T15:00:00Z');
const compra=(id,extra={})=>({compra_id:id,usuario_id:7,compra_ativo:1,compra_status:'CONFIRMADA',compra_horario:'2026-10-05T12:00:00Z',compra_valor:100,compra_classificacao:'PENDENTE',...extra});
const contexto=(id,respostas,revisao=1)=>({contexto_id:id*10+revisao,compra_id:id,usuario_id:7,revisao,respostas});
const evento=(id,compraId,tipo,dados={},extra={})=>({evento_id:id,compra_id:compraId,usuario_id:7,compra_item_id:null,revisao:id,tipo,dados,corrige_evento_id:null,anulado:false,...extra});
const ler=(q={mes:'2026-10',detalhes:'1'})=>PanoramaService.consultar(7,q,now);

test('Panorama valida os mesmos limites da conta e preserva retroativos em todo histórico',async()=>{
 fixtures.compras=[compra(1,{compra_horario:'2010-02-02T12:00:00Z'})];
 for(const q of [{mes:'2025-12'},{mes:'2026-12'},{inicio:'2026-01-14',fim:'2026-01-15'}])
   await assert.rejects(PanoramaService.consultar(7,q,now),error=>error.statusCode===400);
 assert.equal((await ler({detalhes:'1'})).universo,1);
 assert.equal((await ler({mes:'2026-01',detalhes:'1'})).universo,0);
 assert.equal(fixtures.compras[0].compra_horario,'2010-02-02T12:00:00Z');
});
test.beforeEach(()=>{queryCount=0;active=true;fixtures={compras:[],eventos:[],contextos:[],contextoItens:[],itens:[],categorias:[]};});
test.after(async()=>pg.close());
test('SQL executa vazio, uma compra sem contexto e zero conhecido sem fabricar declarações',async()=>{
  let d=await ler();assert.equal(d.universo,0);assert.equal(d.disponibilidade,'SEM_DADOS');
  fixtures.compras=[compra(1,{compra_valor:0})];d=await ler();
  assert.equal(d.universo,1);assert.equal(d.comContexto,0);assert.equal(d.habitos.valoresValidos,1);assert.equal(d.habitos.totalCentavos,0);
  assert.ok(d.sinais.every(v=>v.validos===0&&v.proporcao===null));assert.equal(d.habitos.diasSemana[0].compras,1);
});
test('privacidade e cancelamento: nenhum indicador, texto ou cobertura expõe compras excluídas do universo',async()=>{
  fixtures.compras=[compra(1),compra(2),compra(3),compra(4,{compra_ativo:0}),compra(5,{usuario_id:8}),compra(6,{compra_status:'IGNORADA'}),compra(7)];
  fixtures.eventos=[evento(1,2,'OCULTACAO',{oculto:true}),evento(2,3,'CANCELAMENTO'),evento(3,7,'OCULTACAO',{oculto:true},{compra_item_id:70})];
  fixtures.contextos=[2,3,7].map(id=>contexto(id,{influenciaPromocional:'SIM',momento:'ANTECIPADA'}));
  fixtures.itens=[{compra_id:7,compra_item_id:70,compra_item_ativo:1,categoria_id:1}];fixtures.categorias=[{categoria_id:1,categoria_nome:'Segredo'}];
  const d=await ler();assert.equal(d.universo,1);assert.equal(d.comContexto,0);assert.equal(d.habitos.totalCentavos,10000);
  assert.deepEqual(d.habitos.categorias,[]);assert.ok(d.relacoes.every(v=>v.condicao===0));assert.doesNotMatch(JSON.stringify(d),/Segredo|compra_id|excluidas/);
});
test('SQL respeita a mesma vigência do ledger, correção anulada e última ocultação',async()=>{
  fixtures.compras=[compra(1),compra(2),compra(3)];
  fixtures.eventos=[evento(1,1,'CANCELAMENTO'),evento(2,1,'CANCELAMENTO',{}, {corrige_evento_id:1,anulado:true}),
    evento(3,2,'OCULTACAO',{oculto:true}),evento(4,2,'OCULTACAO',{oculto:false}),
    evento(5,3,'OCULTACAO',{oculto:false}),evento(6,3,'OCULTACAO',{oculto:true})];
  const oracle=fixtures.compras.filter(p=>{const s=resumirEventos(fixtures.eventos.filter(e=>e.compra_id===p.compra_id));return !s.oculto&&!s.cancelamentos&&!s.itensOcultos.length;});
  assert.equal((await ler()).universo,oracle.length);assert.equal(oracle.length,2);
});
test('filtros usam data da compra retroativa, limites civis, intervalo entre meses e todos sem piso de cadastro',async()=>{
  fixtures.compras=[compra(1,{compra_horario:'2026-10-01T02:59:59Z'}),compra(2,{compra_horario:'2026-10-01T03:00:00Z'}),
    compra(3,{compra_horario:'2026-11-01T02:59:59Z'}),compra(4,{compra_horario:'2026-11-01T03:00:00Z'}),
    compra(5,{compra_horario:'2000-01-01T12:00:00Z'}),compra(6,{compra_horario:'2026-11-07T12:00:00Z'})];
  assert.equal((await ler()).universo,2);
  assert.equal((await ler({inicio:'2026-09-30',fim:'2026-10-01',detalhes:'1'})).universo,2);
  assert.equal((await ler({detalhes:'1'})).universo,5);
  assert.equal((await ler({mes:'2026-11',detalhes:'1'})).universo,1);
  assert.equal((await ler({mes:'2026-09',detalhes:'1'})).universo,1);
});
test('interseções exigem fatores na mesma compra e denominadores próprios; ausentes não viram não',async()=>{
  fixtures.compras=[1,2,3,4,5].map(id=>compra(id));
  fixtures.contextos=[contexto(1,{influenciaPromocional:'SIM'}),contexto(2,{momento:'ANTECIPADA'}),
    contexto(3,{influenciaPromocional:'SIM',momento:'ANTECIPADA',autopercepcaoImpulsividade:'SIM'}),
    contexto(4,{influenciaPromocional:'NAO',momento:'ADIADA'}),contexto(5,{influenciaPromocional:'NAO_LEMBRO',autopercepcaoImpulsividade:'PREFIRO_NAO_RESPONDER'})];
  const d=await ler(),s=d.sinais.find(s=>s.codigo==='PROMOCAO'),r=d.relacoes.find(r=>r.codigo==='PROMOCAO_ANTECIPACAO');
  assert.deepEqual([s.condicao,s.validos,s.universo],[2,3,5]);assert.deepEqual([r.condicao,r.validos],[1,2]);
  assert.equal(d.comContexto,4);assert.equal(d.comAutopercepcao,1);assert.equal(d.relacoes.find(r=>r.codigo==='PROMOCAO_IMPULSO').validos,1);
  assert.equal(d.sinais.find(s=>s.codigo==='IMPULSO').condicao,1);assert.equal(s.periodo.mes,'2026-10');
});
test('última revisão remove respostas antigas; avaliação persistida não é consultada ou recalculada',async()=>{
  fixtures.compras=[compra(1)];fixtures.contextos=[contexto(1,{influenciaPromocional:'SIM'}),contexto(1,{},2)];
  const d=await ler();assert.equal(d.comContexto,0);assert.equal(d.sinais.find(s=>s.codigo==='PROMOCAO').validos,0);assert.equal(queryCount,1);
});

test('releituras em novembro refletem edições de outubro, fontes tardias e elegibilidade sem mover compras',async()=>{
  fixtures.compras=[compra(1)];
  fixtures.categorias=[{categoria_id:1,categoria_nome:'Outros'},{categoria_id:2,categoria_nome:'Personalizada'}];
  fixtures.itens=[{compra_id:1,compra_item_id:10,compra_item_ativo:1,categoria_id:1}];
  fixtures.contextos=[contexto(1,{influenciaPromocional:'SIM'})];
  assert.equal((await ler()).habitos.categorias[0].nome,'Outros');
  fixtures.itens[0].categoria_id=2;fixtures.compras[0].compra_valor=25;fixtures.compras[0].compra_classificacao='IMPULSIVA';
  let d=await ler();assert.equal(d.habitos.categorias[0].nome,'Personalizada');assert.equal(d.habitos.totalCentavos,2500);
  assert.equal(d.sinais.find(v=>v.codigo==='CLASSIFICADA_IMPULSIVA').condicao,1);
  assert.equal((await ler({mes:'2026-11',detalhes:'1'})).universo,0);
  fixtures.itens[0].compra_item_ativo=0;fixtures.contextos.push(contexto(1,{},2));
  d=await ler();assert.equal(d.habitos.categorias.length,0);assert.equal(d.comContexto,0);
  // A newly received source with an October reference joins October on the next read.
  fixtures.compras.push(compra(2));assert.equal((await ler()).universo,2);
  for(const [tipo,dados,extra] of [['CANCELAMENTO',{},{}],['OCULTACAO',{oculto:true},{}],['OCULTACAO',{oculto:true},{compra_item_id:10}]]){
    fixtures.eventos=[evento(1,1,tipo,dados,extra)];d=await ler();assert.equal(d.universo,1);assert.equal(d.habitos.totalCentavos,10000);assert.equal(d.sinais.find(v=>v.codigo==='CLASSIFICADA_IMPULSIVA').condicao,0);
  }
  fixtures.eventos=[];fixtures.compras[0].compra_ativo=0;assert.equal((await ler()).universo,1);
  assert.equal(fixtures.compras[0].compra_horario,'2026-10-05T12:00:00Z');
});
test('planejamento de itens ativos na última revisão e necessidade inesperada formam relações verificáveis',async()=>{
  fixtures.compras=[compra(1),compra(2),compra(3)];fixtures.contextos=[contexto(1,{planejamento:'PARCIALMENTE'}),contexto(2,{planejamento:'NAO',necessidadeInesperada:'SIM'}),contexto(3,{planejamento:'PARCIALMENTE'})];
  fixtures.itens=[{compra_id:1,compra_item_id:10,compra_item_ativo:1,categoria_id:1},{compra_id:3,compra_item_id:30,compra_item_ativo:0,categoria_id:1}];
  fixtures.contextoItens=[{contexto_id:11,compra_id:1,compra_item_id:10,planejamento:'NAO'},{contexto_id:31,compra_id:3,compra_item_id:30,planejamento:'NAO'}];
  fixtures.categorias=[{categoria_id:1,categoria_nome:'Outros'}];const d=await ler();
  assert.equal(d.relacoes.find(s=>s.codigo==='PARCIAL_ITENS').condicao,1);assert.equal(d.relacoes.find(s=>s.codigo==='PARCIAL_ITENS').validos,1);
  assert.equal(d.relacoes.find(s=>s.codigo==='NECESSIDADE_SEM_PLANO').condicao,1);assert.equal(d.habitos.categorias[0].compras,1);
});
test('classificações voluntárias não se confundem com autopercepção e valores desconhecidos não afetam contagem',async()=>{
  fixtures.compras=[compra(1,{compra_classificacao:'IMPULSIVA',compra_valor:null}),compra(2,{compra_classificacao:'NAO_IMPULSIVA'})];
  fixtures.contextos=[contexto(1,{autopercepcaoImpulsividade:'NAO'}),contexto(2,{autopercepcaoImpulsividade:'SIM'})];
  const d=await ler();assert.equal(d.habitos.valoresValidos,1);assert.equal(d.sinais.find(s=>s.codigo==='CLASSIFICADA_IMPULSIVA').origem,'CLASSIFICACAO_REGISTRADA');
  assert.equal(d.sinais.find(s=>s.codigo==='CLASSIFICADA_IMPULSIVA').condicao,1);assert.equal(d.sinais.find(s=>s.codigo==='IMPULSO').condicao,1);
  assert.equal(d.habitos.comparacao.disponibilidade,'INDISPONIVEL');
});
test('Dashboard preserva contratos e coincide com universo protegido do panorama, incluindo classificação sem valor',async()=>{
  fixtures.compras=[compra(1,{compra_classificacao:'IMPULSIVA',compra_valor:null}),compra(2,{compra_classificacao:'NAO_IMPULSIVA'}),compra(3,{compra_classificacao:'IMPULSIVA'}),compra(4)];
  fixtures.eventos=[evento(1,3,'OCULTACAO',{oculto:true}),evento(2,4,'CANCELAMENTO')];
  const p=await ler(),legacy=await DashboardService.findImpulsividade(7,'2026-10'),analytics=await DashboardService.analytics(7,{mode:'month',month:'2026-10'});
  assert.equal(p.universo,2);assert.equal(legacy.reduce((n,g)=>n+g.quantidade_total,0),p.universo);
  assert.equal(legacy.find(g=>g.compra_classificacao==='IMPULSIVA').quantidade,0);assert.equal(legacy.find(g=>g.compra_classificacao==='IMPULSIVA').quantidade_sem_valor,1);
  assert.equal(analytics.periodos[0].impulsividade.reduce((n,g)=>n+g.quantidade,0),p.universo);
  assert.equal(analytics.periodos[0].impulsividade.find(g=>g.compra_classificacao==='IMPULSIVA').valor_total_centavos,0);
});
test('enum físico NAO IMPULSIVA é convertido ao contrato Prisma em outubro e nos denominadores do panorama',async()=>{
  fixtures.compras=[compra(1,{compra_classificacao:'NAO IMPULSIVA'}),compra(2,{compra_classificacao:'IMPULSIVA'})];
  const panorama=await ler();const negativo=panorama.sinais.find(s=>s.codigo==='CLASSIFICADA_NAO_IMPULSIVA');
  assert.equal(negativo.condicao,1);assert.equal(negativo.validos,2);
  const legacy=await DashboardService.findImpulsividade(7,'2026-10');assert.ok(impulsividadeResponseSchema.safeParse(legacy).success);
  assert.equal(legacy.find(v=>v.compra_classificacao==='NAO_IMPULSIVA').quantidade_total,1);
  const analytics=await DashboardService.analytics(7,{mode:'month',month:'2026-10'});
  assert.ok(analyticsResponseSchema.safeParse(analytics).success);assert.equal(analytics.periodos[0].impulsividade.find(v=>v.compra_classificacao==='NAO_IMPULSIVA').quantidade,1);
  const unnormalized=structuredClone(analytics);unnormalized.periodos[0].impulsividade.find(v=>v.compra_classificacao==='NAO_IMPULSIVA').compra_classificacao='NAO IMPULSIVA';
  assert.equal(analyticsResponseSchema.safeParse(unnormalized).success,false);
});
test('classificações em comparação não incluem meses no intervalo entre as janelas',async()=>{
  fixtures.compras=[compra(1,{compra_horario:'2026-08-01T12:00:00Z'}),compra(2),compra(3,{compra_horario:'2026-09-01T12:00:00Z'})];
  const groups=await executar(classificacoesAgregadoSql(7,[{inicio:new Date('2026-08-01T03:00:00Z'),fim:new Date('2026-09-01T03:00:00Z')},
    {inicio:new Date('2026-10-01T03:00:00Z'),fim:new Date('2026-11-01T03:00:00Z')}]));
  assert.deepEqual(groups.map(g=>g.periodo),['2026-08','2026-10']);
});
test('muitos registros, categorias e datas: uma consulta e resposta limitada, resumo sem detalhes',async()=>{
  fixtures.compras=Array.from({length:2000},(_,i)=>compra(i+1));
  fixtures.itens=fixtures.compras.map((p,i)=>({compra_id:p.compra_id,compra_item_id:i+1,compra_item_ativo:1,categoria_id:i%20+1}));
  fixtures.categorias=Array.from({length:20},(_,i)=>({categoria_id:i+1,categoria_nome:`Categoria ${i}`}));
  let d=await ler();assert.equal(queryCount,1);assert.equal(d.universo,2000);assert.equal(d.habitos.categorias.length,5);assert.ok(JSON.stringify(d).length<24000);
  d=await ler({mes:'2026-10'});assert.equal(d.habitos,undefined);assert.equal(d.sinais,undefined);assert.equal(d.universo,2000);
});
test('datas e filtros rejeitam conflitos, paginação, usuário injetado e futuro antes da consulta',()=>{
  for(const q of [{mes:'2026-10',inicio:'2026-10-01',fim:'2026-10-02'},{inicio:'2026-02-30',fim:'2026-03-02'},
    {mes:'2026-12'},{inicio:'2026-11-01',fim:'2026-11-07'},{antes:2},{usuarioId:8},{status:'IGNORADA'},{busca:'x'},{detalhes:'2'}])
    assert.throws(()=>periodoPanorama(q,now));
  assert.equal(queryCount,0);
  const sql=consultaPanoramaSql(7,null,now,true);assert.ok(sql.values.includes(7));assert.doesNotMatch(sql.text,/usuario_id=7/);
});
test('HTTP aplica JWT e usuário ativo, não permite escolher usuário e não armazena resposta em cache',async()=>{
  const app=express();app.use('/analises',analisesRouter);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}/analises/panorama`;
  const req=(token,query='?mes=2026-10')=>fetch(base+query,{headers:token?{Authorization:`Bearer ${token}`}:{}});
  try {
    for(const token of [undefined,'invalid',jwt.sign({userId:7},process.env.JWT_SECRET,{expiresIn:-1})])assert.equal((await req(token)).status,401);
    const token=jwt.sign({userId:7},process.env.JWT_SECRET);active=false;assert.equal((await req(token)).status,401);active=true;
    assert.equal((await req(token,'?mes=2026-10&usuarioId=8')).status,400);assert.equal(queryCount,0);
    fixtures.compras=[compra(1),compra(2,{usuario_id:8})];const response=await req(token);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).universo,1);
    const other=await req(jwt.sign({userId:9},process.env.JWT_SECRET));assert.equal((await other.json()).universo,0);
    const original=db.$queryRaw;
    try { db.$queryRaw=async()=>{throw Error('private-database-error');};
      const failed=await req(token);assert.equal(failed.status,500);assert.equal(failed.headers.get('cache-control'),'no-store');assert.doesNotMatch(await failed.text(),/private-database-error|SELECT/);
    } finally {db.$queryRaw=original;}
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('opção ausente preserva SQL e resposta; somente 1 negocia o bloco aditivo',async()=>{
  fixtures.compras=[compra(1,{compra_recorrencia_id:10}),compra(2)];fixtures.recorrencias=[{compra_recorrencia_id:10,usuario_id:7}];
  const legacy=await ler(), extended=await ler({mes:'2026-10',detalhes:'1',comportamento:'1'});
  const {comportamento,...base}=extended;assert.deepEqual(base,legacy);assert.ok(!Object.hasOwn(legacy,'comportamento'));
  assert.equal(comportamento.recorrencias.comprasVinculadas,1);assert.equal(comportamento.recorrencias.vinculosDistintos,1);
  assert.equal(comportamento.comparacao.disponibilidade,'INDISPONIVEL');assert.deepEqual(comportamento.comparacao.motivos,['COBERTURA_NAO_COMPLETA']);
  const original=consultaPanoramaSql(7,null,now,true), explicitFalse=consultaPanoramaSql(7,null,now,true,false);
  assert.equal(original.text,explicitFalse.text);assert.deepEqual(original.values,explicitFalse.values);
  assert.doesNotMatch(original.text,/tb_compra_recorrencia/);
  for(const value of ['0','true','2',1,['1','1']])assert.throws(()=>periodoPanorama({comportamento:value},now));
});

test('vínculos registrados: não infere por valor/data, conta compra uma vez e exige propriedade do cadastro',async()=>{
  fixtures.compras=[compra(1,{compra_recorrencia_id:10}),compra(2,{compra_recorrencia_id:10}),compra(3,{compra_recorrencia_id:11}),compra(4),compra(5,{compra_recorrencia_id:12}),compra(6,{compra_recorrencia_id:999})];
  fixtures.recorrencias=[{compra_recorrencia_id:10,usuario_id:7},{compra_recorrencia_id:11,usuario_id:7},{compra_recorrencia_id:12,usuario_id:8}];
  const d=await ler({mes:'2026-10',comportamento:'1'});assert.equal(queryCount,1);assert.equal(d.habitos,undefined);
  assert.deepEqual(d.comportamento.recorrencias,{origem:'VINCULOS_REGISTRADOS',comprasVinculadas:3,vinculosDistintos:2,cobertura:'REGISTROS_DISPONIVEIS'});
  const before=structuredClone(d.comportamento);fixtures.compras.forEach(p=>p.compra_classificacao='IMPULSIVA');
  assert.deepEqual((await ler({mes:'2026-10',comportamento:'1'})).comportamento,before);
  assert.doesNotMatch(JSON.stringify(before),/usuario_id|compra_id|compra_recorrencia_id|score|previsao/);
});

test('privacidade é aplicada antes das contagens e não vaza mudanças em registros inelegíveis',async()=>{
  fixtures.compras=[compra(1,{compra_recorrencia_id:1}),compra(2,{compra_recorrencia_id:2}),compra(3,{compra_recorrencia_id:3}),compra(4,{compra_recorrencia_id:4,compra_ativo:0}),compra(5,{compra_recorrencia_id:5,usuario_id:8}),compra(6,{compra_recorrencia_id:6,compra_status:'IGNORADA'}),compra(7,{compra_recorrencia_id:7})];
  fixtures.recorrencias=Array.from({length:7},(_,i)=>({compra_recorrencia_id:i+1,usuario_id:7}));
  fixtures.eventos=[evento(1,2,'OCULTACAO',{oculto:true}),evento(2,3,'CANCELAMENTO'),evento(3,7,'OCULTACAO',{oculto:true},{compra_item_id:70})];
  const q={mes:'2026-10',detalhes:'1',comportamento:'1'},before=await ler(q);
  assert.equal(before.universo,1);assert.equal(before.comportamento.recorrencias.comprasVinculadas,1);
  fixtures.compras.slice(1).forEach(p=>{p.compra_valor=987654.32;p.compra_recorrencia_id=1;p.compra_classificacao='IMPULSIVA';});
  assert.deepEqual(await ler(q),before);
  fixtures.eventos=[evento(1,1,'OCULTACAO',{oculto:true}),evento(2,1,'OCULTACAO',{oculto:false}),evento(3,2,'CANCELAMENTO'),evento(4,2,'CANCELAMENTO',{}, {corrige_evento_id:3,anulado:true})];
  const oracle=fixtures.compras.filter(p=>p.usuario_id===7&&p.compra_ativo===1&&p.compra_status==='CONFIRMADA').filter(p=>{const s=resumirEventos(fixtures.eventos.filter(e=>e.compra_id===p.compra_id));return !s.oculto&&!s.itensOcultos.length&&!s.cancelamentos;});
  assert.equal((await ler(q)).comportamento.recorrencias.comprasVinculadas,oracle.length);
});

test('vínculos respeitam mês, intervalo civil, todo histórico e registros retroativos',async()=>{
  fixtures.recorrencias=[{compra_recorrencia_id:1,usuario_id:7}];
  fixtures.compras=['2026-10-01T02:59:59Z','2026-10-01T03:00:00Z','2026-11-01T02:59:59Z','2026-11-01T03:00:00Z','2010-02-02T12:00:00Z'].map((date,i)=>compra(i+1,{compra_horario:date,compra_recorrencia_id:1}));
  assert.equal((await ler({mes:'2026-10',comportamento:'1'})).comportamento.recorrencias.comprasVinculadas,2);
  const intervalo=await ler({inicio:'2026-09-30',fim:'2026-10-01',comportamento:'1'});
  assert.equal(intervalo.comportamento.recorrencias.comprasVinculadas,2);assert.deepEqual(intervalo.comportamento.comparacao.motivos,['COMPARACAO_APENAS_PARA_MES']);
  const all=await ler({comportamento:'1'});assert.equal(all.comportamento.recorrencias.comprasVinculadas,5);assert.equal(all.comportamento.comparacao.atual,null);
  const original=db.tb_compra.findMany;try {db.tb_compra.findMany=()=>{throw Error('UNNECESSARY_HISTORY_LOAD');};assert.ok((await ler({mes:'2026-10',comportamento:'1'})).comportamento);}finally{db.tb_compra.findMany=original;}
});

function historicoCompleto(extra={}) {
  const fontes=entradaHistoricoSchema.parse({usuarioId:7,periodo:'2026-10',mesesHistorico:1,observadoAte:'2026-11-01T03:00:00Z',cobertura:'COMPLETA',orcamentoAtual:null,
    compras:[['2026-09-02T12:00:00Z','0.01'],['2026-09-03T12:00:00Z','0.02'],['2026-10-02T12:00:00Z','0.03'],['2026-10-03T12:00:00Z','0.04'],['2026-10-31T12:00:00Z','90000']].map(([data,valorLiquido],i)=>({id:i+1,usuarioId:7,ativa:true,status:'CONFIRMADA',data,precisao:'DIA',valorLiquido,origem:'MANUAL',categorias:[],recorrenciaId:null,contexto:null})),...extra});
  return {fontes,historico:analisarHistorico(fontes),compras:fontes.compras};
}
const recs={origem:'VINCULOS_REGISTRADOS',comprasVinculadas:0,vinculosDistintos:0,cobertura:'REGISTROS_DISPONIVEIS'};
test('comparação reutiliza janelas equivalentes e mediana por compra, inclusive meio centavo',()=>{
  const p=periodoPanorama({mes:'2026-10'},now).periodo,h=historicoCompleto();
  const d=apresentarComportamentoPanorama(recs,p,3,h),c=d.comparacao;
  assert.equal(c.disponibilidade,'DISPONIVEL');assert.deepEqual(c.frequencia,{atual:2,anterior:2,diferenca:0});
  assert.deepEqual(c.medianaCentavos,{atual:3.5,anterior:1.5,diferenca:2});
  assert.equal(c.atual.fimExclusivo,'2026-10-31T03:00:00.000Z');
  assert.equal(Date.parse(c.atual.fimExclusivo)-Date.parse(c.atual.inicio),Date.parse(c.anterior.fimExclusivo)-Date.parse(c.anterior.inicio));
  assert.equal(comportamentoPanoramaSchema.safeParse(d).success,true);
});
test('cobertura parcial/desconhecida, janelas divergentes e valores ausentes não fabricam comparações',()=>{
  const p=periodoPanorama({mes:'2026-10'},now).periodo;
  for(const cobertura of ['PARCIAL','DESCONHECIDA']){
    const c=apresentarComportamentoPanorama(recs,p,3,historicoCompleto({cobertura})).comparacao;
    assert.equal(c.disponibilidade,'INDISPONIVEL');assert.equal(c.medianaCentavos,null);assert.equal(c.frequencia,null);
  }
  const h=historicoCompleto();h.historico.frequencia.comparacao.fimAnteriorExclusivo='2026-09-02T03:00:00Z';
  assert.equal(apresentarComportamentoPanorama(recs,p,3,h).comparacao.disponibilidade,'INDISPONIVEL');
  const missing=historicoCompleto();missing.compras[0].valorLiquido=null;
  const c=apresentarComportamentoPanorama(recs,p,3,missing).comparacao;
  assert.equal(c.disponibilidade,'DISPONIVEL');assert.ok(c.frequencia);assert.equal(c.medianaCentavos,null);assert.ok(c.motivos.length);
  assert.throws(()=>apresentarComportamentoPanorama({...recs,comprasVinculadas:2,vinculosDistintos:1},p,1));
  const unknownDate=historicoCompleto();unknownDate.historico.qualidade.cobertura='PARCIAL';
  assert.deepEqual(apresentarComportamentoPanorama(recs,p,3,unknownDate).comparacao.motivos,['COBERTURA_NAO_COMPLETA']);
  assert.throws(()=>apresentarComportamentoPanorama(recs,p,0,historicoCompleto()),/COMPARISON_UNIVERSE/);
});
test('HTTP negocia comportamento sem permitir injeção de usuário, duplicação ou cache',async()=>{
  const app=express();app.use('/analises',analisesRouter);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}/analises/panorama?mes=2026-10&comportamento=1`;
  const headers={Authorization:'Bearer '+jwt.sign({userId:7},process.env.JWT_SECRET)};
  try{
    assert.equal((await fetch(base)).status,401);
    for(const suffix of ['&usuarioId=8','&comportamento=1','&cobertura=COMPLETA'])assert.equal((await fetch(base+suffix,{headers})).status,400);
    assert.equal(queryCount,0);
    fixtures.compras=[compra(1,{compra_recorrencia_id:10}),compra(2,{usuario_id:8,compra_recorrencia_id:10})];fixtures.recorrencias=[{compra_recorrencia_id:10,usuario_id:7}];
    const response=await fetch(base,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).comportamento.recorrencias.comprasVinculadas,1);
    const other=await fetch(base,{headers:{Authorization:'Bearer '+jwt.sign({userId:9},process.env.JWT_SECRET)}});assert.equal((await other.json()).comportamento.recorrencias.comprasVinculadas,0);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('janelas históricas preservam mês parcial, virada de ano e fevereiro bissexto',()=>{
  for(const [mes,cutoff,dias] of [['2026-10','2026-10-16T03:00:00Z',15],['2026-01','2026-02-01T03:00:00Z',31],['2024-03','2024-04-01T03:00:00Z',29]]) {
    const p=periodoPanorama({mes},new Date(cutoff)).periodo;
    const h=historicoCompleto({periodo:mes,observadoAte:cutoff,compras:[]});
    const c=apresentarComportamentoPanorama(recs,p,0,h).comparacao;
    assert.equal(c.disponibilidade,'DISPONIVEL');assert.equal(Date.parse(c.atual.fimExclusivo)-Date.parse(c.atual.inicio),dias*86400000);
    assert.deepEqual(c.frequencia,{atual:0,anterior:0,diferenca:0});assert.equal(c.medianaCentavos,null);
  }
});
