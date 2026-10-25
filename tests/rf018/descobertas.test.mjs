import test from 'node:test';
import assert from 'node:assert/strict';
import { analisarHistorico } from '../../src/modules/rf018/historico.engine.ts';
import { interpretarCompra } from '../../src/modules/rf018/interpretacao.engine.ts';
import {
  descobrirCompra,
  faixaValores,
} from '../../src/modules/rf018/descobertas.engine.ts';
import { resumirUsoAutorizado } from '../../src/modules/rf018/monitoramento.service.ts';
const rows = (values = [10, 11, 12, 13, 14, 15]) =>
  values.map((valor, i) => ({
    id: i + 1,
    usuarioId: 1,
    ativa: true,
    status: 'CONFIRMADA',
    data: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    precisao: 'DIA',
    valorLiquido: String(valor),
    origem: 'MANUAL',
    categorias: [1],
    nomesCategorias: [{ id: 1, nome: 'Livros' }],
    recorrenciaId: null,
    contexto: null,
  }));
function run({
  compras = rows(),
  respostas = {},
  eventos = [],
  extra = {},
  periodo = '2026-10',
} = {}) {
  const contextual = interpretarCompra({
    compraId: 99,
    ativa: true,
    status: 'CONFIRMADA',
    valor: '100',
    limite: null,
    contextoRevisao: 0,
    respostas,
    itens: [],
  });
  const historico = analisarHistorico({
    usuarioId: 1,
    periodo,
    observadoAte: `${periodo}-15T00:00:00Z`,
    orcamentoAtual: null,
    compras,
  });
  return {
    historico,
    contextual,
    result: descobrirCompra({
      historico,
      compras,
      contextual,
      eventos,
      compra: {
        id: 99,
        data: `${periodo}-15T00:00:00Z`,
        valorCentavos: 10000,
        limiteAtualCentavos: null,
        recorrenciaId: null,
        email: false,
        ...extra,
      },
    }),
  };
}
test('automatic observations require no contextual answers, and unknown periods produce no frequency increase', () => {
  const { result, contextual } = run();
  assert.equal(contextual.declaracoes.length, 0);
  assert.ok(result.itens.some((i) => i.codigo === 'VALOR_FORA_FAIXA'));
  assert.ok(result.perguntasSugeridas.includes('planejamento'));
  assert.ok(!result.itens.some((i) => i.codigo === 'FREQUENCIA_COMPARAVEL'));
  assert.ok(result.itens.length <= 3);
  assert.equal(result.score, undefined);
  assert.equal(result.classificacao, undefined);
});
test('small or flat samples do not produce an outlier flag; no invented graphs without history', () => {
  for (const values of [[], [10], [10, 20], [10, 10, 10, 10]]) {
    const { result } = run({ compras: rows(values) });
    assert.ok(!result.itens.some((i) => i.codigo === 'VALOR_FORA_FAIXA'));
    if (values.length < 2)
      assert.ok(result.itens.every((i) => i.grafico === undefined));
  }
  assert.equal(faixaValores([100, 100, 100, 100]), null);
});
test('a planned purchase and an unusual value coexist; refusal never leads to repeated planning invitations', () => {
  for (const planejamento of ['SIM', 'PREFIRO_NAO_RESPONDER']) {
    const { result, contextual } = run({ respostas: { planejamento } });
    assert.equal(
      contextual.declaracoes.find((d) => d.campo === 'planejamento').valor,
      planejamento,
    );
    assert.ok(result.itens.some((i) => i.codigo === 'VALOR_FORA_FAIXA'));
    assert.ok(!result.perguntasSugeridas.includes('planejamento'));
  }
});
test('known recurrence link, events and current references remain distinct and selection has at most three findings', () => {
  const { result } = run({
    eventos: ['DEVOLUCAO', 'REEMBOLSO'],
    extra: { recorrenciaId: 5, limiteAtualCentavos: 5000 },
  });
  assert.equal(result.itens[0].natureza, 'DECLARADO');
  assert.deepEqual(result.eventosPosteriores, ['DEVOLUCAO', 'REEMBOLSO']);
  assert.ok(result.itens.some((i) => i.codigo === 'RECORRENCIA_VINCULADA'));
  assert.equal(result.itens.length, 3);
  const no = run({ extra: { recorrenciaId: null } }).result;
  assert.ok(!no.itens.some((i) => i.codigo === 'RECORRENCIA_VINCULADA'));
});
test('recurrence value comparison uses only earlier purchases of the explicit same link', () => {
  const compras = rows([10, 30, 999]);
  compras[0].recorrenciaId = 5;
  compras[1].recorrenciaId = 5;
  compras[2].recorrenciaId = 6;
  const { result } = run({ compras, extra: { recorrenciaId: 5 } });
  const card = result.itens.find((i) => i.codigo === 'RECORRENCIA_VINCULADA');
  assert.equal(card.grafico.pontos[1].valor, 2000);
  assert.match(card.detalhe, /2 compra/);
});
test('commercial date comes from the existing calendar, with email precision limitations and no causal claim', () => {
  const { result } = run({
    compras: [],
    periodo: '2026-11',
    extra: { data: '2026-11-27T00:00:00Z', email: true },
  });
  const card = result.itens.find((i) => i.codigo === 'DATA_COMERCIAL');
  assert.match(card.titulo, /Black Friday/);
  assert.match(card.detalhe, /mensagem/);
  assert.ok(result.perguntasSugeridas.includes('influenciaPromocional'));
  assert.ok(
    !run({ compras: [] }).result.itens.some(
      (i) => i.codigo === 'DATA_COMERCIAL',
    ),
  );
});
test('category amounts never allocate a multicategory purchase or subtract liquid discounts again', () => {
  const compras = rows([10, 20]).map((r) => ({
    ...r,
    categoriasCompletas: true,
  }));
  compras[1].categorias = [1, 2];
  const { historico } = run({ compras });
  const c = historico.categorias.find((c) => c.categoriaId === 1);
  assert.equal(c.valores.totalLiquidoCentavos, 1000);
  assert.equal(c.valores.comprasAtribuidas, 1);
  assert.equal(c.valores.comprasMulticategoriaSemRateio, 1);
});
test('a purchase containing uncategorized items cannot have its entire value assigned to its known category', () => {
  const compras = rows([10, 20]).map((r) => ({
    ...r,
    categoriasCompletas: false,
  }));
  const { historico } = run({ compras });
  const c = historico.categorias[0];
  assert.equal(c.valores.totalLiquidoCentavos, 0);
  assert.equal(c.valores.comprasAtribuidas, 0);
  assert.equal(c.valores.comprasSemCategorizacaoCompleta, 2);
  assert.equal(c.comprasHistorico, 2);
});
const usage = (extra = {}) => ({
  tempo_uso_id: 1,
  tempo_uso_package_id: 'com.shopee.br',
  tempo_uso_nome: 'Shopee',
  tempo_uso_inicio: new Date('2026-10-18T03:00:00Z'),
  tempo_uso_fim: new Date('2026-10-19T03:00:00Z'),
  tempo_uso_data_local: new Date('2026-10-18T00:00:00Z'),
  tempo_uso_timezone: 'America/Sao_Paulo',
  tempo_uso_duracao_segundos: 600,
  tempo_uso_data_criacao: new Date('2026-10-19T04:00:00Z'),
  tempo_uso_data_modificacao: new Date('2026-10-19T04:00:00Z'),
  tempo_uso_origem: 'ANDROID_USAGE_STATS',
  ...extra,
});
test('authorized validated Android snapshots yield descriptive usage, never sessions or a transaction association', () => {
  const r = resumirUsoAutorizado(
    [usage()],
    new Date('2026-10-01'),
    new Date('2026-10-24'),
  );
  assert.equal(r.minutosRegistrados, 10);
  assert.deepEqual(r.dias, ['2026-10-18']);
  assert.equal(r.associacaoComCompra, 'INDISPONIVEL');
  assert.deepEqual(r.porDia, [{ data: '2026-10-18', minutos: 10 }]);
  assert.equal(r.porAplicativo[0].minutos, 10);
});
test('pre-consent, legacy, overlapping, future and invalid Android records never become zero observed usage', () => {
  const now = new Date('2026-10-24');
  for (const [records, grant] of [
    [[usage()], new Date('2026-10-20')],
    [[usage({ tempo_uso_origem: 'LEGADO' })], new Date('2026-10-01')],
    [[usage(), usage({ tempo_uso_id: 2 })], new Date('2026-10-01')],
    [[usage({ tempo_uso_duracao_segundos: 999999 })], new Date('2026-10-01')],
    [
      [usage({ tempo_uso_data_modificacao: new Date('2026-11-01') })],
      new Date('2026-10-01'),
    ],
  ]) {
    const r = resumirUsoAutorizado(records, grant, now);
    assert.equal(r.minutosRegistrados, null);
    assert.equal(r.disponibilidade, 'SEM_DADOS');
  }
});
