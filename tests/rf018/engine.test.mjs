import test from 'node:test';
import assert from 'node:assert/strict';
import { analisarPeriodo, analisarCompra } from '../../src/modules/rf018/rf018.engine.ts';
import { estadosAvaliacao, saidaPeriodoSchema, saidaCompraSchema } from '../../src/modules/rf018/rf018.schemas.ts';
const purchase = (extra = {}) => ({ id: 1, usuarioId: 1, ativa: true, status: 'CONFIRMADA', horario: '2026-10-05T12:00:00Z', precisaoHorario: 'APROXIMADO', valorLiquido: '100.00', categorias: [2], origem: 'MANUAL', referencias: ['manual:1'], ...extra });
const input = (extra = {}) => ({ versaoContrato: 1, usuarioId: 1, janela: { periodo: '2026-10', observadoAte: '2026-10-11T00:00:00Z', cobertura: 'COMPLETA' }, compras: [purchase()], limiteIndividual: { valor: 80, vigencia: 'ATUAL_SEM_HISTORICO', referencia: 'perfil:limite' }, orcamentoMensal: { valor: 200, vigencia: 'ATUAL_SEM_HISTORICO', referencia: 'perfil:orcamento' }, ...extra });
test('deterministic, schema validated and input immutable', () => {
 const data = input(); const before = structuredClone(data);
 assert.deepEqual(analisarPeriodo(data), analisarPeriodo(data)); assert.deepEqual(data, before);
 assert.equal(saidaPeriodoSchema.safeParse(analisarPeriodo(data)).success, true);
});
test('only confirmed active within UTC month and observed half-open window', () => {
 const result = analisarPeriodo(input({ compras: [purchase(),purchase({id:2,status:'AGUARDANDO_CONFIRMACAO'}),purchase({id:3,ativa:false}),purchase({id:4,status:'IGNORADA'}),purchase({id:5,horario:'2026-10-11T00:00:00Z'}),purchase({id:6,horario:'2026-09-30T23:59:59Z'})] }));
 assert.equal(result.indicadores.frequencia.compras,1); assert.equal(result.indicadores.frequencia.comprasPorDia,.1);
});
test('known zero is distinct from unknown and partial total does not assume missing value zero', () => {
 const r=analisarPeriodo(input({compras:[purchase({valorLiquido:0}),purchase({id:2,valorLiquido:null})]}));
 assert.equal(r.indicadores.financeiro.qualidade,'PARCIAL'); assert.equal(r.indicadores.financeiro.comprasComValor,1);
 assert.equal(r.indicadores.financeiro.estadoOrcamento,'INDETERMINADO');
 const unknown=analisarPeriodo(input({compras:[purchase({valorLiquido:null})]})); assert.equal(unknown.indicadores.financeiro.total,null);
});
test('multicategory counts distinct purchases once per category, deduplicates item categories', () => {
 const r=analisarPeriodo(input({compras:[purchase({categorias:[2,2,3]}),purchase({id:2,categorias:[3]}),purchase({id:3,categorias:[]})]}));
 assert.deepEqual(r.indicadores.categorias.grupos,[{categoriaId:2,compras:1,participacao:.5},{categoriaId:3,compras:2,participacao:1}]);
 assert.equal(r.indicadores.categorias.comprasSemCategoria,1); assert.equal(r.indicadores.categorias.disponibilidade,'PARCIAL');
});
test('missing history is unavailable, not a zero baseline', () => {
 const c=analisarPeriodo(input()).indicadores.comparacao; assert.equal(c.comprasAnterior,null); assert.equal(c.diferenca,null);
});
const previous = (rows=[], extra={}) => ({janela:{periodo:'2026-09',observadoAte:'2026-09-11T00:00:00Z',cobertura:'COMPLETA'},coberturaComparavel:true,compras:rows,...extra});
test('equivalent windows compare without four-week history requirement', () => {
 const c=analisarPeriodo(input({compras:[purchase(),purchase({id:2})],anterior:previous([purchase({id:3,horario:'2026-09-05T12:00:00Z'})])})).indicadores.comparacao;
 assert.equal(c.disponibilidade,'DISPONIVEL'); assert.equal(c.diferenca,1); assert.equal(c.variacaoRelativa,1);
});
test('complete empty previous snapshot permits difference but never division by zero', () => {
 const c=analisarPeriodo(input({anterior:previous()})).indicadores.comparacao; assert.equal(c.diferenca,1); assert.equal(c.variacaoRelativa,null);
});
test('unknown or unequal previous coverage blocks comparison', () => {
 for(const prev of [previous([],{coberturaComparavel:false}),previous([],{janela:{periodo:'2026-09',observadoAte:'2026-09-12T00:00:00Z',cobertura:'COMPLETA'}})]) {
  assert.equal(analisarPeriodo(input({anterior:prev})).indicadores.comparacao.disponibilidade,'INDISPONIVEL');
 }
});
test('individual limit, exact limit and missing limit', () => {
 const r=analisarPeriodo(input()); assert.equal(r.indicadores.limiteIndividual.desvios[0].excessoCentavos,2000);
 const c=analisarCompra({...input(),compraId:1}); assert.equal(c.excessoLimiteCentavos,2000); assert.equal(saidaCompraSchema.safeParse(c).success,true);
 assert.equal(analisarCompra({...input({limiteIndividual:{valor:null,vigencia:'ATUAL_SEM_HISTORICO',referencia:'limite'}}),compraId:1}).excessoLimiteCentavos,null);
 assert.equal(analisarCompra({...input({compras:[purchase({valorLiquido:80})]}),compraId:1}).excessoLimiteCentavos,0);
});
test('budget uses existing net-value rule and partial coverage remains explicit', () => {
 const r=analisarPeriodo(input({janela:{periodo:'2026-10',observadoAte:'2026-10-11T00:00:00Z',cobertura:'PARCIAL'},compras:[purchase({valorLiquido:250})]}));
 assert.equal(r.indicadores.financeiro.total,250); assert.equal(r.indicadores.financeiro.estadoOrcamento,'EXCEDIDO'); assert.equal(r.indicadores.orcamento.disponibilidade,'PARCIAL');
 assert.ok(r.limitacoes.includes('LIMITES_ATUAIS_SEM_VIGENCIA_HISTORICA'));
});
test('missing timestamps are not assigned to month and degrade availability', () => {
 const r=analisarPeriodo(input({compras:[purchase(),purchase({id:2,horario:null,precisaoHorario:'DESCONHECIDO'})]}));
 assert.equal(r.qualidade.comprasSemHorario,1); assert.equal(r.indicadores.frequencia.disponibilidade,'PARCIAL'); assert.equal(r.indicadores.frequencia.compras,1);
});
test('empty purchases distinct from behavioral conclusion', () => {
 const r=analisarPeriodo(input({compras:[]})); assert.equal(r.indicadores.financeiro.qualidade,'SEM_COMPRAS'); assert.equal(r.avaliacao.estado,'NAO_AVALIAVEL');
});
test('all five states preserved, no behavioral rules or classifications emitted', () => {
 assert.equal(estadosAvaliacao.options.length,5);
 for(const data of [input(),input({compras:[]}),input({compras:[purchase({valorLiquido:999999})]})]) {
  const r=analisarPeriodo(data);assert.deepEqual(r.avaliacao.regrasAplicadas,[]);assert.ok(!['POSSIVEL_IMPULSIVA','SEM_SINAIS_RELEVANTES'].includes(r.avaliacao.estado));
 }
 assert.equal(analisarCompra({...input({compras:[purchase({status:'AGUARDANDO_CONFIRMACAO'})]}),compraId:1}).avaliacao.estado,'NAO_AVALIAVEL');
});
test('cross-user and duplicate canonical IDs fail explicitly', () => {
 assert.throws(()=>analisarPeriodo(input({compras:[purchase({usuarioId:2})]})),/USER_MISMATCH/);
 assert.throws(()=>analisarPeriodo(input({compras:[purchase(),purchase()]})),/DUPLICATE/);
});
test('malformed periods, values, missing purchase and overlapping history refused', () => {
 assert.throws(()=>analisarPeriodo(input({compras:[purchase({valorLiquido:-1})]})));
 assert.throws(()=>analisarPeriodo(input({janela:{periodo:'2026-10',observadoAte:'2026-12-01T00:00:00Z',cobertura:'COMPLETA'}})),/INVALID_OBSERVATION/);
 assert.throws(()=>analisarPeriodo(input({anterior:previous([],{janela:input().janela})})),/OVERLAPPING/);
 assert.throws(()=>analisarCompra({...input(),compraId:9}),/NOT_IN_SNAPSHOT/);
});
test('optional RF017 disabled extension never changes indicators', () => {
 const a=analisarPeriodo(input()); const b=analisarPeriodo(input({rf017:{versaoContrato:1,utilizavel:false,disponibilidade:'SEM_AUTORIZACAO'}}));assert.deepEqual(a,b);
});
test('unknown date means insufficient evidence rather than empty observed month', () => {
 const data=input({compras:[purchase({horario:null,precisaoHorario:'DESCONHECIDO'})]});
 assert.equal(analisarPeriodo(data).avaliacao.estado,'DADOS_INSUFICIENTES');
 assert.equal(analisarCompra({...data,compraId:1}).avaliacao.estado,'DADOS_INSUFICIENTES');
});
test('missing budget and limit remain unavailable, not known zero thresholds', () => {
 const data=input({limiteIndividual:{valor:null,vigencia:'ATUAL_SEM_HISTORICO',referencia:'missing-limit'},orcamentoMensal:{valor:null,vigencia:'ATUAL_SEM_HISTORICO',referencia:'missing-budget'}});
 const r=analisarPeriodo(data);assert.equal(r.indicadores.financeiro.estadoOrcamento,'SEM_ORCAMENTO'); assert.equal(r.indicadores.orcamento.disponibilidade,'INDISPONIVEL');assert.equal(r.indicadores.limiteIndividual.limiteCentavos,null);
});
test('rounding comes from financeiro.ts and UTC boundary uses offsets', () => {
 const r=analisarPeriodo(input({compras:[purchase({valorLiquido:'100.005',horario:'2026-09-30T22:00:00-03:00'})]}));
 assert.equal(r.indicadores.financeiro.total,100.01);assert.equal(r.indicadores.limiteIndividual.desvios[0].excessoCentavos,2001);
});
test('historical comparison exposes references to previous evidence', () => {
 const r=analisarPeriodo(input({anterior:previous([purchase({id:9,horario:'2026-09-05T12:00:00Z',origem:'EMAIL',referencias:['email-derived:9']})])}));
 assert.ok(r.evidencias.some(e=>e.codigo==='COMPRA_ANTERIOR_9' && e.referencias.includes('compra:9')));
});
