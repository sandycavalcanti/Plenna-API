import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';

// No real database. Transactions serialize at the simulated parent-row lock.
let purchases, items, revisions, writes, activeUser, failCreate;
let tail = Promise.resolve();
const load = (row) => (row ? structuredClone(row) : null);
const db = {
  tb_usuario: {
    findFirst: async ({ where }) =>
      activeUser ? { usuario_id: where.usuario_id } : null,
  },
  tb_compra: {
    findFirst: async ({ where }) => {
      const p = purchases.find(
        (p) =>
          p.compra_id === where.compra_id &&
          p.usuario_id === where.usuario_id &&
          (where.compra_ativo === undefined ||
            p.compra_ativo === where.compra_ativo),
      );
      return p
        ? {
            ...p,
            tb_compra_item: items.filter(
              (i) => i.compra_id === p.compra_id && i.compra_item_ativo === 1,
            ),
          }
        : null;
    },
  },
  tb_compra_item: {
    findMany: async ({ where }) =>
      items.filter(
        (i) => i.compra_id === where.compra_id && i.compra_item_ativo === 1,
      ),
  },
  contexto_compra_revisao: {
    findMany: async ({ where, take }) =>
      revisions
        .filter(
          (r) =>
            r.compra_id === where.compra_id &&
            r.usuario_id === where.usuario_id &&
            (!where.revisao || r.revisao < where.revisao.lt),
        )
        .sort((a, b) => b.revisao - a.revisao)
        .slice(0, take)
        .map(load),
    findFirst: async ({ where }) =>
      load(
        revisions
          .filter(
            (r) =>
              r.compra_id === where.compra_id &&
              r.usuario_id === where.usuario_id,
          )
          .at(-1),
      ),
    findUnique: async ({ where }) => {
      const k = where.compra_id_operacao_id;
      return load(
        revisions.find(
          (r) => r.compra_id === k.compra_id && r.operacao_id === k.operacao_id,
        ),
      );
    },
    create: async ({ data }) => {
      if (failCreate) throw Error('private-database-error');
      for (const item of data.itens.create)
        assert.ok(
          !('compra_id' in item),
          'Composite parent keys must not be sent in a nested create',
        );
      const row = {
        ...data,
        contexto_id: revisions.length + 1,
        criada_em: new Date('2026-10-24T12:00:00Z'),
        itens: data.itens.create.map((item) => ({
          ...item,
          compra_id: data.compra_id,
        })),
      };
      revisions.push(structuredClone(row));
      writes++;
      return load(row);
    },
  },
  $queryRaw: async (_strings, compraId, userId) =>
    purchases
      .filter(
        (p) =>
          p.compra_id === compraId &&
          p.usuario_id === userId &&
          p.compra_ativo === 1,
      )
      .map((p) => ({ compra_id: p.compra_id })),
  $transaction: async (callback) => {
    let release, snapshot, count;
    const tx = {
      ...db,
      $queryRaw: async (strings, ...values) => {
        assert.match(strings.join('?'), /FOR UPDATE/);
        const before = tail;
        tail = new Promise((r) => {
          release = r;
        });
        await before;
        snapshot = structuredClone(revisions);
        count = writes;
        return db.$queryRaw(strings, ...values);
      },
    };
    try {
      return await callback(tx);
    } catch (e) {
      if (snapshot) {
        revisions = snapshot;
        writes = count;
      }
      throw e;
    } finally {
      release?.();
    }
  },
};
globalThis.prismaRuntime = { client: db, pool: { end: async () => {} } };
const { ContextoService } = await import(
  '../../src/modules/analise/contexto.service.ts'
);
const { atualizarContextoSchema, contextoSaidaSchema } = await import(
  '../../src/modules/analise/contexto.schemas.ts'
);
const { contextoRouter } = await import(
  '../../src/modules/analise/contexto.routes.ts'
);
let server, base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/v2/compras', contextoRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/v2/compras`;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
test.beforeEach(() => {
  purchases = [
    {
      compra_id: 1,
      usuario_id: 1,
      compra_ativo: 1,
      compra_classificacao: 'PENDENTE',
      compra_valor: 100,
    },
    { compra_id: 2, usuario_id: 2, compra_ativo: 1 },
  ];
  items = [
    { compra_item_id: 10, compra_id: 1, compra_item_ativo: 1 },
    { compra_item_id: 11, compra_id: 1, compra_item_ativo: 1 },
    { compra_item_id: 20, compra_id: 2, compra_item_ativo: 1 },
  ];
  revisions = [];
  writes = 0;
  activeUser = true;
  failCreate = false;
});
const payload = (extra = {}) => ({
  versaoContrato: 1,
  revisaoEsperada: 0,
  operacaoId: randomUUID(),
  respostas: { planejamento: 'PARCIALMENTE' },
  ...extra,
});
const save = (p = payload(), user = 1, purchase = 1) =>
  ContextoService.atualizar(user, purchase, p);
