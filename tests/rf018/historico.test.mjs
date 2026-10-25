import test from 'node:test';
import assert from 'node:assert/strict';
import { analisarHistorico } from '../../src/modules/rf018/historico.engine.ts';

const row = (id, data = '2026-10-05T12:00:00Z', extra = {}) => ({
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
  contexto: null,
  ...extra,
});
const input = (compras = [], extra = {}) => ({
  usuarioId: 1,
  periodo: '2026-10',
  mesesHistorico: 6,
  observadoAte: '2026-10-15T12:00:00Z',
  orcamentoAtual: '500',
  compras,
  ...extra,
});
const run = (compras, extra) => analisarHistorico(input(compras, extra));
const context = (respostas = {}, itens = []) => ({
  revisao: 2,
  respostas,
  itens,
});

test('empty history is insufficient, not a behavioral conclusion or invented zero average', () => {
  const r = run([]);
  assert.equal(r.frequencia.compras, 0);
  assert.equal(r.intervalos.disponibilidade, 'INDISPONIVEL');
  assert.equal(r.valores.disponibilidade, 'INDISPONIVEL');
  assert.equal(r.valores.historico.medianaCentavos, null);
  assert.equal(r.planejamento.cobertura, null);
  assert.equal(r.complementoContextual.alteraClassificacao, false);
  assert.ok(r.limitacoes.includes('HISTORICO_INSUFICIENTE'));
  assert.equal(r.score, undefined);
  assert.equal(r.classificacao, undefined);
});

test('inactive pending ignored future and out-of-window records are excluded; email is included', () => {
  const r = run([
    row(1),
    row(2, undefined, { ativa: false }),
    row(3, undefined, { status: 'AGUARDANDO_CONFIRMACAO' }),
    row(4, undefined, { status: 'IGNORADA' }),
    row(5, '2026-10-16T00:00:00Z'),
    row(6, '2025-01-01T00:00:00Z'),
    row(7, undefined, { origem: 'EMAIL' }),
  ]);
  assert.equal(r.frequencia.compras, 2);
  assert.equal(r.qualidade.importadasEmailAtual, 1);
  assert.equal(r.qualidade.excluidasLogicamente, 1);
  assert.equal(r.qualidade.naoConfirmadas, 2);
  assert.equal(r.financeiro.totalConhecido, 200);
});

test('user mismatch and duplicate canonical identities are rejected', () => {
  assert.throws(
    () => run([row(1, undefined, { usuarioId: 2 })]),
    /USER_MISMATCH/,
  );
  assert.throws(() => run([row(1), row(1)]), /DUPLICATE_CANONICAL/);
});

test('daily distribution counts purchases not category/items; peak ties are explicit', () => {
  const r = run([
    row(1),
    row(2, undefined, { categorias: [2, 2, 3] }),
    row(3, '2026-10-06T00:00:00Z'),
    row(4, '2026-10-06T01:00:00Z'),
  ]);
  assert.deepEqual(r.frequencia.distribuicaoDiaria, [
    { data: '2026-10-05', compras: 2 },
    { data: '2026-10-06', compras: 2 },
  ]);
  assert.deepEqual(r.frequencia.maiorConcentracao, {
    comprasPorDia: 2,
    datas: ['2026-10-05', '2026-10-06'],
  });
});

test('frequency comparisons use equal elapsed windows and label incomplete coverage', () => {
  const r = run([
    row(1),
    row(2, '2026-09-05T12:00:00Z'),
    row(3, '2026-09-25T00:00:00Z'),
  ]);
  assert.equal(r.frequencia.comparacao.diasComparados, 14.5);
  assert.equal(r.frequencia.comparacao.comprasAnterior, 1);
  assert.equal(r.frequencia.comparacao.comprasAtual, 1);
  assert.equal(r.frequencia.comparacao.disponibilidade, 'INDISPONIVEL');
  assert.equal(r.frequencia.comparacao.diferenca, null);
  assert.equal(r.frequencia.periodos.at(-2).compras, 2);
});

test('closed 31-day month compares first 30 days to a 30-day previous month', () => {
  const r = run(
    [row(1, '2026-10-31T12:00:00Z'), row(2, '2026-09-30T12:00:00Z')],
    { observadoAte: '2026-11-01T00:00:00Z' },
  );
  assert.equal(r.frequencia.compras, 1);
  assert.equal(r.frequencia.comparacao.comprasAtual, 0);
  assert.equal(r.frequencia.comparacao.diasComparados, 30);
  assert.equal(r.financeiro.orcamentoMensal, null);
});

test('account created during comparison window never implies prior zero consumption', () => {
  const r = run([row(1)], { inicioObservacao: '2026-10-01T00:00:00Z' });
  assert.equal(r.frequencia.comparacao.disponibilidade, 'INDISPONIVEL');
  assert.equal(r.frequencia.comparacao.diferenca, null);
});

