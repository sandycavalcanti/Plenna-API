import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
let rows=[],queries=[];
const match=(row,where)=>Object.entries(where).every(([key,value])=>key==='OR'?value.some(condition=>match(row,condition)):value&&typeof value==='object'?Object.entries(value).every(([op,v])=>op==='in'?v.includes(row[key]):op==='notIn'?!v.includes(row[key]):op==='lt'?row[key]<v:op==='not'?row[key]!==v:true):row[key]===value);
const db={contexto_compra_revisao:{findMany:async()=>[]},tb_usuario:{findFirst:async({where})=>where.usuario_id===7?{usuario_id:7}:null},tb_compra:{findMany:async({where})=>where.usuario_id===7?[1,2].filter(id=>where.compra_id.in.includes(id)).map(compra_id=>({compra_id,compra_classificacao:'PENDENTE'})):[],findFirst:async({where})=>where.usuario_id===7&&where.compra_id===1?{compra_id:1,compra_valor:100}:null},
 tb_compra_item:{findFirst:async({where})=>where.compra_id===1&&where.compra_item_id===2?{compra_item_id:2}:null},
 tb_compra_evento:{findMany:async query=>{queries.push(query);const result=rows.filter(row=>match(row,query.where)).sort((a,b)=>Array.isArray(query.orderBy)?b.revisao-a.revisao||b.evento_id-a.evento_id:query.orderBy.revisao==='desc'?b.revisao-a.revisao:a.revisao-b.revisao);return result.slice(0,query.take).map(row=>({...row,...(query.include?{correcoes:rows.filter(c=>c.corrige_evento_id===row.evento_id)}:{})}));}},
 $transaction:async work=>work(db)};
