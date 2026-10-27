import test from 'node:test';
import assert from 'node:assert/strict';
import { analisarHistorico } from '../../src/modules/analise/historico.engine.ts';
import { coberturaMonitoramento } from '../../src/modules/analise/politica-temporal.ts';
const row = (id, data, extra = {}) => ({
  id,
  usuarioId: 1,
  ativa: true,
  status: 'CONFIRMADA',
  data,
  precisao: 'DIA',
  origem: 'MANUAL',
  valorLiquido: '50',
  categorias: [1],
  recorrenciaId: null,
  contexto: null,
  ...extra,
});
const run = (compras, extra = {}) =>
  analisarHistorico({
    usuarioId: 1,
    periodo: '2026-10',
    observadoAte: '2026-10-15T00:00:00Z',
    inicioObservacao: '2026-09-01T00:00:00Z',
    orcamentoAtual: null,
    compras,
    ...extra,
  });

test('A: search beginning in April is distinct from available October records', () => {
  const h = run([row(1, '2026-10-02T00:00:00Z')]);
  assert.match(h.politicaTemporal.solicitado.inicio, /2026-04/);
  assert.equal(h.politicaTemporal.compras.disponivel.inicio, '2026-10-02');
  assert.equal(h.politicaTemporal.compras.continuidadeComprovada, false);
});
test('B: eligible imports before account creation retain origin and message-date limitations', () => {
  const h = run([
    row(1, '2026-07-02T00:00:00Z', {
      origem: 'EMAIL',
      referenciaData: 'MENSAGEM_EMAIL',
      registradaEm: '2026-10-01T00:00:00Z',
    }),
  ]);
  assert.equal(h.qualidade.comprasHistorico, 1);
  assert.equal(h.politicaTemporal.compras.disponivel.inicio, '2026-07-02');
  assert.equal(h.politicaTemporal.compras.datasDeMensagemEmail, 1);
  assert.deepEqual(h.politicaTemporal.compras.origens, ['EMAIL']);
});
test('C/F: unknown or partial coverage cannot generate an increase against unknown empty months', () => {
  for (const cobertura of ['DESCONHECIDA', 'PARCIAL']) {
    const h = run([row(1, '2026-10-02T00:00:00Z')], { cobertura });
    assert.equal(h.frequencia.comparacao.disponibilidade, 'INDISPONIVEL');
    assert.equal(h.frequencia.comparacao.diferenca, null);
    assert.equal(h.frequencia.periodos[0].temRegistros, false);
    assert.equal(h.frequencia.periodos[0].comprasPorDia, null);
    assert.equal(h.categorias[0].comparacao.variacaoRelativa, null);
  }
});
test('D: planning availability follows known declarations, not earliest purchase', () => {
  const h = run([
    row(1, '2026-07-02T00:00:00Z'),
    row(2, '2026-10-02T00:00:00Z', {
      contexto: { revisao: 1, respostas: { planejamento: 'SIM' }, itens: [] },
    }),
    row(3, '2026-10-03T00:00:00Z', {
      contexto: {
        revisao: 1,
        respostas: { planejamento: 'PREFIRO_NAO_RESPONDER' },
        itens: [],
      },
    }),
  ]);
  assert.equal(h.politicaTemporal.planejamento.disponivel.inicio, '2026-10-02');
  assert.equal(h.planejamento.historico.ausentes, 1);
  assert.equal(h.planejamento.historico.contagens.NAO, 0);
  assert.equal(h.planejamento.conhecidas, 1);
  assert.equal(h.planejamento.recusadas, 1);
  assert.equal(h.politicaTemporal.influenciaPromocional.disponivel, null);
});
test('E: October authorized collection does not imply zero usage in July; ANALISE adds no Android association', () => {
  const result = coberturaMonitoramento(
    Date.parse('2026-07-01'),
    Date.parse('2026-08-01'),
    [
      {
        inicio: Date.parse('2026-10-01'),
        fim: Date.parse('2026-10-02'),
        autorizado: true,
        valido: true,
      },
    ],
  );
  assert.equal(result.disponibilidade, 'INDISPONIVEL');
  assert.equal(result.tempoUso, null);
  assert.equal(result.diasComCobertura, null);
  const h = run([row(1, '2026-07-02T00:00:00Z')]);
  assert.equal(h.politicaTemporal.associacaoAplicativosCompras, 'INDISPONIVEL');
});
test('G: approximate dates excluded; email timestamps never prove exact transaction intervals', () => {
  const h = run([
    row(1, '2026-07-02T00:00:00Z', { precisao: 'APROXIMADA' }),
    row(2, '2026-10-02T01:00:00Z', {
      origem: 'EMAIL',
      precisao: 'INSTANTE',
      referenciaData: 'MENSAGEM_EMAIL',
    }),
    row(3, '2026-10-02T02:00:00Z', {
      origem: 'EMAIL',
      precisao: 'INSTANTE',
      referenciaData: 'MENSAGEM_EMAIL',
    }),
  ]);
  assert.equal(h.qualidade.semDataOuPrecisao, 1);
  assert.equal(h.qualidade.comprasHistorico, 0);
  assert.equal(h.intervalos.pares[0].segundosExatos, null);
  assert.equal(h.politicaTemporal.compras.precisao, 'DIA_OU_INSUFICIENTE');
});
test('verified complete coverage permits equivalent-window comparisons including a known empty window', () => {
  const h = run([row(1, '2026-10-02T00:00:00Z')], { cobertura: 'COMPLETA' });
  assert.equal(h.frequencia.comparacao.disponibilidade, 'DISPONIVEL');
  assert.equal(h.frequencia.comparacao.diferenca, 1);
});
