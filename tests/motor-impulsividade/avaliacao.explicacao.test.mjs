import test from 'node:test';
import assert from 'node:assert/strict';
import {interpretarCompra} from '../../src/modules/analise/interpretacao.engine.ts';
import {explicarAvaliacaoPersistida} from '../../src/modules/analise/avaliacao.explicacao.ts';

const run=(extra={})=>interpretarCompra({compraId:1,ativa:true,status:'CONFIRMADA',valor:'100',limite:'80',contextoRevisao:1,
  respostas:{planejamento:'PARCIALMENTE',influenciaPromocional:'SIM',necessidadeInesperada:'NAO',momento:'ADIADA',autopercepcaoImpulsividade:'SIM'},
  itens:[{itemId:10,ativo:true,nome:'Livro',planejamento:'SIM'},{itemId:11,ativo:true,nome:'Caderno',planejamento:'NAO'}],...extra});

test('explicação conserva oito regras, múltiplas declarações e natureza calculada do financeiro',()=>{
  const r=run(),before=structuredClone(r),e=explicarAvaliacaoPersistida(r,1);
  assert.equal(new Set(e.regrasAplicadas.map(rule=>rule.codigo)).size,8);
  assert.deepEqual(e.regrasAplicadas.map(rule=>rule.codigo),r.regrasAplicadas.map(rule=>rule.codigo));
  for(const field of ['planejamento','influenciaPromocional','necessidadeInesperada','momento','autopercepcaoImpulsividade'])
    assert.ok(e.fatores.some(f=>f.natureza==='DECLARADO'&&f.campo===field));
  assert.equal(e.fatores.filter(f=>f.campo==='planejamentoItem').length,2);
  assert.ok(e.fatores.some(f=>f.codigo==='LIMITE_EXCEDIDO'&&f.natureza==='INTERPRETADO'));
  assert.equal(e.fatores.filter(f=>f.natureza==='REGISTRADO').length,r.evidencias.filter(f=>f.natureza==='REGISTRADO').length);
  assert.deepEqual(e.limitacoes,r.limitacoes);assert.deepEqual(r,before);
  assert.equal('classificacao' in e,false);assert.equal('probabilidade' in e,false);
});

test('ausência de limite preserva contexto e respostas incertas mantêm seu significado',()=>{
  const r=run({limite:null}),e=explicarAvaliacaoPersistida(r,1);
  assert.ok(e.limitacoes.includes('LIMITE_INDISPONIVEL'));
  assert.ok(e.fatores.some(f=>f.campo==='planejamento'));assert.ok(e.reflexao);
  const uncertain=explicarAvaliacaoPersistida(run({limite:null,respostas:{planejamento:'NAO_LEMBRO',influenciaPromocional:'PREFIRO_NAO_RESPONDER'},itens:[]}),1);
  assert.equal(uncertain.reflexao,null);
  assert.deepEqual(uncertain.fatores.filter(f=>f.natureza==='DECLARADO').map(f=>f.valor),['NAO_LEMBRO','PREFIRO_NAO_RESPONDER']);
});

test('resultados antigos não são reconstruídos e prévia não descarta acesso aos fatores restantes',()=>{
  const r=run();r.versaoMotor='contextual-1';
  assert.equal(explicarAvaliacaoPersistida(r,1).resumo,r.interpretacao.mensagem);
  assert.equal(explicarAvaliacaoPersistida({},1),null);
  assert.equal(explicarAvaliacaoPersistida(r,2),null);
  const full=explicarAvaliacaoPersistida(r,1),preview=explicarAvaliacaoPersistida(r,1,true);
  assert.equal(preview.fatores.length,3);assert.equal(preview.totalFatores,full.fatores.length);
  assert.equal(preview.fatoresCompletos,false);assert.equal(full.fatoresCompletos,true);
});
