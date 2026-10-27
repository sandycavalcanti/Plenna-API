import test from 'node:test';
import assert from 'node:assert/strict';
import { avaliarAutomaticamente as avaliar } from '../../src/modules/analise/analise-automatica.engine.ts';
const row = (id, data, valor = '20', extra = {}) => ({
  id,
  usuarioId: 1,
  ativa: true,
  status: 'CONFIRMADA',
  data: data + 'T00:00:00.000Z',
  precisao: 'DIA',
  valorLiquido: String(valor),
  origem: 'MANUAL',
  categorias: [1],
  categoriasCompletas: true,
  itensAtivos: [],
  recorrenciaId: null,
  contexto: null,
  ...extra,
});
const baseline = () =>
  [10, 20, 30, 40, 15, 25].map((v, i) =>
    row(i + 1, `2026-09-${String(i + 1).padStart(2, '0')}`, v),
  );
const target = (extra = {}) => row(900, '2026-10-15', '450', extra);
const input = (compras = baseline(), extra = {}) => ({
  usuarioId: 1,
  periodo: '2026-10',
  mesesHistorico: 6,
  observadoAte: '2026-10-15T00:00:00.000Z',
  orcamentoAtual: null,
  compras,
  ...extra,
});
function clustered() {
  let id = 1;
  return [1, 2, 1, 3, 2, 1]
    .flatMap((n, i) =>
      Array.from({ length: n }, () =>
        row(id++, `2026-09-${String(i + 1).padStart(2, '0')}`, String(10 + id)),
      ),
    )
    .concat(
      Array.from({ length: 10 }, (_, i) =>
        row(100 + i, '2026-10-05', String(12 + i)),
      ),
    );
}
const context = (respostas) => ({
  contexto: { disponibilidade: 'DISPONIVEL', revisao: 1, respostas },
});

test('A: atypical purchase produces automatic signals without any contextual response', () => {
  const r = avaliar(input(), target());
  assert.equal(r.estado, 'SINAIS_RELEVANTES');
  assert.ok(r.evidencias.find((e) => e.indicador === 'V01').sinal);
  assert.equal(r.contextoDeclarado.disponibilidade, 'INDISPONIVEL');
  assert.equal(r.classificacaoAutomaticaDefinitiva, false);
  assert.equal(r.persistido, false);
  assert.equal(r.score, undefined);
});
test('B: planning complements and never erases automatic evidence', () => {
  const a = avaliar(input(), target()),
    b = avaliar(input(), target(), context({ planejamento: 'SIM' }));
  assert.deepEqual(a.evidencias, b.evidencias);
  assert.equal(a.estado, b.estado);
  assert.match(b.contextualizacao, /planejada/);
  assert.notEqual(a.dependencias.fontesHash, b.dependencias.fontesHash);
});
test('C: distinct value and temporal families compose one explainable discovery', () => {
  const r = avaliar(input(clustered()), target());
  assert.equal(r.estado, 'COMBINACAO_SINAIS_RELEVANTES');
  assert.deepEqual(r.familiasDeSinais.sort(), ['FREQUENCIA', 'VALORES']);
  assert.equal(r.descobertas.length, 1);
  assert.ok(
    r.descobertas[0].referencias.every(
      (e) => e.regra && e.amostra > 0 && e.periodo,
    ),
  );
  assert.match(r.descobertas[0].mensagem, /não determinam impulsividade/);
});
test('D: insufficient, missing and flat historical values never become a negative classification', () => {
  for (const compras of [
    [],
    baseline().slice(0, 3),
    baseline().map((r) => ({ ...r, valorLiquido: '10' })),
  ]) {
    const r = avaliar(input(compras), target());
    assert.equal(r.estado, 'DADOS_INSUFICIENTES');
    assert.ok(r.qualidadeDados.criteriosIndisponiveis.length);
    assert.equal(r.descobertas.length, 0);
  }
  assert.equal(
    avaliar(input(), target({ valorLiquido: null })).estado,
    'DADOS_INSUFICIENTES',
  );
});
test('purchase inside supported range yields absence of identified signals, not a voluntary classification', () => {
  const r = avaliar(input(), target({ valorLiquido: '25' }));
  assert.equal(r.estado, 'SEM_SINAIS_RELEVANTES');
  assert.equal(r.classificacao, undefined);
  assert.ok(
    r.qualidadeDados.criteriosIndisponiveis.includes(
      'F05:COBERTURA_OU_JANELA_INSUFICIENTE',
    ),
  );
});
test('E: logically excluded duplicate does not distort value, count or concentration', () => {
  const a = avaliar(input(), target());
  const b = avaliar(
    input([
      ...baseline(),
      row(500, '2026-09-03', '999999', { ativa: false }),
      row(501, '2026-09-03', '999999', { status: 'AGUARDANDO_CONFIRMACAO' }),
    ]),
    target(),
  );
  assert.deepEqual(a.evidencias, b.evidencias);
  assert.equal(
    a.qualidadeDados.registrosElegiveis,
    b.qualidadeDados.registrosElegiveis,
  );
});
for (const tipo of ['cancelamentos', 'devolucoes'])
  test(
    'F: ' +
      tipo +
      ' preserves original decision and keeps financial event separate',
    () => {
      const a = avaliar(input(), target());
      const b = avaliar(input(), target(), {
        eventos: { disponivel: true, [tipo]: 1, reembolsadoCentavos: 45000 },
      });
      assert.deepEqual(a.evidencias, b.evidencias);
      assert.equal(b.eventos.reembolsadoCentavos, 45000);
      assert.ok(
        b.limitacoes.includes(
          'VALORES_DA_DECISAO_NAO_SAO_GASTO_FINAL_APOS_EVENTOS',
        ),
      );
    },
  );
