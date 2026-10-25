import test from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretarCompra,
  resultadoInterpretacaoSchema,
} from '../../src/modules/rf018/interpretacao.engine.ts';
const input = (extra = {}) => ({
  compraId: 1,
  ativa: true,
  status: 'CONFIRMADA',
  valor: '100',
  limite: '80',
  contextoRevisao: 1,
  respostas: {},
  itens: [],
  ...extra,
});
const run = (respostas = {}, extra = {}) =>
  interpretarCompra(input({ ...extra, respostas }));
test('R1 excess is only a financial observation; no score or automatic classification', () => {
  const r = run();
  assert.equal(r.observacoes[0].codigo, 'LIMITE_EXCEDIDO');
  assert.equal(r.estado, 'DADOS_INSUFICIENTES');
  assert.equal(r.interpretacao.reflexao, null);
  assert.deepEqual(
    r.regrasAplicadas.map((q) => q.codigo),
    ['R1_LIMITE'],
  );
  assert.equal(r.compra_classificacao, undefined);
  assert.equal(r.score, undefined);
});
test('exact and below limit never prove planning; zero/missing references unavailable', () => {
  for (const valor of ['80', '20'])
    assert.equal(
      run({}, { valor }).observacoes[0].codigo,
      'SEM_EXCESSO_CONHECIDO',
    );
  for (const limite of [null, '0']) {
    const r = run({}, { limite });
    assert.equal(r.observacoes.length, 0);
    assert.ok(r.limitacoes.includes('LIMITE_INDISPONIVEL'));
  }
  assert.ok(run({}, { valor: null }).limitacoes.includes('VALOR_DESCONHECIDO'));
});
test('R2 planned partially planned unplanned remain declarations', () => {
  for (const planejamento of ['SIM', 'PARCIALMENTE', 'NAO']) {
    const r = run({ planejamento });
    assert.equal(r.declaracoes[0].valor, planejamento);
    assert.ok(r.regrasAplicadas.some((q) => q.codigo === 'R2_PLANEJAMENTO'));
    assert.equal(r.estado, 'CONTEXTO_DISPONIVEL');
  }
});
test('R3 active item only; never infer whole purchase planning', () => {
  const r = run(
    {},
    {
      itens: [
        { itemId: 10, ativo: false, planejamento: 'NAO' },
        { itemId: 11, ativo: true, planejamento: 'SIM' },
        { itemId: 12, ativo: true },
      ],
    },
  );
  assert.deepEqual(
    r.declaracoes.map((d) => d.itemId),
    [11],
  );
  assert.ok(r.limitacoes.includes('PLANEJAMENTO_GERAL_AUSENTE'));
  assert.ok(r.limitacoes.includes('ITENS_COM_CONTEXTO_AUSENTE'));
  assert.ok(r.evidencias.every((e) => !e.referencia.endsWith('item:10')));
});
test('R4 promotion requires declaration, R5 unexpected necessity adds neutral context', () => {
  const r = run({
    planejamento: 'NAO',
    influenciaPromocional: 'SIM',
    necessidadeInesperada: 'SIM',
  });
  assert.match(r.interpretacao.reflexao, /promoção influenciou/);
  assert.doesNotMatch(r.interpretacao.reflexao, /necessidade inesperada/);
  assert.ok(r.declaracoes.some((d) => d.campo === 'necessidadeInesperada'));
  assert.ok(r.regrasAplicadas.some((q) => q.codigo === 'R4_PROMOCAO'));
  assert.ok(r.regrasAplicadas.some((q) => q.codigo === 'R5_NECESSIDADE'));
  assert.ok(!run().regrasAplicadas.some((q) => q.codigo === 'R4_PROMOCAO'));
});
test('R6 timing is declared without invented exact dates', () => {
  for (const momento of ['ANTECIPADA', 'ADIADA', 'NO_MOMENTO_PREVISTO']) {
    const r = run({ momento });
    assert.equal(r.declaracoes[0].valor, momento);
    assert.doesNotMatch(r.interpretacao.reflexao, /\d{4}-\d{2}-\d{2}/);
    assert.ok(r.regrasAplicadas.some((q) => q.codigo === 'R6_MOMENTO'));
  }
});
test('R7 neutral reflection combines only available evidence', () => {
  const r = run({ planejamento: 'NAO', influenciaPromocional: 'SIM' });
  assert.match(r.interpretacao.reflexao, /não estava planejada/);
  assert.match(r.interpretacao.reflexao, /vontade nova/);
  assert.ok(r.regrasAplicadas.some((q) => q.codigo === 'R7_CONTEXTO'));
  assert.ok(
    r.interpretacao.referencias.every((ref) =>
      r.evidencias.some((e) => e.referencia === ref),
    ),
  );
});
test('R8 self-perception stays separate and does not supply engine conclusion', () => {
  const r = run({ autopercepcaoImpulsividade: 'SIM' });
  assert.equal(r.autopercepcao.valor, 'SIM');
  assert.equal(r.declaracoes.length, 0);
  assert.equal(r.estado, 'DADOS_INSUFICIENTES');
  assert.equal(r.interpretacao.reflexao, null);
  assert.ok(r.regrasAplicadas.some((q) => q.codigo === 'R8_AUTOPERCEPCAO'));
});
test('unknown and refused answers are preserved but never treated as negative evidence', () => {
  for (const value of ['NAO_LEMBRO', 'PREFIRO_NAO_RESPONDER']) {
    const r = run(
      { planejamento: value, influenciaPromocional: value },
      { itens: [{ itemId: 10, ativo: true, planejamento: value }] },
    );
    assert.equal(r.estado, 'DADOS_INSUFICIENTES');
    assert.equal(r.interpretacao.reflexao, null);
    assert.ok(r.limitacoes.includes(`planejamento:${value}`));
  }
});
test('pending ignored or inactive purchase is not assessable', () => {
  for (const data of [
    { status: 'AGUARDANDO_CONFIRMACAO' },
    { status: 'IGNORADA' },
    { ativa: false },
  ]) {
    const r = run({ planejamento: 'SIM' }, data);
    assert.equal(r.estado, 'NAO_AVALIAVEL');
    assert.equal(r.interpretacao.reflexao, null);
  }
});
test('deterministic immutable versioned output; all rule references have evidence', () => {
  const d = input({
    respostas: { planejamento: 'PARCIALMENTE', momento: 'ADIADA' },
    itens: [
      { itemId: 12, ativo: true, planejamento: 'NAO' },
      { itemId: 10, ativo: true, planejamento: 'SIM' },
    ],
  });
  const before = structuredClone(d);
  const r = interpretarCompra(d);
  assert.deepEqual(r, interpretarCompra(d));
  assert.deepEqual(d, before);
  assert.equal(r.versaoMotor, 'contextual-2');
  assert.ok(
    r.regrasAplicadas.every(
      (q) =>
        q.versao === 1 &&
        q.referencias.every((ref) =>
          r.evidencias.some((e) => e.referencia === ref),
        ),
    ),
  );
  assert.equal(resultadoInterpretacaoSchema.safeParse(r).success, true);
  assert.ok(r.limitacoes.includes('HISTORICO_E_RF017_NAO_UTILIZADOS'));
});
test('rejects duplicate item IDs and invalid money/answers', () => {
  for (const d of [
    input({ valor: '-2' }),
    input({ respostas: { planejamento: true } }),
    input({
      itens: [
        { itemId: 1, ativo: true },
        { itemId: 1, ativo: true },
      ],
    }),
  ])
    assert.throws(() => interpretarCompra(d));
});
