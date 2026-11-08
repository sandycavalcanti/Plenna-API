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

test('F10: o último item com evento financeiro não pode contornar a proteção de exclusão', async () => {
  const { CompraService } = await import('../../src/modules/compra/compra.service.ts');
  let writes = 0;
  const db = {
    $queryRaw: async () => [],
    tb_compra: { findFirst: async () => ({ compra_id: 1, compra_valor: 100 }), update: async () => { writes++; } },
    tb_compra_item: { findFirst: async () => ({ compra_item_id: 2 }), count: async () => 1,
      updateMany: async () => { writes++; } },
    tb_compra_evento: { findMany: async () => [{ evento_id: 1, compra_item_id: 2, tipo: 'REEMBOLSO',
      revisao: 1, corrige_evento_id: null, anulado: false, dados: { valorCentavos: 5000 } }] },
  };
  await assert.rejects(CompraService.deleteItem(7, 1, 2, db), error => error.statusCode === 409);
  assert.equal(writes, 0);
});

test('F07: datas civis de reembolso permanecem no mês efetivo, inclusive nas fronteiras', async () => {
  eventos = ['2026-10-31', '2026-11-01', '2026-11-30', '2026-12-01'].map((dia, index) => ({
    evento_id: index + 1,
    compra_id: index + 1,
    compra_item_id: null,
    tipo: 'REEMBOLSO',
    dados: { valorCentavos: 5000 },
    revisao: 1,
    corrige_evento_id: null,
    anulado: false,
    efetiva_em: new Date(`${dia}T00:00:00Z`),
    compra: { compra_horario: new Date('2026-10-20T12:00:00Z'), compra_valor: 100 },
  }));
  assert.equal((await EventosResumoService.consultar(7, '2026-10')).reembolsadoCentavos, 5000);
  assert.equal((await EventosResumoService.consultar(7, '2026-11')).reembolsadoCentavos, 10000);
  assert.equal((await EventosResumoService.consultar(7, '2026-12')).reembolsadoCentavos, 5000);
});

test('F23: excluir item não presume quantidade importada nem persiste total fabricado', async () => {
  const { CompraService } = await import('../../src/modules/compra/compra.service.ts');
  let writes = 0;
  const db = {
    $queryRaw: async () => [],
    tb_compra: { findFirst: async () => ({ compra_id: 1, compra_valor: 100, compra_email: true }),
      update: async () => { writes++; } },
    tb_compra_item: { findFirst: async () => ({ compra_item_id: 2 }), count: async () => 2,
      findMany: async () => [{ compra_item_id: 3, compra_item_valor: 20, compra_item_quantidade: null }],
      update: async () => { writes++; } },
  };
  await assert.rejects(CompraService.deleteItem(7, 1, 2, db), error => error.statusCode === 409);
  assert.equal(writes, 0);
});

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
