import '../saneamento/offline-env.mjs';
import '../saneamento/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

let user, writes, fail;
const forbidden = new Proxy({}, { get() { return () => { throw new Error('UNEXPECTED_HISTORY_WRITE'); }; } });
const client = {
  tb_usuario: {
    async findFirst({ where }) {
      return where.usuario_id === user.usuario_id && user.usuario_status ? { ...user } : null;
    },
    async update({ where, data }) {
      assert.equal(where.usuario_id, user.usuario_id);
      if (fail) throw new Error('private persistence failure');
      writes.push(structuredClone(data));
      Object.assign(user, data);
      return { ...user };
    },
  },
  tb_compra: forbidden, tb_notificacao: forbidden, tb_preferencia: forbidden,
};
globalThis.prismaRuntime = { client, pool: { end: async () => {} } };
const { usersRouter } = await import('../../src/modules/user/user.routes.ts');
const { updateUserSchema } = await import('../../src/modules/user/user.schemas.ts');
let server, base;
test.before(async () => {
  const app = express();
  app.use(express.json()); app.use('/users', usersRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/users`;
});
test.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
test.beforeEach(() => {
  user = { usuario_id: 1, usuario_status: true, usuario_nome: 'Teste', usuario_senha: 'fixture',
    usuario_meta_valor_compra: 200, usuario_meta_valor_mensal: 1000, usuario_meta_tempo: 60, usuario_limite_compra: 8 };
  writes = []; fail = false;
});
function request(payload, authenticated = true) {
  return fetch(base + (payload === undefined ? '/user' : ''), {
    method: payload === undefined ? 'GET' : 'PUT',
    headers: { 'Content-Type': 'application/json', ...(authenticated
      ? { Authorization: `Bearer ${jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' })}` } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

test('HTTP: null desativa somente o parâmetro e nova leitura confirma a persistência simulada', async () => {
  const before = { ...user };
  const response = await request({ metaValorCompra: null });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.usuario_meta_valor_compra, null);
  assert.equal(Object.hasOwn(body, 'usuario_senha'), false);
  assert.deepEqual(writes, [{ usuario_meta_valor_compra: null }]);
  assert.deepEqual(user, { ...before, usuario_meta_valor_compra: null });
  assert.equal((await (await request()).json()).usuario_meta_valor_compra, null);
});

for (const existing of [200, 0, null]) {
  test(`HTTP: omissão preserva valor legado ${existing}`, async () => {
    user.usuario_meta_valor_compra = existing;
    assert.equal((await request({ nome: 'Outro nome' })).status, 200);
    assert.equal(user.usuario_meta_valor_compra, existing);
    assert.deepEqual(writes, [{ usuario_nome: 'Outro nome' }]);
  });
}

test('HTTP: reativação positiva, centavos e zero legado preservam o contrato', async () => {
  for (const value of [null, 340.5, 0, 200]) {
    assert.equal((await request({ metaValorCompra: value })).status, 200);
    assert.equal((await (await request()).json()).usuario_meta_valor_compra, value);
  }
});

test('HTTP: ausência de sessão e entradas inválidas não escrevem', async () => {
  assert.equal((await request({ metaValorCompra: null }, false)).status, 401);
  for (const value of ['', '200', -1, {}, false]) assert.equal((await request({ metaValorCompra: value })).status, 400);
  assert.deepEqual(writes, []);
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(updateUserSchema.safeParse({ metaValorCompra: value }).success, false);
});

test('HTTP: falha de persistência não confirma remoção nem altera o valor', async () => {
  fail = true;
  const response = await request({ metaValorCompra: null });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private persistence/);
  assert.equal(user.usuario_meta_valor_compra, 200);
  assert.deepEqual(writes, []);
});

test('HTTP: remoção repetida é idempotente e atualizações parciais concorrentes são independentes', async () => {
  const responses = await Promise.all([request({ metaValorCompra: null }), request({ nome: 'Novo nome' })]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal((await request({ metaValorCompra: null })).status, 200);
  assert.equal(user.usuario_meta_valor_compra, null);
  assert.equal(user.usuario_nome, 'Novo nome');
  assert.equal(user.usuario_meta_valor_mensal, 1000);
  assert.equal(user.usuario_meta_tempo, 60);
});