test('day precision never emits exact seconds; same-day purchases have zero calendar-day distance only', () => {
  const r = run([
    row(2, '2026-10-05T20:00:00Z'),
    row(1, '2026-10-05T02:00:00Z'),
    row(3, '2026-10-07T12:00:00Z'),
  ]);
  assert.deepEqual(
    r.intervalos.pares.map((p) => p.diasEntreDatas),
    [0, 2],
  );
  assert.ok(
    r.intervalos.pares.every(
      (p) => p.segundosExatos === null && p.precisao === 'DIA',
    ),
  );
});

test('proven instants allow exact intervals and offsets are normalized to UTC', () => {
  const r = run([
    row(1, '2026-10-05T23:30:00-03:00', { precisao: 'INSTANTE' }),
    row(2, '2026-10-06T03:30:00Z', { precisao: 'INSTANTE' }),
  ]);
  assert.equal(r.intervalos.pares[0].segundosExatos, 3600);
  assert.deepEqual(r.frequencia.distribuicaoDiaria, [
    { data: '2026-10-06', compras: 2 },
  ]);
});

test('missing/unknown dates are explicit, excluded from temporal indicators', () => {
  const r = run([
    row(1, null),
    row(2, undefined, { precisao: 'DESCONHECIDA' }),
    row(3),
  ]);
  assert.equal(r.qualidade.semDataOuPrecisao, 2);
  assert.equal(r.frequencia.compras, 1);
  assert.equal(r.intervalos.pares.length, 0);
});

test('median and mean use the user prior purchases; missing values retain partial coverage', () => {
  const r = run([
    row(1, '2026-09-01T00:00:00Z', { valorLiquido: '10' }),
    row(2, '2026-09-02T00:00:00Z', { valorLiquido: '30' }),
    row(3, undefined, { valorLiquido: '50' }),
    row(4, undefined, { valorLiquido: null }),
  ]);
  assert.equal(r.valores.historico.medianaCentavos, 2000);
  assert.equal(r.valores.historico.mediaCentavos, 2000);
  assert.equal(r.valores.diferencaMedianasCentavos, 3000);
  assert.equal(r.valores.variacaoRelativaMediana, 1.5);
  assert.equal(r.financeiro.qualidade, 'PARCIAL');
  assert.equal(r.financeiro.comprasSemValor, 1);
});

test('single historical sample cannot establish a reference; zero median has no relative ratio', () => {
  assert.equal(
    run([row(1, '2026-09-01T00:00:00Z'), row(2)]).valores.disponibilidade,
    'INDISPONIVEL',
  );
  const r = run([
    row(1, '2026-09-01T00:00:00Z', { valorLiquido: '0' }),
    row(2, '2026-09-02T00:00:00Z', { valorLiquido: '0' }),
    row(3),
  ]);
  assert.equal(r.valores.variacaoRelativaMediana, null);
  assert.equal(r.valores.diferencaMedianasCentavos, 10000);
});

test('category repetition is counted once per purchase; categories with no prior records have no invented variation', () => {
  const r = run([
    row(1, undefined, { categorias: [2, 2, 3] }),
    row(2, '2026-09-05T00:00:00Z', { categorias: [2] }),
  ]);
  assert.equal(r.categorias[0].comprasAtual, 1);
  assert.equal(r.categorias[0].repeticaoObservada, true);
  assert.equal(r.categorias[1].comparacao.disponibilidade, 'INDISPONIVEL');
  assert.equal(r.categorias[1].comparacao.variacaoRelativa, null);
});

test('planning coverage excludes missing, refused and unknown responses from known denominators', () => {
  const answers = [
    'SIM',
    'PARCIALMENTE',
    'NAO',
    'PREFIRO_NAO_RESPONDER',
    'NAO_LEMBRO',
    undefined,
  ];
  const r = run(
    answers.map((planejamento, i) =>
      row(i + 1, undefined, {
        contexto: planejamento ? context({ planejamento }) : null,
      }),
    ),
  );
  assert.equal(r.planejamento.universo, 6);
  assert.equal(r.planejamento.conhecidas, 3);
  assert.equal(r.planejamento.recusadas, 1);
  assert.equal(r.planejamento.naoLembra, 1);
  assert.equal(r.planejamento.ausentes, 1);
  assert.equal(r.planejamento.cobertura, 0.5);
  assert.equal(r.planejamento.proporcoesConhecidas.SIM, 1 / 3);
});

