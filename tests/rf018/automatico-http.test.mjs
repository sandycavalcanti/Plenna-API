import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
let contextFailure = true;
const items = [
  {
    compra_item_id: 5,
    compra_item_nome: 'Item privado',
    categoria_id: 1,
    tb_categoria: { categoria_nome: 'Categoria privada' },
  },
];
const purchase = (id, date, value) => ({
  compra_id: id,
  usuario_id: 1,
  compra_ativo: 1,
  compra_status: 'CONFIRMADA',
  compra_horario: new Date(date + 'T00:00:00Z'),
  compra_valor: String(value),
  compra_email: false,
  compra_recorrencia_id: null,
  tb_compra_item: items,
});
const target = purchase(99, '2026-10-15', 450),
  rows = [10, 20, 30, 40, 15, 25]
    .map((v, i) =>
      purchase(i + 1, '2026-09-' + String(i + 1).padStart(2, '0'), v),
    )
    .concat(target);
const db = {
  tb_usuario: {
    findFirst: async ({ where }) => ({
      usuario_id: where.usuario_id,
      usuario_meta_valor_mensal: null,
      usuario_meta_valor_compra: 100,
      usuario_data_criacao: new Date('2020-01-01'),
    }),
  },
  tb_compra: {
    findFirst: async ({ where }) =>
      where.usuario_id === 1 && where.compra_id === 99 ? target : null,
    findMany: async ({ where, select }) => {
      assert.equal(where.usuario_id, 1);
      assert.equal(select.contexto_compra_revisao, false);
      return rows.filter(
        (r) =>
          r.compra_horario >= where.compra_horario.gte &&
          r.compra_horario < where.compra_horario.lt,
      );
    },
  },
  tb_compra_recorrencia: {
    findMany: async () => {
      throw Error('UNUSED_RECURRENCE_QUERY');
    },
  },
  contexto_compra_revisao: {
    findFirst: async () => {
      if (contextFailure) throw Error('private-context-storage-failure');
      return { revisao: 2, respostas: { planejamento: 'SIM' } };
    },
  },
  tb_compra_evento: {
    findMany: async () => [],
  },
  tb_referencia_financeira: {
    findMany: async () => [],
  },
  $queryRaw: async () => [{ tabela: null }],
  $transaction: async (fn) => fn(db),
};
globalThis.prismaRuntime = { client: db, pool: { end: async () => {} } };
const { AnaliseAutomaticaService } = await import(
  '../../src/modules/analise/analise-automatica.service.ts'
);
const { analisesRouter } = await import(
  '../../src/modules/analise/analise.routes.ts'
);
const { responderIndicadores, assuntoIndicadores } = await import(
  '../../src/modules/chat/chat.indicadores.ts'
);
test('automatic facts survive a failed contextual read', async () => {
  const r = await AnaliseAutomaticaService.compra(1, 99, new Date('2026-10-25'));
  assert.equal(r.estado, 'SINAIS_RELEVANTES');
  assert.equal(r.contextoDeclarado.disponibilidade, 'INDISPONIVEL');
  assert.equal(r.eventos.disponivel, true);
  assert.equal(r.referenciasFinanceiras.limiteHistoricoCentavos, null);
  assert.equal(r.referenciasFinanceiras.limiteAtualCentavos, 10000);
  assert.ok(
    r.qualidadeDados.criteriosIndisponiveis.includes(
      'V03:VIGENCIA_HISTORICA_NAO_COMPROVADA',
    ),
  );
  assert.ok(!JSON.stringify(r).includes('private-context'));
});
test('context becomes available independently and leaves automatic evidence intact', async () => {
  contextFailure = false;
  try {
    const r = await AnaliseAutomaticaService.compra(1, 99, new Date('2026-10-25'));
    assert.equal(r.contextoDeclarado.revisao, 2);
    assert.match(r.contextualizacao, /planejada/);
    assert.equal(r.estado, 'SINAIS_RELEVANTES');
  } finally {
    contextFailure = true;
  }
});
test('automatic route authenticates, isolates, validates and returns no-store', async () => {
  const app = express();
  app.use('/analises', analisesRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/analises/compras/99/automatica`;
  try {
    assert.equal((await fetch(base)).status, 401);
    const headers = {
      authorization:
        'Bearer ' + jwt.sign({ userId: 1 }, process.env.JWT_SECRET),
    };
    const r = await fetch(base, { headers });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal((await r.json()).estado, 'SINAIS_RELEVANTES');
    assert.equal(
      (await fetch(base + '?unsupported=true', { headers })).status,
      400,
    );
    assert.equal(
      (await fetch(base.replace('/99/', '/bad/'), { headers })).status,
      400,
    );
    assert.equal(
      (
        await fetch(base, {
          headers: {
            authorization:
              'Bearer ' + jwt.sign({ userId: 2 }, process.env.JWT_SECRET),
          },
        })
      ).status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test('period response remains aggregate-only and chat uses automatic evidence', async () => {
  const automatic = await AnaliseAutomaticaService.periodo(
    1,
    '2026-10',
    new Date('2026-10-25'),
  );
  assert.equal(automatic.estado, 'SINAIS_RELEVANTES');
  const data = { periodo: '2026-10', avaliacaoAutomatica: automatic };
  for (const question of [
    'O que você observou nas minhas compras?',
    'Alguma compra apresentou sinais diferentes do meu padrão?',
    'Por que esta compra chamou atenção?',
  ]) {
    assert.equal(assuntoIndicadores(question), 'AUTOMATICO');
    const text = responderIndicadores(question, data);
    assert.match(text, /não determina impulsividade/);
    assert.doesNotMatch(text, /Item privado|Categoria privada|private-context/);
  }
  assert.match(
    responderIndicadores('O que você observou nas minhas compras?', null),
    /Não consegui/,
  );
  assert.match(
    responderIndicadores('O que você observou nas minhas compras?', {
      ...data,
      avaliacaoAutomatica: { ...automatic, estado: 'DADOS_INSUFICIENTES' },
    }),
    /faltam/,
  );
});

test('Home discovery endpoint uses the real automatic engine without context and recalculates corrected records', async () => {
  const app = express();
  app.use('/analises', analisesRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/analises/descobertas?periodo=2026-10`;
  const headers = {
    authorization: 'Bearer ' + jwt.sign({ userId: 1 }, process.env.JWT_SECRET),
  };
  const saved = target.compra_valor;
  try {
    const first = await fetch(url, { headers });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const before = await first.json();
    assert.equal(before.avaliacaoAutomatica.estado, 'SINAIS_RELEVANTES');
    assert.ok(
      before.descobertas.some((d) => d.relevancia === 0 && d.evidencias.length),
    );
    target.compra_valor = '25';
    const after = await (await fetch(url, { headers })).json();
    assert.equal(after.avaliacaoAutomatica.estado, 'SEM_SINAIS_RELEVANTES');
    assert.ok(!after.descobertas.some((d) => d.relevancia === 0));
    assert.notEqual(
      after.avaliacaoAutomatica.dependencias.fontesHash,
      before.avaliacaoAutomatica.dependencias.fontesHash,
    );
  } finally {
    target.compra_valor = saved;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
