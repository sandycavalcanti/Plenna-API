import test from 'node:test';
import assert from 'node:assert/strict';
import { validarEventoFinanceiro } from '../../src/modules/compra/eventos.engine.ts';
import { descobrirCompra } from '../../src/modules/analise/descobertas.engine.ts';
import { analisarHistorico } from '../../src/modules/analise/historico.engine.ts';
import { interpretarCompra } from '../../src/modules/analise/interpretacao.engine.ts';

let eventos = [];
const client = {
  tb_compra_evento: { findMany: async () => eventos },
  $transaction: async (run) => run(client),
};
globalThis.prismaRuntime = { client, pool: { end: async () => {} } };
const { EventosResumoService } = await import('../../src/modules/compra/eventos.resumo.ts');

test('F22: o amanhã local é rejeitado mesmo depois da virada UTC', () => {
  const compra = { valorCentavos: 10000, itens: [] };
  const evento = { tipo: 'CANCELAMENTO', dataEfetiva: '2026-11-01', anulado: false };
  assert.throws(
    () => validarEventoFinanceiro(evento, [], compra, new Date('2026-11-01T00:30:00Z')),
    (error) => error.statusCode === 400,
  );
  assert.doesNotThrow(() => validarEventoFinanceiro(evento, [], compra, new Date('2026-11-01T03:00:00Z')));
});

test('F48: Natal segue o dia de São Paulo, sem atribuir motivo à compra', () => {
  const historico = analisarHistorico({
    usuarioId: 7, periodo: '2026-12', mesesHistorico: 6,
    observadoAte: '2026-12-24T03:00:00Z', orcamentoAtual: null, compras: [],
  });
  const contextual = interpretarCompra({
    compraId: 1, ativa: true, status: 'CONFIRMADA', valor: '100', limite: null,
    contextoRevisao: 0, respostas: {}, itens: [],
  });
  const descobrir = (data) => descobrirCompra({
    historico, compras: [], contextual,
    compra: { id: 1, data, email: false, valorCentavos: 10000, limiteAtualCentavos: null, recorrenciaId: null },
  });
  assert.equal(descobrir('2026-12-25T01:00:00Z').itens.some((i) => i.codigo === 'DATA_COMERCIAL'), false);
  const natal = descobrir('2026-12-26T01:00:00Z').itens.find((i) => i.codigo === 'DATA_COMERCIAL');
  assert.match(natal.titulo, /Natal/);
  assert.match(natal.detalhe, /não indica influência/);
  assert.deepEqual(descobrir('2026-12-25T22:00:00-03:00'), descobrir('2026-12-26T01:00:00Z'));
});
