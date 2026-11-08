import test from 'node:test';
import assert from 'node:assert/strict';

let historicalRows = [], references = [], currentLimit = 100, email = false;
const counters = {};
const count = key => { counters[key] = (counters[key] ?? 0) + 1; };
const purchase = (id, date, value) => ({ compra_id:id, usuario_id:1, compra_ativo:1,
  compra_status:'CONFIRMADA', compra_horario:new Date(date), compra_valor:value,
  compra_email:false, compra_recorrencia_id:null,
  tb_compra_item:[{compra_item_id:id, categoria_id:1, tb_categoria:{categoria_nome:'Categoria'}}] });
const target = () => ({...purchase(900,'2026-10-15T12:00:00Z','450'),compra_email:email});
const ref = (id, date, value=100) => ({ referencia_id:id, tipo:'LIMITE_COMPRA',
  categoria_id:null, valor:value, vigente_desde:new Date(date), aplicacao:'AGORA', periodo:null });
const db = {
  tb_usuario:{findFirst:async()=>{count('usuario'); return {usuario_meta_valor_mensal:null,
    usuario_meta_valor_compra:currentLimit, usuario_data_criacao:new Date('2026-10-20T12:00:00Z')};}},
  tb_compra:{findFirst:async()=>{count('alvo');return target();},
    findMany:async({where})=>{count('historico');assert.equal(where.usuario_id,1);
      return historicalRows.filter(r=>r.compra_horario>=where.compra_horario.gte && r.compra_horario<where.compra_horario.lt);}},
  tb_compra_evento:{findMany:async()=>{count('eventos');return [];}},
  tb_referencia_financeira:{findMany:async({where})=>{count('referencias');assert.deepEqual(where,{usuario_id:1,tipo:'LIMITE_COMPRA'});return references;}},
  contexto_compra_revisao:{findFirst:async()=>{count('contexto');throw Error('OPTIONAL_CONTEXT_UNAVAILABLE');}},
  $transaction:async fn=>fn(db),
};
globalThis.prismaRuntime = {client:db,pool:{end:async()=>{}}};
const {AnaliseAutomaticaService} = await import('../../src/modules/analise/analise-automatica.service.ts');
const {avaliarAutomaticamente: avaliar} = await import('../../src/modules/analise/analise-automatica.engine.ts');
const {referenciaNaData} = await import('../../src/modules/compra/referencias.service.ts');
const now = new Date('2026-11-07T12:00:00Z');
function reset() { historicalRows=[];references=[];currentLimit=100;email=false;for(const k of Object.keys(counters))delete counters[k]; }
const row = (id,value,extra={}) => ({id,usuarioId:1,ativa:true,status:'CONFIRMADA',
  data:`2026-09-${String(id).padStart(2,'0')}T12:00:00Z`,precisao:'DIA',valorLiquido:value,
  origem:'MANUAL',categorias:[1],categoriasCompletas:true,itensAtivos:[],recorrenciaId:null,contexto:null,...extra});
const raw = compras => ({usuarioId:1,periodo:'2026-10',mesesHistorico:6,
  observadoAte:'2026-10-15T03:00:00Z',orcamentoAtual:null,compras});
const alvo = extra => row(900,'450',{data:'2026-10-15T12:00:00Z',...extra});

