import test from 'node:test';
import assert from 'node:assert/strict';
import { businessDateKey } from '../../src/modules/compra/financeiro.ts';
import { analisarHistorico } from '../../src/modules/analise/historico.engine.ts';
test('formatador compartilhado conserva viradas civis e transições históricas de São Paulo', () => {
  for (const [instant, expected] of [
    ['2026-11-01T02:59:59Z','2026-10-31'],['2026-11-01T03:00:00Z','2026-11-01'],
    ['2018-11-04T02:30:00Z','2018-11-03'],['2018-11-04T03:30:00Z','2018-11-04'],
    ['2019-02-17T02:30:00Z','2019-02-16'],['2019-02-17T03:00:00Z','2019-02-17'],
  ]) assert.equal(businessDateKey(new Date(instant)), expected);
});
test('memoização de dias pertence à análise, sem reutilizar identificadores entre contas', () => {
  const run = (usuarioId, data) => analisarHistorico({usuarioId,periodo:'2026-10',mesesHistorico:6,observadoAte:'2026-10-30T12:00:00Z',orcamentoAtual:null,compras:[{id:1,usuarioId,ativa:true,status:'CONFIRMADA',data,precisao:'DIA',valorLiquido:'10',origem:'MANUAL',categorias:[],categoriasCompletas:false,itensAtivos:[],recorrenciaId:null,contexto:null}]});
  const first=run(1,'2026-10-10T12:00:00Z'), second=run(2,'2026-10-20T12:00:00Z');
  assert.notDeepEqual(first.frequencia.distribuicaoDiaria,second.frequencia.distribuicaoDiaria);
  assert.deepEqual(run(1,'2026-10-10T12:00:00Z'),first);
});
