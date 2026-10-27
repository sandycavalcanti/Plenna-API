import test from 'node:test';
import assert from 'node:assert/strict';
import { analisarPeriodo, analisarCompra } from '../../src/modules/analise/comportamento.engine.ts';
import { recomendar } from '../../src/modules/recomendacao/recomendacao.engine.ts';
const row = (extra={})=>({id:1,usuarioId:1,ativa:true,status:'CONFIRMADA',horario:'2026-10-05T12:00:00Z',precisaoHorario:'APROXIMADO',valorLiquido:100,categorias:[2],origem:'MANUAL',referencias:['manual:1'],...extra});
const snapshot=(extra={})=>({versaoContrato:1,usuarioId:1,janela:{periodo:'2026-10',observadoAte:'2026-10-11T00:00:00Z',cobertura:'COMPLETA'},compras:[row()],limiteIndividual:{valor:80,vigencia:'ATUAL_SEM_HISTORICO',referencia:'limite:atual'},orcamentoMensal:{valor:200,vigencia:'ATUAL_SEM_HISTORICO',referencia:'orcamento:atual'},...extra});
const period=(extra={})=>analisarPeriodo(snapshot(extra));

test('atenção removida não gera recomendação individual; orçamento e fatos permanecem',()=>{
 const data=snapshot({compras:[row({valorLiquido:250})],limiteIndividual:{valor:null,vigencia:'ATUAL_SEM_HISTORICO',referencia:'limite:atual'}});
 const before=structuredClone(data);
 const analysis=analisarPeriodo(data);
 assert.equal(analysis.indicadores.limiteIndividual.disponibilidade,'INDISPONIVEL');
 assert.equal(analysis.indicadores.limiteIndividual.limiteCentavos,null);
 assert.deepEqual(analysis.indicadores.limiteIndividual.desvios,[]);
 const recommendations=recomendar(analysis).recomendacoes;
 assert.ok(!recommendations.some(r=>r.codigo==='REVISAR_LIMITE_INDIVIDUAL'));
 assert.ok(recommendations.some(r=>r.codigo==='ACOMPANHAR_ORCAMENTO_EXCEDIDO'));
 assert.equal(analisarCompra({...data,compraId:1}).excessoLimiteCentavos,null);
 assert.deepEqual(data,before);
});
test('known individual excess emits evidence-backed recommendation',()=>{
 const r=recomendar(period());assert.equal(r.recomendacoes.length,1);assert.equal(r.recomendacoes[0].codigo,'REVISAR_LIMITE_INDIVIDUAL');assert.ok(r.recomendacoes[0].referencias.includes('compra:1'));assert.match(r.recomendacoes[0].mensagem,/atualmente/);
});
test('exact limit has no recommendation and no arbitrary budget proximity threshold',()=>{
 assert.equal(recomendar(period({compras:[row({valorLiquido:80})]})).estado,'SEM_RECOMENDACOES_ELEGIVEIS');
 const r=recomendar(period({compras:[row({valorLiquido:199})],limiteIndividual:{valor:null,vigencia:'ATUAL_SEM_HISTORICO',referencia:'limite'}}));assert.equal(r.recomendacoes.length,0);
});
test('known exceeded budget emits priority one; unknown budget cannot',()=>{
 assert.equal(recomendar(period({compras:[row({valorLiquido:250})]})).recomendacoes[0].codigo,'ACOMPANHAR_ORCAMENTO_EXCEDIDO');
 assert.ok(!recomendar(period({orcamentoMensal:{valor:null,vigencia:'ATUAL_SEM_HISTORICO',referencia:'orcamento'}})).recomendacoes.some(r=>r.codigo==='ACOMPANHAR_ORCAMENTO_EXCEDIDO'));
});
test('partial values permit proven excess with explicit lower-bound wording and limitation',()=>{
 const r=recomendar(period({compras:[row({valorLiquido:250}),row({id:2,valorLiquido:null})]}));
 assert.match(r.recomendacoes[0].mensagem,/total conhecido/);assert.ok(r.recomendacoes[0].limitacoes.includes('TOTAL_CONHECIDO_NAO_REPRESENTA_CONSUMO_COMPLETO'));
 assert.ok(!recomendar(period({compras:[row({valorLiquido:null})]})).recomendacoes.length);
});
test('partial coverage does not claim complete consumption',()=>{
 const r=recomendar(period({janela:{periodo:'2026-10',observadoAte:'2026-10-11T00:00:00Z',cobertura:'PARCIAL'},compras:[row({valorLiquido:250})]}));
 assert.ok(r.recomendacoes.every(r=>r.limitacoes.includes('COBERTURA_NAO_COMPLETA')));
});
test('predominant category and few categorized purchases stay disabled without parameters',()=>{
 for(const n of [1,10]) {
  const r=recomendar(period({compras:Array.from({length:n},(_,i)=>row({id:i+1,valorLiquido:1})),limiteIndividual:{valor:null,vigencia:'ATUAL_SEM_HISTORICO',referencia:'limite'}}));
  assert.equal(r.recomendacoes.length,0);assert.ok(r.regrasDesativadas.includes('CONCENTRACAO_CATEGORIA_SEM_PARAMETROS_APROVADOS'));
 }
});
test('many excess purchases produce one grouped limit recommendation, deterministic order and max three',()=>{
 const data=period({compras:Array.from({length:20},(_,i)=>row({id:i+1,valorLiquido:250}))}); const before=structuredClone(data);
 const r=recomendar(data);assert.deepEqual(r,recomendar(data));assert.deepEqual(data,before);assert.equal(r.recomendacoes.length,2);assert.ok(r.recomendacoes.length<=3);assert.deepEqual(r.recomendacoes.map(r=>r.prioridade),[1,2]);assert.equal(new Set(r.recomendacoes.map(r=>r.codigo)).size,r.recomendacoes.length);
});
test('missing evidence suppresses; unknown provenance is not verified evidence',()=>{
 const data=period({compras:[row({valorLiquido:250})]});data.evidencias=[];assert.equal(recomendar(data).recomendacoes.length,0);
 assert.equal(recomendar(period({compras:[row({origem:'DESCONHECIDA',valorLiquido:250})]})).recomendacoes.length,0);
});
test('empty successful result differs from malformed/version mismatch failure',()=>{
 assert.equal(recomendar(period({compras:[]})).estado,'SEM_RECOMENDACOES_ELEGIVEIS');
 assert.throws(()=>recomendar({}));assert.throws(()=>recomendar({...period(),versaoContrato:2}));
});
test('specific eligible purchase supported, pending and unknown values suppressed',()=>{
 assert.equal(recomendar(analisarCompra({...snapshot(),compraId:1})).recomendacoes.length,1);
 for(const purchase of [row({status:'AGUARDANDO_CONFIRMACAO'}),row({valorLiquido:null}),row({valorLiquido:80})]) assert.equal(recomendar(analisarCompra({...snapshot({compras:[purchase]}),compraId:1})).recomendacoes.length,0);
});
test('no impulsivity labels, clinical judgments or current limits stated as historical',()=>{
 const r=recomendar(period({compras:[row({valorLiquido:250})]}));
 for(const rec of r.recomendacoes){assert.doesNotMatch(rec.titulo+' '+rec.mensagem,/impulsiv|diagn[oó]st|transtorno|causou/i);assert.ok(rec.limitacoes.includes('LIMITES_ATUAIS_SEM_VIGENCIA_HISTORICA'));}
});
test('period-valid limits use period wording instead of claiming current validity',()=>{
 const r=recomendar(period({compras:[row({valorLiquido:250})],limiteIndividual:{valor:80,vigencia:'DO_PERIODO',referencia:'limite:periodo'},orcamentoMensal:{valor:200,vigencia:'DO_PERIODO',referencia:'orcamento:periodo'}}));
 assert.ok(r.recomendacoes.every(r=>/período/.test(r.mensagem)));
});