test('uma a quatro compras totais não inventam amostra; quatro referências variáveis permitem evidência',()=>{
  for(let total=1;total<=4;total++){
    const r=avaliar(raw(Array.from({length:total-1},(_,i)=>row(i+1,String((i+1)*10)))),alvo());
    assert.equal(r.estado,'DADOS_INSUFICIENTES');assert.equal(r.qualidadeDados.registrosComparados,1);
    assert.ok(r.qualidadeDados.criteriosIndisponiveis.includes('V01:AMOSTRA_MENOR_QUE_QUATRO'));
  }
  const r=avaliar(raw([10,20,30,40].map((v,i)=>row(i+1,String(v)))),alvo());
  assert.equal(r.estado,'SINAIS_RELEVANTES');assert.equal(r.evidencias.find(e=>e.indicador==='V01').amostra,4);
});
test('valores iguais, ausentes e categorias múltiplas preservam motivos e evidência independente',()=>{
  const equal=avaliar(raw([1,2,3,4].map(id=>row(id,'10'))),alvo());
  assert.ok(equal.qualidadeDados.criteriosIndisponiveis.includes('V01:FAIXA_SEM_DISPERSAO'));
  const missing=avaliar(raw([1,2,3,4].map(id=>row(id,null))),alvo());
  assert.equal(missing.estado,'DADOS_INSUFICIENTES');
  const r=avaliar(raw([10,20,30,40].map((v,i)=>row(i+1,String(v)))),alvo({categorias:[1,2]}));
  assert.equal(r.estado,'SINAIS_RELEVANTES');assert.ok(r.evidencias.some(e=>e.indicador==='V01'));
  assert.ok(r.qualidadeDados.criteriosIndisponiveis.includes('V01_CATEGORIA:CATEGORIA_INCOMPLETA_OU_MULTIPLA'));
});
test('janelas parciais equivalentes não exigem mês inteiro, mas exigem cobertura completa',()=>{
  const compras=[row(1,'10'),row(2,'20',{data:'2026-10-02T12:00:00Z'}),row(3,'30',{data:'2026-10-03T12:00:00Z'})];
  const partial=avaliar(raw(compras),alvo({valorLiquido:null}));
  assert.ok(!partial.evidencias.some(e=>e.indicador==='F05'));
  const complete=avaliar({...raw(compras),cobertura:'COMPLETA'},alvo({valorLiquido:null}));
  assert.equal(complete.evidencias.find(e=>e.indicador==='F05').sinal,true);
  assert.equal(complete.classificacaoAutomaticaDefinitiva,false);
});
test('período sem compra atual permanece insuficiente mesmo com referência histórica',()=>{
  const r=avaliar(raw([10,20,30,40].map((v,i)=>row(i+1,String(v)))));
  assert.equal(r.estado,'DADOS_INSUFICIENTES');assert.equal(r.qualidadeDados.registrosComparados,0);
});
test('V03 recupera versão anterior ao dia e rejeita mudança no mesmo dia civil',()=>{
  const old=ref(1,'2026-10-10T12:00:00Z');
  assert.equal(referenciaNaData([old],'LIMITE_COMPRA',target().compra_horario),old);
  for(const instant of ['2026-10-15T03:00:00Z','2026-10-16T02:59:59Z'])
    assert.equal(referenciaNaData([ref(2,instant),old],'LIMITE_COMPRA',target().compra_horario),null);
  assert.equal(referenciaNaData([ref(2,'2026-10-16T03:00:00Z'),old],'LIMITE_COMPRA',target().compra_horario),old);
});
test('serviço conserva limite histórico isolado, sem questionário e anterior à criação da conta',async()=>{
  reset();references=[ref(1,'2026-10-10T12:00:00Z')];
  const r=await AnaliseAutomaticaService.compra(1,900,now);
  assert.equal(r.estado,'SINAIS_RELEVANTES');assert.deepEqual(r.evidencias.map(e=>e.indicador),['V03']);
  assert.equal(r.contextoDeclarado.disponibilidade,'INDISPONIVEL');assert.equal(r.persistido,false);
  assert.equal(r.classificacaoAutomaticaDefinitiva,false);
});
test('serviço não usa limite atual para suprir ausência, inconsistência ou alteração no mesmo dia',async()=>{
  for(const scenario of ['ausente','mesmo-dia','inconsistente','zero','email']){
    reset();references=scenario==='ausente'?[]:[ref(1,scenario==='mesmo-dia'?'2026-10-15T20:00:00Z':'2026-10-10T12:00:00Z',scenario==='zero'?0:100)];
    if(scenario==='inconsistente')currentLimit=200;
    if(scenario==='zero')currentLimit=0;
    if(scenario==='email')email=true;
    const r=await AnaliseAutomaticaService.compra(1,900,now);
    assert.equal(r.estado,'DADOS_INSUFICIENTES',scenario);assert.ok(!r.evidencias.some(e=>e.indicador==='V03'));
  }
});
test('importações anteriores à conta participam do valor sem inventar cobertura ou duplicar consultas',async()=>{
  const results=[];
  for(const size of [4,3000]){
    reset();email=true;
    historicalRows=Array.from({length:size},(_,i)=>purchase(i+10000,'2026-09-10T12:00:00Z',String((i%4+1)*10)));
    const r=await AnaliseAutomaticaService.compra(1,900,now);
    assert.equal(r.estado,'SINAIS_RELEVANTES');assert.equal(r.qualidadeDados.cobertura,'DESCONHECIDA');
    assert.ok(!r.evidencias.some(e=>e.indicador==='F05'||e.indicador==='V03'));
    assert.equal(r.evidencias.find(e=>e.indicador==='V01').amostra,size);
    assert.doesNotMatch(JSON.stringify(r),/usuarioId|Categoria|itensAtivos/);
    results.push({...counters});
  }
  assert.deepEqual(results[0],results[1]);
});