test('G: historical and current limits remain distinct, unknown history cannot signal a historical excess', () => {
  const old = avaliar(input([]), target({ valorLiquido: '708.24' }), {
    limiteHistoricoCentavos: 65000,
    limiteAtualCentavos: 90000,
  });
  assert.equal(old.evidencias[0].referencia, 65000);
  assert.equal(old.evidencias[0].observado, 70824);
  assert.equal(old.estado, 'SINAIS_RELEVANTES');
  const unknown = avaliar(input([]), target(), { limiteAtualCentavos: 100 });
  assert.equal(unknown.estado, 'DADOS_INSUFICIENTES');
  assert.equal(
    unknown.referenciasFinanceiras.referenciaAtualParticipaDosSinais,
    false,
  );
});
test('H: perceived impulse, refusal and later response revision do not replace automatic facts', () => {
  const base = avaliar(input(), target());
  for (const respostas of [
    { autopercepcaoImpulsividade: 'SIM' },
    { autopercepcaoImpulsividade: 'NAO' },
    { planejamento: 'PREFIRO_NAO_RESPONDER' },
    {},
  ]) {
    const r = avaliar(input(), target(), context(respostas));
    assert.deepEqual(r.evidencias, base.evidencias);
    assert.equal(r.estado, base.estado);
    assert.deepEqual(r.contextoDeclarado.respostas, respostas);
    assert.equal(r.classificacaoAutomaticaDefinitiva, false);
  }
});
test('correlated value/category/limit signals count as only one family', () => {
  const r = avaliar(input(), target(), { limiteHistoricoCentavos: 10000 });
  assert.equal(r.evidencias.filter((e) => e.sinal).length, 3);
  assert.deepEqual(r.familiasDeSinais, ['VALORES']);
  assert.equal(r.estado, 'SINAIS_RELEVANTES');
});
test('registered frequency increase needs explicit complete equal-window coverage', () => {
  const rows = [
    row(1, '2026-09-01'),
    row(2, '2026-10-01'),
    row(3, '2026-10-02'),
  ];
  const unknown = avaliar(input(rows), target({ valorLiquido: null }));
  assert.ok(!unknown.evidencias.some((e) => e.indicador === 'F05'));
  const covered = avaliar(
    input(rows, { cobertura: 'COMPLETA' }),
    target({ valorLiquido: null }),
  );
  assert.equal(
    covered.evidencias.find((e) => e.indicador === 'F05').sinal,
    true,
  );
  assert.equal(covered.estado, 'SINAIS_RELEVANTES');
});
test('habitual frequency and ordinary repeated category are not themselves signals', () => {
  const r = avaliar(
    input([row(1, '2026-09-01'), row(2, '2026-10-01')], {
      cobertura: 'COMPLETA',
    }),
    target({ valorLiquido: null }),
  );
  assert.equal(r.estado, 'SEM_SINAIS_RELEVANTES');
  assert.equal(r.evidencias[0].sinal, false);
  assert.ok(!r.evidencias.some((e) => e.indicador === 'R02'));
});
test('a new category is insufficient category history, never automatic abnormality', () => {
  const r = avaliar(input(), target({ categorias: [99] }));
  assert.ok(
    r.qualidadeDados.criteriosIndisponiveis.some((e) =>
      e.startsWith('V01_CATEGORIA'),
    ),
  );
  assert.ok(!r.evidencias.some((e) => e.indicador === 'V01_CATEGORIA'));
});
test('category-specific atypical value uses only complete single-category purchases', () => {
  const rows = baseline().concat(
    baseline().map((r) => ({
      ...r,
      id: r.id + 30,
      categorias: [2],
      valorLiquido: String(Number(r.valorLiquido) * 100),
    })),
  );
  const r = avaliar(input(rows), target());
  assert.equal(
    r.evidencias.find((e) => e.indicador === 'V01_CATEGORIA').sinal,
    true,
  );
  assert.equal(r.evidencias.find((e) => e.indicador === 'V01').sinal, false);
});
test('recurrence, seasonal date and email origin do not create causal impulse claims', () => {
  const r = avaliar(input(), target({ origem: 'EMAIL', recorrenciaId: 1 }), {
    limiteHistoricoCentavos: 1000,
  });
  assert.ok(!r.evidencias.some((e) => e.indicador === 'V03'));
  assert.ok(r.limitacoes.includes('EMAIL_NAO_COMPROVA_DATA_DA_TRANSACAO'));
  assert.ok(r.evidencias.every((e) => !e.indicador.startsWith('D')));
});
test('imprecise dates and future or same-day historical rows are excluded', () => {
  const base = avaliar(input(), target());
  const r = avaliar(
    input([
      ...baseline(),
      row(20, '2026-09-02', '9999', { precisao: 'DESCONHECIDA' }),
      row(21, '2026-10-15', '9999'),
      row(22, '2026-10-20', '9999'),
    ]),
    target(),
  );
  assert.deepEqual(r.evidencias, base.evidencias);
});
test('canonical duplicates, foreign user and inconsistent values are rejected', () => {
  assert.throws(
    () => avaliar(input([baseline()[0], baseline()[0]]), target()),
    /DUPLICATE/,
  );
  assert.throws(
    () =>
      avaliar(input([row(1, '2026-09-01', '20', { usuarioId: 2 })]), target()),
    /USER_MISMATCH/,
  );
  assert.throws(
    () => avaliar(input(), target({ usuarioId: 2 })),
    /TARGET_INVALID/,
  );
  assert.throws(() => avaliar(input([row(1, '2026-09-01', '-1')]), target()));
});
test('period assessment uses previous months as baseline and returns no raw purchase identities', () => {
  const compras = clustered();
  compras.find((r) => r.id === 100).valorLiquido = '450';
  const r = avaliar(input(compras));
  assert.equal(r.escopo, 'PERIODO');
  assert.equal(r.compraId, null);
  assert.equal(r.estado, 'COMBINACAO_SINAIS_RELEVANTES');
  assert.doesNotMatch(
    JSON.stringify(r),
    /compra_id|compra_fonte|compra:|usuarioId/,
  );
});
test('equivalent timezone offsets preserve the UTC historical boundary', () => {
  const r = avaliar(input(), target({ data: '2026-10-15T03:00:00+03:00' }));
  assert.deepEqual(r.evidencias, avaliar(input(), target()).evidencias);
});

test('per-purchase dependency fingerprint is stable during the same month without source changes', () => {
  const a = avaliar(
    input(baseline(), { referenciaAtual: '2026-10-25T10:00:00Z' }),
    target(),
  );
  const b = avaliar(
    input(baseline(), { referenciaAtual: '2026-10-25T11:00:00Z' }),
    target(),
  );
  assert.equal(a.dependencias.fontesHash, b.dependencias.fontesHash);
  assert.notEqual(
    a.dependencias.fontesHash,
    avaliar(
      input(baseline().slice(0, 5), {
        referenciaAtual: '2026-10-25T11:00:00Z',
      }),
      target(),
    ).dependencias.fontesHash,
  );
});