const read = (user = 1, purchase = 1) =>
  ContextoService.consultar(user, purchase);
const conflict = (e) => e.statusCode === 409;
const missing = (e) => e.statusCode === 404;
async function request(method = 'GET', body, options = {}) {
  const token =
    options.token === null
      ? null
      : (options.token ??
        jwt.sign({ userId: options.userId ?? 1 }, process.env.JWT_SECRET, {
          expiresIn: '5m',
        }));
  return fetch(base + (options.path ?? '/1/contexto'), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test('no context returns revision zero, without generating answers or writes', async () => {
  assert.deepEqual(await read(), {
    versaoContrato: 1,
    compraId: 1,
    revisao: 0,
    criadaEm: null,
    respostas: {},
    itens: [],
  });
  assert.equal(writes, 0);
});

test('post-purchase declarations persist in revisions without becoming answers or changing purchase amounts', async () => {
  const before = structuredClone(purchases);
  for (const tipo of [
    'CANCELAMENTO',
    'DEVOLUCAO',
    'REEMBOLSO',
    'ARREPENDIMENTO',
  ]) {
    const r = await save(
      payload({
        revisaoEsperada: revisions.length,
        respostas: {},
        eventosPosteriores: [tipo],
      }),
    );
    assert.deepEqual(r.eventosPosteriores, [tipo]);
    assert.deepEqual(r.respostas, {});
    assert.deepEqual(await read(), r);
  }
  assert.deepEqual(purchases, before);
  assert.equal(revisions.length, 4);
  assert.deepEqual(revisions[0].respostas.__contexto_eventos_v1, {
    versao: 1,
    eventos: ['CANCELAMENTO'],
  });
});
test('events survive later answer edits; clearing events is explicit and preserves earlier revisions', async () => {
  const original = await save(payload({ eventosPosteriores: ['DEVOLUCAO'] }));
  const edited = await save(
    payload({ revisaoEsperada: 1, respostas: { planejamento: 'SIM' } }),
  );
  assert.deepEqual(edited.eventosPosteriores, ['DEVOLUCAO']);
  assert.equal(edited.respostas.planejamento, 'SIM');
  const cleared = await save(
    payload({ revisaoEsperada: 2, respostas: {}, eventosPosteriores: [] }),
  );
  assert.deepEqual(cleared.eventosPosteriores, []);
  assert.deepEqual(
    revisions[0].respostas.__contexto_eventos_v1.eventos,
    original.eventosPosteriores,
  );
});
test('event-only retries are idempotent, conflicts and foreign purchases remain protected', async () => {
  const body = payload({ respostas: {}, eventosPosteriores: ['REEMBOLSO'] });
  assert.deepEqual(await save(body), await save(body));
  assert.equal(writes, 1);
  await assert.rejects(
    save(payload({ respostas: {}, eventosPosteriores: ['DEVOLUCAO'] })),
    conflict,
  );
  await assert.rejects(save(body, 1, 2), missing);
  assert.equal(
    atualizarContextoSchema.safeParse(
      payload({ eventosPosteriores: ['OUTRO'] }),
    ).success,
    false,
  );
  assert.equal(
    atualizarContextoSchema.safeParse(
      payload({ eventosPosteriores: ['REEMBOLSO', 'REEMBOLSO'] }),
    ).success,
    false,
  );
});
test('creates partial planning with optional fields and validated output', async () => {
  const before = structuredClone(purchases);
  const r = await save();
  assert.equal(r.revisao, 1);
  assert.equal(r.respostas.planejamento, 'PARCIALMENTE');
  assert.equal(contextoSaidaSchema.safeParse(r).success, true);
  assert.deepEqual(purchases, before);
});
test('all five planning answers and voluntary declarations persist independently', async () => {
  let n = 0;
  for (const planejamento of [
    'SIM',
    'PARCIALMENTE',
    'NAO',
    'NAO_LEMBRO',
    'PREFIRO_NAO_RESPONDER',
  ]) {
    const r = await save(
      payload({
        revisaoEsperada: n++,
        respostas: {
          planejamento,
          influenciaPromocional: 'SIM',
          necessidadeInesperada: 'NAO',
          momento: 'ADIADA',
          autopercepcaoImpulsividade: 'PREFIRO_NAO_RESPONDER',
        },
      }),
    );
    assert.equal(r.respostas.planejamento, planejamento);
  }
  assert.equal(revisions.length, 5);
});
test('omitted fields persist; explicit null removes instead of answering no', async () => {
  await save(
    payload({
      respostas: { planejamento: 'SIM', influenciaPromocional: 'SIM' },
    }),
  );
  const r = await save(
    payload({
      revisaoEsperada: 1,
      respostas: { influenciaPromocional: null, necessidadeInesperada: 'SIM' },
    }),
  );
  assert.deepEqual(r.respostas, {
    planejamento: 'SIM',
    necessidadeInesperada: 'SIM',
  });
  assert.equal(revisions[0].respostas.influenciaPromocional, 'SIM');
  assert.deepEqual(await read(), r);
});
test('removing the final answer leaves an explicit empty revision', async () => {
  await save();
  const r = await save(
    payload({ revisaoEsperada: 1, respostas: { planejamento: null } }),
  );
  assert.deepEqual(r.respostas, {});
  assert.equal(r.revisao, 2);
});
test('item-only context, carry forward, revise and remove planning', async () => {
  await save(
    payload({
      respostas: undefined,
      itens: [
        { itemId: 10, planejamento: 'SIM' },
        { itemId: 11, planejamento: 'NAO' },
      ],
    }),
  );
  const r = await save(
    payload({
      revisaoEsperada: 1,
      respostas: undefined,
      itens: [{ itemId: 10, planejamento: null }],
    }),
  );
  assert.deepEqual(r.itens, [{ itemId: 11, planejamento: 'NAO' }]);
  assert.equal(revisions[0].itens.length, 2);
});
test('deleted or foreign items, even removals, fail without creating a revision', async () => {
  items[0].compra_item_ativo = 0;
  for (const itemId of [10, 20, 999])
    await assert.rejects(
      save(payload({ itens: [{ itemId, planejamento: 'SIM' }] })),
      missing,
    );
  assert.equal(revisions.length, 0);
});

test('recurrence templates cannot receive purchase context; generated items can', async () => {
  items.push({
    compra_item_id: 30,
    compra_id: null,
    compra_recorrencia_id: 5,
    compra_item_ativo: 1,
  });
  await assert.rejects(
    save(payload({ itens: [{ itemId: 30, planejamento: 'SIM' }] })),
    missing,
  );
  assert.equal(revisions.length, 0);
  items.push({
    compra_item_id: 31,
    compra_id: 1,
    compra_recorrencia_id: null,
    compra_item_ativo: 1,
  });
  const result = await save(
    payload({ itens: [{ itemId: 31, planejamento: 'PARCIALMENTE' }] }),
  );
  assert.deepEqual(result.itens, [
    { itemId: 31, planejamento: 'PARCIALMENTE' },
  ]);
});
test('deleted/recreated items never inherit responses; history remains preserved', async () => {
  await save(payload({ itens: [{ itemId: 10, planejamento: 'SIM' }] }));
  items[0].compra_item_ativo = 0;
  items.push({ compra_item_id: 12, compra_id: 1, compra_item_ativo: 1 });
  assert.deepEqual((await read()).itens, []);
  assert.deepEqual((await save(payload({ revisaoEsperada: 1 }))).itens, []);
  assert.equal(revisions[0].itens[0].compra_item_id, 10);
});
test('cross-user and inactive purchase are hidden for reads and writes', async () => {
  await assert.rejects(read(2), missing);
  await assert.rejects(save(payload(), 2), missing);
  purchases[0].compra_ativo = 0;
  await assert.rejects(read(), missing);
  await assert.rejects(save(), missing);
  assert.equal(writes, 0);
});
test('same operation retries original revision even after newer updates', async () => {
  const p = payload();
  const first = await save(p);
  await save(
    payload({ revisaoEsperada: 1, respostas: { planejamento: 'NAO' } }),
  );
  assert.deepEqual(await save(p), first);
  assert.equal(revisions.length, 2);
  assert.equal((await read()).revisao, 2);
});
test('canonical key and item ordering allow equivalent retries', async () => {
  const p = payload({
    respostas: { planejamento: 'SIM', necessidadeInesperada: 'NAO' },
    itens: [
      { itemId: 11, planejamento: 'NAO' },
      { itemId: 10, planejamento: 'SIM' },
    ],
  });
  const first = await save(p);
  assert.deepEqual(
    await save({
      ...p,
      respostas: { necessidadeInesperada: 'NAO', planejamento: 'SIM' },
      itens: p.itens.slice().reverse(),
    }),
    first,
  );
  assert.equal(writes, 1);
});
test('operation key reuse with changed payload fails, including expected revision', async () => {
  const p = payload();
  await save(p);
  await assert.rejects(
    save({ ...p, respostas: { planejamento: 'NAO' } }),
    conflict,
  );
  await assert.rejects(save({ ...p, revisaoEsperada: 1 }), conflict);
  assert.equal(writes, 1);
});
test('stale expected revision fails without overwriting', async () => {
  await save();
  await assert.rejects(save(), conflict);
  assert.equal(writes, 1);
});
test('simulated concurrent edits: one wins and one conflicts', async () => {
  const results = await Promise.allSettled([save(), save()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    results.find((r) => r.status === 'rejected').reason.statusCode,
    409,
  );
  assert.equal(writes, 1);
});
test('simulated concurrent identical retries create only one revision', async () => {
  const p = payload();
  const results = await Promise.all([save(p), save(p)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(writes, 1);
});
test('persistence failure rolls back and operation can be retried', async () => {
  const p = payload();
  failCreate = true;
  await assert.rejects(save(p));
  assert.equal(writes, 0);
  failCreate = false;
  assert.equal((await save(p)).revisao, 1);
});
test('schemas reject empty patch, duplicate IDs, arbitrary answers and injected owner', () => {
  for (const p of [
    payload({ respostas: {} }),
    payload({ usuarioId: 2 }),
    payload({ respostas: { planejamento: true } }),
    payload({
      itens: [
        { itemId: 10, planejamento: 'SIM' },
        { itemId: 10, planejamento: 'NAO' },
      ],
    }),
    payload({ revisaoEsperada: -1 }),
    payload({ operacaoId: 'bad' }),
  ])
    assert.equal(atualizarContextoSchema.safeParse(p).success, false);
});
test('HTTP GET/PATCH expose versioned contract, no-store and revisions', async () => {
  assert.equal((await request()).status, 200);
  const r = await request('PATCH', payload());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await r.json()).revisao, 1);
  assert.equal((await (await request()).json()).revisao, 1);
});
test('HTTP rejects missing invalid expired or inactive authentication', async () => {
  for (const token of [
    null,
    'bad',
    jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: -1 }),
  ])
    assert.equal((await request('GET', undefined, { token })).status, 401);
  activeUser = false;
  assert.equal((await request()).status, 401);
  assert.equal(writes, 0);
});
test('HTTP validates parameters/body/query and ownership; conflicts are explicit', async () => {
  for (const path of ['/x/contexto', '/0/contexto', '/1/contexto?usuarioId=2'])
    assert.equal((await request('GET', undefined, { path })).status, 400);
  assert.equal((await request('PATCH', {})).status, 400);
  assert.equal((await request('PATCH', payload(), { userId: 2 })).status, 404);
  await save();
  assert.equal((await request('PATCH', payload())).status, 409);
});
test('HTTP operational failures are sanitized', async () => {
  failCreate = true;
  const r = await request('PATCH', payload());
  assert.equal(r.status, 500);
  assert.doesNotMatch(await r.text(), /private-database/);
});
test('HTTP invalid persisted output is a sanitized server error, not client validation failure', async () => {
  await save();
  revisions[0].respostas = { planejamento: 'INVALIDO' };
  const r = await request();
  assert.equal(r.status, 500);
  assert.doesNotMatch(await r.text(), /OUTPUT_INVALID|INVALIDO/);
});
test('HTTP questions are authenticated, user-isolated and reflect current partial item planning', async () => {
  items = items.map((i) => ({
    ...i,
    compra_item_nome: 'Item ' + i.compra_item_id,
  }));
  assert.equal(
    (await request('GET', undefined, { path: '/1/perguntas', token: null }))
      .status,
    401,
  );
  assert.equal(
    (await request('GET', undefined, { path: '/1/perguntas', userId: 2 }))
      .status,
    404,
  );
  await save(payload({ itens: [{ itemId: 10, planejamento: 'SIM' }] }));
  const res = await request('GET', undefined, { path: '/1/perguntas' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const b = await res.json();
  assert.equal(b.revisao, 1);
  assert.deepEqual(
    b.perguntas
      .filter((q) => q.codigo === 'planejamentoItem')
      .map((q) => q.itemId),
    [11],
  );
  items[1].compra_item_ativo = 0;
  const next = await (
    await request('GET', undefined, { path: '/1/perguntas' })
  ).json();
  assert.deepEqual(
    next.itens.map((i) => i.itemId),
    [10],
  );
  assert.equal(writes, 1);
});

test('revision history is read-only, user-isolated and keeps item answers after item exclusion', async () => {
  await save(
    payload({
      respostas: { planejamento: 'NAO' },
      itens: [{ itemId: 10, planejamento: 'NAO' }],
    }),
  );
  await save(
    payload({
      revisaoEsperada: 1,
      respostas: { planejamento: 'SIM' },
      itens: [{ itemId: 10, planejamento: 'SIM' }],
    }),
  );
  items[0].compra_item_ativo = 0;
  const h = await ContextoService.historico(1, 1);
  assert.deepEqual(
    h.revisoes.map((r) => r.revisao),
    [2, 1],
  );
  assert.equal(h.revisoes[1].itens[0].planejamento, 'NAO');
  assert.equal(h.revisoes[0].respostas.planejamento, 'SIM');
  assert.equal(writes, 2);
  assert.equal(
    (await ContextoService.historico(1, 1, 2)).revisoes[0].revisao,
    1,
  );
  await assert.rejects(ContextoService.historico(2, 1), missing);
  const response = await request('GET', undefined, {
    path: '/1/contexto/historico',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(
    (
      await request('GET', undefined, {
        path: '/1/contexto/historico?antes=bad',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('GET', undefined, {
        path: '/1/contexto/historico',
        token: null,
      })
    ).status,
    401,
  );
});

test('history pagination has a stable revision cursor and includes soft-deleted purchases', async () => {
  for (let i = 1; i <= 51; i++)
    revisions.push({
      compra_id: 1,
      usuario_id: 1,
      revisao: i,
      criada_em: new Date('2026-10-24T12:00:00Z'),
      respostas: {},
      itens: [],
    });
  purchases[0].compra_ativo = 0;
  const a = await ContextoService.historico(1, 1);
  assert.equal(a.revisoes.length, 50);
  assert.equal(a.proximaAntes, 2);
  const b = await ContextoService.historico(1, 1, a.proximaAntes);
  assert.equal(b.revisoes[0].revisao, 1);
  assert.equal(b.proximaAntes, null);
});
