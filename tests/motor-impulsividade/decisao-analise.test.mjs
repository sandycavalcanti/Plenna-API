import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import {fileURLToPath} from 'node:url';

let purchase,context,assessments,events,failUpdate,active;
let queue=Promise.resolve();
const copy=structuredClone;
const tx={
  $queryRaw:async(_s,...v)=>v.length===1?[{usuario_id:v[0]}]:v[0]===purchase.compra_id&&v[1]===purchase.usuario_id?[{compra_id:purchase.compra_id}]:[],
  tb_compra:{findFirst:async({where})=>where.compra_id===purchase.compra_id&&where.usuario_id===purchase.usuario_id&&(where.compra_ativo===undefined||purchase.compra_ativo===where.compra_ativo)?copy(purchase):null,
    update:async({data})=>{if(failUpdate)throw Error('SIMULATED_WRITE_FAILURE');Object.assign(purchase,data);return copy(purchase);}},
  contexto_compra_revisao:{findFirst:async()=>copy(context)},
  avaliacao_compra:{findFirst:async({where})=>copy(assessments.filter(a=>Object.entries(where).every(([k,v])=>a[k]===v)).at(-1)??null),
    upsert:async({create})=>{const row={...copy(create),avaliacao_id:assessments.length+1,criada_em:new Date('2026-11-07T12:30:00Z')};assessments.push(row);return copy(row);}},
  tb_compra_evento:{findUnique:async({where})=>copy(events.find(e=>e.compra_id===where.compra_id_operacao_id.compra_id&&e.operacao_id===where.compra_id_operacao_id.operacao_id)??null),
    findMany:async()=>copy(events),create:async({data})=>{const row={...copy(data),evento_id:events.length+1,origem:'DECLARADO',registrada_em:new Date('2026-11-07T12:45:00Z')};events.push(row);return copy(row);}},
};
const db={...tx,tb_usuario:{findFirst:async({where})=>active?{usuario_id:where.usuario_id}:null},$transaction:(cb)=>{
  const run=queue.then(async()=>{const snapshot=copy({purchase,context,assessments,events});try{return await cb(tx);}catch(e){({purchase,context,assessments,events}=snapshot);throw e;}});
  queue=run.catch(()=>{});return run;
}};
globalThis.prismaRuntime={client:db,pool:{end:async()=>{}}};
const {AvaliacaoService}=await import('../../src/modules/analise/avaliacao.service.ts');
const {EventosCompraService}=await import('../../src/modules/compra/eventos.service.ts');
const {resumirEventos}=await import('../../src/modules/compra/eventos.engine.ts');
const {eventosCompraRouter}=await import('../../src/modules/compra/eventos.routes.ts');
const body=(extra={})=>({versaoContrato:1,operacaoId:randomUUID(),revisaoEsperada:events.length,dataEfetiva:null,tipo:'RESPOSTA_ANALISE',
  avaliacaoId:1,versaoMotor:'contextual-2',versaoInterpretacao:'sinais-contextuais-1',interpretacaoId:'sinais-contextuais-1:compositor-contextual-1:1:PROMOCAO_MOMENTO',resposta:'CONCORDO',confirmarImpulsiva:true,...extra});