test('item planning does not determine whole purchase and ignores inactive item context', () => {
  const r = run([
    row(1, undefined, {
      itensAtivos: [10, 11, 12],
      contexto: context({}, [
        { itemId: 10, planejamento: 'SIM' },
        { itemId: 11, planejamento: 'PREFIRO_NAO_RESPONDER' },
        { itemId: 99, planejamento: 'NAO' },
      ]),
    }),
  ]);
  assert.equal(r.planejamento.conhecidas, 0);
  assert.equal(r.planejamento.porItem.universo, 3);
  assert.equal(r.planejamento.porItem.conhecidas, 1);
  assert.equal(r.planejamento.porItem.ausentes, 1);
  assert.equal(r.planejamento.porItem.cobertura, 1 / 3);
});

test('promotion requires explicit declarations and never derives from liquid purchase amounts', () => {
  const r = run([
    row(1),
    row(2, undefined, { contexto: context({ influenciaPromocional: 'SIM' }) }),
    row(3, undefined, { contexto: context({ influenciaPromocional: 'NAO' }) }),
    row(4, undefined, {
      contexto: context({ influenciaPromocional: 'PREFIRO_NAO_RESPONDER' }),
    }),
  ]);
  assert.equal(r.influenciaPromocional.conhecidas, 2);
  assert.equal(r.influenciaPromocional.influenciaDeclarada, 1);
  assert.equal(r.influenciaPromocional.proporcaoConhecidas, 0.5);
  assert.equal(r.financeiro.totalConhecido, 400);
});

test('registered recurrence and statistical repetition remain independent', () => {
  const r = run([row(1, undefined, { recorrenciaId: 8 }), row(2)], {
    recorrencias: [
      { id: 8, status: 'PAUSADA' },
      { id: 9, status: 'ATIVA' },
    ],
  });
  assert.equal(r.recorrencias.cadastradas, 2);
  assert.equal(r.recorrencias.porStatus.PAUSADA, 1);
  assert.equal(r.recorrencias.comprasVinculadasAtual, 1);
  assert.equal(r.categorias[0].repeticaoObservada, true);
  assert.equal(r.complementoContextual.alteraClassificacao, false);
});

test('analysis is deterministic and never mutates inputs or applies a budget to a closed period', () => {
  const data = input([row(2), row(1)], {
    observadoAte: '2026-11-01T00:00:00Z',
  });
  const before = structuredClone(data);
  assert.deepEqual(analisarHistorico(data), analisarHistorico(data));
  assert.deepEqual(data, before);
  assert.equal(analisarHistorico(data).financeiro.orcamentoMensal, null);
  assert.throws(
    () => run([], { observadoAte: '2026-09-01T00:00:00Z' }),
    /INVALID_HISTORY_WINDOW/,
  );
});

test('declarations are available for historical and individual monthly windows', () => {
  const r = run([
    row(1, '2026-09-05T00:00:00Z', {
      contexto: context({ planejamento: 'SIM', influenciaPromocional: 'NAO' }),
    }),
    row(2, undefined, {
      contexto: context({ planejamento: 'NAO', influenciaPromocional: 'SIM' }),
    }),
  ]);
  assert.equal(r.planejamento.historico.contagens.SIM, 1);
  assert.equal(r.planejamento.periodos.at(-2).contagens.SIM, 1);
  assert.equal(r.influenciaPromocional.historico.contagens.NAO, 1);
  assert.equal(r.influenciaPromocional.periodos.at(-1).contagens.SIM, 1);
});

test('interval sequence spans the month boundary and uses no manufactured precision', () => {
  const r = run([
    row(1, '2026-09-30T23:00:00Z'),
    row(2, '2026-10-02T01:00:00Z'),
  ]);
  assert.equal(r.intervalos.pares.length, 1);
  assert.equal(r.intervalos.pares[0].diasEntreDatas, 2);
  assert.equal(r.intervalos.pares[0].segundosExatos, null);
});

test('duplicate active/template answers or recurrence identities cannot inflate counts', () => {
  assert.throws(() => run([row(1, undefined, { itensAtivos: [10, 10] })]));
  assert.throws(() =>
    run([], {
      recorrencias: [
        { id: 1, status: 'ATIVA' },
        { id: 1, status: 'ATIVA' },
      ],
    }),
  );
});

test('missing precision degrades coverage and never proves same-day chronological order', () => {
  const r = run(
    [row(1), row(2, undefined, { precisao: 'INSTANTE' }), row(3, null)],
    { cobertura: 'COMPLETA' },
  );
  assert.equal(r.qualidade.cobertura, 'PARCIAL');
  assert.equal(r.financeiro.cobertura, 'PARCIAL');
  assert.equal(r.intervalos.pares[0].ordemNoMesmoDiaComprovada, false);
  assert.equal(r.intervalos.pares[0].segundosExatos, null);
});

test('historical mid-month cutoff never makes current budget valid retroactively', () => {
  const r = run([row(1)], { referenciaAtual: '2026-11-10T00:00:00Z' });
  assert.equal(r.financeiro.orcamentoMensal, null);
  assert.ok(r.limitacoes.includes('ORCAMENTO_HISTORICO_NAO_COMPROVADO'));
});
