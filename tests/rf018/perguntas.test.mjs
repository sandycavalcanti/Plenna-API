import test from 'node:test';
import assert from 'node:assert/strict';
import { selecionarPerguntas } from '../../src/modules/rf018/perguntas.ts';
const contexto = (respostas = {}, itens = []) => ({
  versaoContrato: 1,
  compraId: 1,
  revisao: 0,
  criadaEm: null,
  respostas,
  itens,
});
const items = [
  { itemId: 10, nome: 'Livro' },
  { itemId: 11, nome: 'Caderno' },
];
const codes = (result) => result.perguntas.map((q) => q.codigo);
test('optional invitations without money, history or financial indicators; catalogue versioned', () => {
  const r = selecionarPerguntas(contexto(), items);
  assert.equal(r.versaoCatalogo, 'contexto-1');
  assert.equal(r.catalogo.length, 5);
  assert.deepEqual(codes(r), [
    'planejamento',
    'influenciaPromocional',
    'necessidadeInesperada',
    'autopercepcaoImpulsividade',
  ]);
  assert.equal(r.catalogo[0].versao, 1);
});
test('answered, uncertain and refused questions are never suggested again', () => {
  for (const resposta of [
    'SIM',
    'NAO',
    'NAO_LEMBRO',
    'PREFIRO_NAO_RESPONDER',
  ]) {
    const r = selecionarPerguntas(
      contexto({
        influenciaPromocional: resposta,
        necessidadeInesperada: resposta,
        autopercepcaoImpulsividade: resposta,
      }),
      items,
    );
    for (const field of [
      'influenciaPromocional',
      'necessidadeInesperada',
      'autopercepcaoImpulsividade',
    ])
      assert.ok(!codes(r).includes(field));
  }
});
test('partial planning selects unanswered item IDs; declared refusals count as answered', () => {
  const r = selecionarPerguntas(
    contexto({ planejamento: 'PARCIALMENTE' }, [
      { itemId: 10, planejamento: 'PREFIRO_NAO_RESPONDER' },
    ]),
    items,
  );
  assert.deepEqual(
    r.perguntas
      .filter((q) => q.codigo === 'planejamentoItem')
      .map((q) => q.itemId),
    [11],
  );
  assert.ok(codes(r).includes('momento'));
});
test('moment question depends on declared planning or promotion, not inferred impulsivity', () => {
  assert.ok(
    codes(selecionarPerguntas(contexto({ planejamento: 'SIM' }), [])).includes(
      'momento',
    ),
  );
  assert.ok(
    codes(
      selecionarPerguntas(contexto({ influenciaPromocional: 'SIM' }), []),
    ).includes('momento'),
  );
  assert.ok(
    !codes(
      selecionarPerguntas(
        contexto({ planejamento: 'NAO', influenciaPromocional: 'NAO' }),
        [],
      ),
    ).includes('momento'),
  );
});
test('new item requires its own answer; no matching by product name', () => {
  const r = selecionarPerguntas(
    contexto({ planejamento: 'PARCIALMENTE' }, [
      { itemId: 10, planejamento: 'SIM' },
    ]),
    [{ itemId: 12, nome: 'Livro' }],
  );
  assert.deepEqual(
    r.perguntas
      .filter((q) => q.codigo === 'planejamentoItem')
      .map((q) => q.itemId),
    [12],
  );
});
test('full context has no suggestions but retains entire catalogue for spontaneous review', () => {
  const r = selecionarPerguntas(
    contexto({
      planejamento: 'SIM',
      influenciaPromocional: 'NAO',
      necessidadeInesperada: 'NAO',
      momento: 'ADIADA',
      autopercepcaoImpulsividade: 'NAO',
    }),
    items,
  );
  assert.equal(r.perguntas.length, 0);
  assert.equal(r.catalogo.length, 5);
});
test('explicitly removed response can be answered again; selector is deterministic and immutable', () => {
  const c = contexto({ planejamento: 'SIM' });
  const before = structuredClone(c);
  assert.deepEqual(
    selecionarPerguntas(c, items),
    selecionarPerguntas(c, items),
  );
  assert.deepEqual(c, before);
  delete c.respostas.planejamento;
  assert.ok(codes(selecionarPerguntas(c, items)).includes('planejamento'));
});
