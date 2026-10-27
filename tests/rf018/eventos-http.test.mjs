import '../saneamento/offline-env.mjs';
import '../saneamento/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

// A autenticação pode verificar a conta; IDs inválidos não devem consultar compras ou eventos.
globalThis.prismaRuntime = {
  client: new Proxy({}, { get(_target, key) {
    if (key === 'tb_usuario') return { findFirst: async () => ({ usuario_id: 1 }) };
    throw Error('UNEXPECTED_DATABASE_ACCESS');
  } }),
  pool: { end: async () => {} },
};
const { eventosCompraRouter } = await import('../../src/modules/compra/eventos.routes.ts');
let server, base;
test.before(async () => {
  const app = express();
  app.use('/v2/compras', eventosCompraRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/v2/compras`;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
test('eventos rejeitam IDs fora do INTEGER sem consultar dados privados', async () => {
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: 1 }, process.env.JWT_SECRET)}` };
  for (const path of ['/2147483648/eventos', '/2147483648/referencias', '/resumos?ids=1,2147483648']) {
    assert.equal((await fetch(base + path, { headers })).status, 400);
  }
});
test('resumos continuam exigindo autenticação antes da validação', async () => {
  assert.equal((await fetch(base + '/resumos?ids=1')).status, 401);
});