globalThis.prismaRuntime={client:db,pool:{end:async()=>{}}};
const {EventosCompraService}=await import('../../src/modules/compra/eventos.service.ts');
const {criarResumoEventosDesc,resumirEventos}=await import('../../src/modules/compra/eventos.engine.ts');
const {eventosCompraRouter}=await import('../../src/modules/compra/eventos.routes.ts');
let server,base;
test.before(async()=>{const app=express();app.use('/v2/compras',eventosCompraRouter);server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}/v2/compras/1/eventos/historico`;});
test.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
const row=(id,extra={})=>({evento_id:id,compra_id:1,usuario_id:7,compra_item_id:id%2?null:2,revisao:id,tipo:'REEMBOLSO',dados:{valorCentavos:1},corrige_evento_id:null,anulado:false,efetiva_em:null,registrada_em:new Date('2026-10-30T12:00:00Z'),operacao_id:'op-'+id,origem:'DECLARADO',...extra});
test.beforeEach(()=>{queries=[];rows=Array.from({length:105},(_,i)=>row(i+1));});
test('histórico limita página, separa itens/compra e mantém correção fora da página',async()=>{
 rows.push(row(106,{corrige_evento_id:1}));
 const ids=[];let antes;do{const page=await EventosCompraService.historico(7,1,antes?{antes}:{});ids.push(...page.eventos.map(e=>e.id));if(page.eventos.some(e=>e.id===1))assert.equal(page.eventos.find(e=>e.id===1).corrigido,true);antes=page.proximaAntes;}while(antes);
 assert.equal(ids.length,106);assert.equal(new Set(ids).size,106);assert.ok(queries.every(q=>q.take===51));
 assert.ok((await EventosCompraService.historico(7,1,{itemId:2})).eventos.every(e=>e.itemId===2));
 assert.ok((await EventosCompraService.historico(7,1,{escopo:'COMPRA'})).eventos.every(e=>e.itemId===null));
 await assert.rejects(EventosCompraService.historico(8,1,{}),e=>e.statusCode===404);
 await assert.rejects(EventosCompraService.historico(7,1,{itemId:999}),e=>e.statusCode===404);
});
test('leitura compacta percorre lotes e conserva resumo integral com payload limitado',async()=>{
 rows=Array.from({length:1000},(_,i)=>row(i+1));
 const result=await EventosCompraService.consultar(7,1,true);
 assert.equal(result.eventos.length,50);assert.equal(result.resumo.reembolsadoCentavos,1000);assert.equal(result.revisao,1000);
 assert.ok(queries.length>=5);assert.ok(queries.every(q=>q.take===200));
});
test('HTTP exige autenticação, valida filtros e retorna somente página não cacheável',async()=>{
 const token=jwt.sign({userId:7},process.env.JWT_SECRET,{expiresIn:'5m'});
 const request=query=>fetch(base+query,{headers:{Authorization:`Bearer ${token}`}});
 assert.equal((await fetch(base)).status,401);
 for(const query of ['?antes=-1','?itemId=2147483648','?escopo=TODAS','?usuarioId=8'])assert.equal((await request(query)).status,400);
 assert.equal((await request('?itemId=999')).status,404);
 const result=await request('');assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');assert.equal((await result.json()).eventos.length,50);
});
test('acumulador preserva cadeias de correção/anulação, privacidade e classificação',()=>{
 const ledger=Array.from({length:1000},(_,i)=>row(i+1));
 ledger.push(row(1001,{corrige_evento_id:1,dados:{valorCentavos:2}}),row(1002,{corrige_evento_id:1001,anulado:true}),
 row(1003,{tipo:'CANCELAMENTO'}),row(1004,{tipo:'DEVOLUCAO'}),
 row(1005,{tipo:'OCULTACAO',compra_item_id:2,dados:{oculto:true}}),row(1006,{tipo:'OCULTACAO',compra_item_id:1,dados:{oculto:true}}),row(1007,{tipo:'OCULTACAO',compra_item_id:2,dados:{oculto:false}}),
 row(1008,{tipo:'CLASSIFICACAO',compra_item_id:null,dados:{classificacao:'IMPULSIVA'}}),row(1009,{tipo:'CLASSIFICACAO',compra_item_id:null,dados:{classificacao:'NAO_IMPULSIVA'}}),row(1010,{tipo:'OCULTACAO',compra_item_id:null,dados:{oculto:true}}));
 const expected={revisao:1010,reembolsadoCentavos:999,reembolsosSemData:999,oculto:true,itensOcultos:[1],classificacao:'NAO_IMPULSIVA',cancelamentos:1,devolucoes:1};
 assert.deepEqual(resumirEventos(ledger),expected);
 const accumulator=criarResumoEventosDesc();for(const event of ledger.toReversed())accumulator.adicionar(event);assert.deepEqual(accumulator.resultado(),expected);
});

test('resumos em lote preservam totais e propriet?rio sem trazer todo o hist?rico ? mem?ria',async()=>{
 rows=Array.from({length:1000},(_,i)=>row(i+1));rows.push(...Array.from({length:100},(_,i)=>row(1001+i,{compra_id:2,revisao:i+1})));
 const token=jwt.sign({userId:7},process.env.JWT_SECRET,{expiresIn:'5m'});
 const response=await fetch(base.replace('/1/eventos/historico','/resumos?ids=1,2,999'),{headers:{Authorization:`Bearer ${token}`}});
 assert.equal(response.status,200);const data=await response.json();assert.equal(data.resumos.length,2);
 assert.equal(data.resumos.find(r=>r.compraId===1).reembolsadoCentavos,1000);assert.equal(data.resumos.find(r=>r.compraId===2).reembolsadoCentavos,100);
 assert.ok(queries.length>=6);assert.ok(queries.every(q=>q.take===200));
});

test('purpose filtering precedes pagination and preserves the complete ledger',async()=>{
 rows=Array.from({length:160},(_,i)=>row(i+1,{tipo:i%2?'RESPOSTA_ANALISE':'CLASSIFICACAO'}));
 rows.push(row(161,{tipo:'COMPRA_EDITADA'}),row(162,{tipo:'ITEM_EDITADO'}));
 const purchase=await EventosCompraService.historico(7,1,{finalidade:'COMPRA'});
 assert.deepEqual(purchase.eventos.map(e=>e.id),[162,161]);assert.equal(purchase.proximaAntes,null);
 let antes,ids=[];do{const page=await EventosCompraService.historico(7,1,{finalidade:'ANALISE',...(antes?{antes}:{})});ids.push(...page.eventos.map(e=>e.id));antes=page.proximaAntes;}while(antes);
 assert.equal(ids.length,160);assert.equal(new Set(ids).size,160);assert.equal(rows.length,162);
 await assert.rejects(EventosCompraService.historico(8,1,{finalidade:'ANALISE'}),e=>e.statusCode===404);
});
