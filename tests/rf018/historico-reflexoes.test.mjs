import test from 'node:test';
import assert from 'node:assert/strict';
import { analisarHistorico } from '../../src/modules/rf018/historico.engine.ts';
import { refletirHistorico } from '../../src/modules/rf018/historico.reflexoes.ts';
const row = (id, data = '2026-10-02T00:00:00Z', respostas = {}) => ({
  id,
  usuarioId: 1,
  ativa: true,
  status: 'CONFIRMADA',
  data,
  precisao: 'DIA',
  valorLiquido: '100',
  origem: 'MANUAL',
  categorias: [2],
  recorrenciaId: null,
  contexto: { revisao: 1, respostas, itens: [] },
});
const input = (compras) => ({
  usuarioId: 1,
  periodo: '2026-10',
  mesesHistorico: 6,
  observadoAte: '2026-10-05T00:00:00.000Z',
  orcamentoAtual: null,
  compras,
  recorrencias: [{ id: 1, status: 'ATIVA' }],
});
const value = {
  compraId: 99,
  amostra: 3,
  valorLiquidoCentavos: 15000,
  medianaHistoricaCentavos: 10000,
  disponibilidade: 'PARCIAL',
};
const run = (compras) =>
  refletirHistorico(analisarHistorico(input(compras)), compras, value);
test('seven evidence-bound reflection types preserve registered, declared and current configuration sources', () => {
  const rows = [
    row(1, undefined, { planejamento: 'SIM', influenciaPromocional: 'SIM' }),
    row(2, undefined, {
      planejamento: 'PARCIALMENTE',
      influenciaPromocional: 'NAO',
    }),
    row(3, '2026-09-02T00:00:00Z', { planejamento: 'NAO' }),
  ];
  const result = refletirHistorico(
    analisarHistorico({ ...input(rows), cobertura: 'COMPLETA' }),
    rows,
    value,
  );
  assert.equal(result.estado, 'COM_REFLEXOES');
  assert.deepEqual(
    result.itens.map((i) => i.codigo),
    [
      'FREQUENCIA',
      'DISTRIBUICAO',
      'VALORES',
      'CATEGORIAS',
      'PLANEJAMENTO',
      'PROMOCAO',
      'RECORRENCIAS',
    ],
  );
  assert.equal(
    result.itens.find((i) => i.codigo === 'PLANEJAMENTO').natureza,
    'DECLARADO',
  );
  assert.match(
    result.itens.find((i) => i.codigo === 'PROMOCAO').observacao,
    /1 de 2/,
  );
  assert.ok(
    result.itens
      .find((i) => i.codigo === 'VALORES')
      .referencias.includes('compra:99'),
  );
  assert.equal(result.itens.at(-1).natureza, 'CONFIGURACAO_ATUAL');
  assert.equal(result.score, undefined);
  assert.equal(result.classificacao, undefined);
  assert.ok(run(rows).limitacoes.includes('COBERTURA_NAO_COMPLETA'));
  assert.ok(!run(rows).itens.some((i) => i.codigo === 'FREQUENCIA'));
});
test('zero or one previous purchase never produces a historical trend or reflection', () => {
  for (const rows of [[], [row(1)]]) {
    const r = run(rows);
    assert.equal(r.estado, 'DADOS_INSUFICIENTES');
    assert.deepEqual(r.itens, []);
  }
});
test('missing refused and uncertain declarations are excluded; discounts never infer promotional influence', () => {
  const rows = [
    row(1),
    row(2, undefined, {
      planejamento: 'PREFIRO_NAO_RESPONDER',
      influenciaPromocional: 'NAO_LEMBRO',
    }),
    row(3, undefined, {
      planejamento: 'NAO_LEMBRO',
      influenciaPromocional: 'PREFIRO_NAO_RESPONDER',
    }),
  ];
  const r = run(rows);
  assert.ok(
    !r.itens.some((i) => ['PLANEJAMENTO', 'PROMOCAO'].includes(i.codigo)),
  );
  rows.push(
    row(4, undefined, { planejamento: 'SIM', influenciaPromocional: 'NAO' }),
  );
  const known = run(rows);
  assert.match(
    known.itens.find((i) => i.codigo === 'PLANEJAMENTO').observacao,
    /Entre 1 respostas/,
  );
  assert.match(
    known.itens.find((i) => i.codigo === 'PROMOCAO').observacao,
    /0 de 1/,
  );
});
test('insufficient financial reference and unobserved frequency comparison produce no corresponding prompts', () => {
  const rows = [row(1), row(2)];
  const h = analisarHistorico(input(rows));
  const r = refletirHistorico(h, rows, {
    ...value,
    amostra: 1,
    disponibilidade: 'INDISPONIVEL',
  });
  assert.ok(!r.itens.some((i) => ['FREQUENCIA', 'VALORES'].includes(i.codigo)));
  assert.ok(
    r.itens
      .find((i) => i.codigo === 'CATEGORIAS')
      .observacao.includes('não comprova recorrência'),
  );
});