test.beforeEach(async()=>{
  failUpdate=false;active=true;events=[];assessments=[];
  purchase={compra_id:1,usuario_id:7,compra_ativo:1,compra_status:'CONFIRMADA',compra_valor:'100',compra_desconto:'0',compra_horario:new Date('2026-10-05T12:00:00Z'),compra_email:false,compra_fonte:'Loja',compra_classificacao:'PENDENTE',tb_usuario:{usuario_meta_valor_compra:'80'},tb_compra_item:[]};
  context={contexto_id:1,revisao:1,respostas:{influenciaPromocional:'SIM',momento:'ANTECIPADA'},itens:[]};
  await AvaliacaoService.calcular(7,1,{revisaoEsperada:1});
});
test('confirmação grava evento e projeção atomicamente, com avaliação, origem, anterior e data reais',async()=>{
  const r=await EventosCompraService.registrar(7,1,body());assert.equal(purchase.compra_classificacao,'IMPULSIVA');assert.equal(events.length,1);
  assert.equal(r.evento.dados.classificacaoAnterior,'PENDENTE');assert.equal(r.evento.dados.origemDecisao,'CONFIRMACAO_ANALISE');assert.equal(r.evento.dados.avaliacaoId,1);
  assert.equal(r.evento.registradaEm,'2026-11-07T12:45:00.000Z');assert.equal(purchase.compra_horario.toISOString(),'2026-10-05T12:00:00.000Z');assert.equal(resumirEventos(events).classificacao,'IMPULSIVA');
});
test('discordância e não sei preservam classificação; revisão voluntária mantém todos os eventos',async()=>{
  await EventosCompraService.registrar(7,1,body());
  await EventosCompraService.registrar(7,1,body({resposta:'DISCORDO',confirmarImpulsiva:false}));assert.equal(purchase.compra_classificacao,'IMPULSIVA');
  await EventosCompraService.registrar(7,1,body({resposta:'NAO_SEI',confirmarImpulsiva:false}));assert.equal(purchase.compra_classificacao,'IMPULSIVA');
  await EventosCompraService.registrar(7,1,{versaoContrato:1,tipo:'CLASSIFICACAO',operacaoId:randomUUID(),revisaoEsperada:3,dataEfetiva:null,classificacao:'NAO_IMPULSIVA'});
  assert.equal(events.length,4);assert.equal(resumirEventos(events).classificacao,'NAO_IMPULSIVA');assert.equal(events[3].dados.classificacaoAnterior,'IMPULSIVA');
  await EventosCompraService.registrar(7,1,body());assert.equal(purchase.compra_classificacao,'IMPULSIVA');assert.equal(events[4].dados.classificacaoAnterior,'NAO_IMPULSIVA');
});
test('reenvio idempotente não duplica; UUID reutilizado com outro conteúdo e concorrência de revisão são rejeitados',async()=>{
  const b=body();const [a,r]=await Promise.all([EventosCompraService.registrar(7,1,b),EventosCompraService.registrar(7,1,b)]);assert.equal(a.evento.id,r.evento.id);assert.equal(events.length,1);
  await assert.rejects(EventosCompraService.registrar(7,1,{...b,resposta:'DISCORDO',confirmarImpulsiva:false}),e=>e.statusCode===409);
  const rev=events.length;const results=await Promise.allSettled([EventosCompraService.registrar(7,1,body({revisaoEsperada:rev})),EventosCompraService.registrar(7,1,body({revisaoEsperada:rev}))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(events.length,2);
});
test('falha da projeção desfaz o evento; avaliação obsoleta ou de outro usuário não permite resposta',async()=>{
  failUpdate=true;await assert.rejects(EventosCompraService.registrar(7,1,body()),/SIMULATED_WRITE_FAILURE/);assert.equal(events.length,0);assert.equal(purchase.compra_classificacao,'PENDENTE');
  failUpdate=false;purchase.compra_valor='120';await assert.rejects(EventosCompraService.registrar(7,1,body()),e=>e.statusCode===409);assert.equal(events.length,0);
  await assert.rejects(EventosCompraService.registrar(8,1,body()),e=>e.statusCode===404);
});
test('privacy, cancelamento, exclusão, referências e discordância com confirmação indevida são rejeitados',async()=>{
  for(const patch of [{resposta:'DISCORDO'},{interpretacaoId:'sinais-contextuais-1:compositor-contextual-1:2:OUTRA'},{avaliacaoId:2},{versaoMotor:'contextual-1'},{itemId:99},{dataEfetiva:'2026-11-01'}])await assert.rejects(EventosCompraService.registrar(7,1,body(patch)));
  for(const [tipo,dados,compra_item_id] of [['OCULTACAO',{oculto:true},null],['OCULTACAO',{oculto:true},10],['CANCELAMENTO',{},null]]){
    events=[{evento_id:1,revisao:1,compra_item_id,tipo,dados,corrige_evento_id:null,anulado:false,efetiva_em:null}];
    await assert.rejects(EventosCompraService.registrar(7,1,body()),e=>e.statusCode===409);
  }
  events=[];purchase.compra_ativo=0;await assert.rejects(EventosCompraService.registrar(7,1,body()),e=>e.statusCode===404);
});
test('endpoint existente exige JWT, sessão ativa e propriedade para a nova intenção',async()=>{
  const app=express();app.use(express.json());app.use('/v2/compras',eventosCompraRouter);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url=`http://127.0.0.1:${server.address().port}/v2/compras/1/eventos`;
  try{const send=token=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body())});
    assert.equal((await send()).status,401);
    const token=jwt.sign({userId:7},process.env.JWT_SECRET);assert.equal((await send(token)).status,200);active=false;assert.equal((await send(token)).status,401);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

// Explicit opt-in workspace integration: no production dependency on the sibling Mobile repo.
if(process.env.RF018_MOBILE_INTEGRATION==='1')test('Mobile → HTTP real → avaliação/ledger → releitura: confirma, discorda e preserva classificação',async()=>{
  const {createRenderer}=await import(new URL('tests/helpers/componentRenderer.mjs', process.env.PLENNA_MOBILE_URL));
  const {contextoRouter}=await import('../../src/modules/analise/contexto.routes.ts');
  const app=express();app.use(express.json());app.use('/v2/compras',contextoRouter);app.use('/v2/compras',eventosCompraRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${server.address().port}`,token=jwt.sign({userId:7},process.env.JWT_SECRET),abort=new AbortController();
  const request=async(url,method='GET',data)=>{const response=await fetch(origin+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const result=await response.json();if(!response.ok)throw {response:{status:response.status,data:result}};return {data:result};};
  const h=createRenderer({'../../../api/client':{apiClient:{get:url=>request(url),post:(url,b)=>request(url,'POST',b)}},'../../../api/tokenStorage':{tokenStorage:{captureSession:async()=>({id:7,signal:abort.signal}),assertSession:()=>{if(abort.signal.aborted)throw Error('SESSION');}}},'expo-crypto':{randomUUID}});
  const previousCwd=process.cwd();
  let changed=0;
  const wait=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setTimeout(r,10));assert.ok(predicate(),'timeout waiting for the integrated flow');await h.flush();};
  try{
    process.chdir(fileURLToPath(new URL(process.env.PLENNA_MOBILE_URL)));
    h.mount(h.load(fileURLToPath(new URL('src/components/PurchaseComponents/AnaliseCompra/index.js',process.env.PLENNA_MOBILE_URL))).default,{compraId:1,revisao:1,revisaoEventos:0,eventos:[],onDecisaoSalva:()=>changed++});
    await wait(()=>h.nodes(n=>n.props.accessibilityRole==='radio').length===3);
    const radios=()=>h.nodes(n=>n.props.accessibilityRole==='radio');radios()[0].props.onPress();await wait(()=>changed===1);
    assert.equal(purchase.compra_classificacao,'IMPULSIVA');assert.equal(events.length,1);
    const current=(await request('/v2/compras/1/eventos')).data;
    assert.equal(current.resumo.classificacao,'IMPULSIVA');
    h.update({revisaoEventos:current.revisao,eventos:current.eventos,classificacaoDeclarada:current.resumo.classificacao});await h.flush();
    radios()[1].props.onPress();await wait(()=>changed===2);assert.equal(events.length,2);assert.equal(events[1].dados.resposta,'DISCORDO');assert.equal(purchase.compra_classificacao,'IMPULSIVA');
    assert.equal(purchase.compra_horario.toISOString(),'2026-10-05T12:00:00.000Z');
    abort.abort();await h.flush();assert.equal(radios().length,0);
  }finally{process.chdir(previousCwd);h.unmount();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
