import test from 'node:test';
import assert from 'node:assert/strict';
const { resolverOrcamentoMensal, referenciaNaData } = await import('../../src/modules/compra/referencias.service.ts');
const now=new Date('2026-11-05T12:00:00Z');
const ref=(overrides={})=>({referencia_id:1,tipo:'ORCAMENTO_MENSAL',usuario_id:1,categoria_id:null,valor:1000,
  origem:'ALTERACAO_PERFIL',aplicacao:'REFERENCIA_ATUAL',periodo:'2026-10',vigente_desde:new Date('2026-10-26T12:00:00Z'),registrada_em:new Date('2026-10-26T12:00:00Z'),...overrides});
function tx(rows){return {$queryRaw:async()=>[{tabela:'public.tb_referencia_financeira'}],tb_referencia_financeira:{findFirst:async({where})=>rows.filter(r=>r.usuario_id===where.usuario_id&&r.tipo===where.tipo&&r.categoria_id===null&&r.vigente_desde<where.vigente_desde.lt&&r.registrada_em<=where.registrada_em.lte).sort((a,b)=>b.vigente_desde-a.vigente_desde||b.referencia_id-a.referencia_id)[0]??null}};}
test('retrospectiva usa última observação própria no mês, sem aplicar novembro a outubro',async()=>{
 const rows=[ref(),ref({referencia_id:2,valor:2000,vigente_desde:new Date('2026-10-30T12:00:00Z'),registrada_em:new Date('2026-10-30T12:00:00Z')}),ref({usuario_id:2,valor:9999}),ref({periodo:'2026-11',vigente_desde:new Date('2026-11-02T12:00:00Z'),registrada_em:new Date('2026-11-02T12:00:00Z')})];
 const r=await resolverOrcamentoMensal(tx(rows),1,'2026-10',now);assert.equal(r.valor,2000);assert.equal(r.vigencia,'REFERENCIA_OBSERVADA');assert.equal(r.motivo,'COBERTURA_HISTORICA_PARCIAL');
 assert.equal(referenciaNaData(rows,'LIMITE_COMPRA',new Date('2026-10-05T12:00:00Z')),null);
});
test('continuidade explícita nova; legado não preenche mês seguinte',async()=>{
 assert.equal((await resolverOrcamentoMensal(tx([ref()]),1,'2026-11',now)).valor,null);
 assert.equal((await resolverOrcamentoMensal(tx([ref({origem:'PERFIL_CONTINUO'})]),1,'2026-11',now)).vigencia,'CONTINUIDADE_COMPROVADA');
});
test('metadados inválidos, origem desconhecida e desativação não ressuscitam referência anterior',async()=>{
 for(const change of [{origem:'DESCONHECIDA'},{periodo:'2026-09'},{registrada_em:new Date('2026-11-01T12:00:00Z')},{valor:null},{valor:0}]){
  assert.equal((await resolverOrcamentoMensal(tx([ref(),ref({referencia_id:2,...change})]),1,'2026-10',now)).valor,null);
 }
});
test('virada local exclui referência de novembro e preserva MES_INTEIRO',async()=>{
 const r=await resolverOrcamentoMensal(tx([ref({aplicacao:'MES_INTEIRO'}),ref({referencia_id:2,periodo:'2026-11',vigente_desde:new Date('2026-11-01T03:00:00Z'),registrada_em:new Date('2026-11-01T03:00:00Z')})]),1,'2026-10',now);
 assert.equal(r.vigencia,'MES_COMPROVADO');
});
