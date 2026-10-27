import '../saneamento/offline-env.mjs';
import '../saneamento/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

const db = {
  tb_usuario: { findFirst: async () => ({ usuario_id: 1 }) },
  tb_compra: {
    findMany: async () => [{ compra_id: 10, compra_classificacao: 'PENDENTE' }],
  },
  tb_compra_evento: { findMany: async () => [] },
  contexto_compra_revisao: { findMany: async () => [] },
  $transaction: async (fn) => fn(db),
};
globalThis.prismaRuntime = { client: db, pool: { end: async () => {} } };

const { eventosCompraRouter } = await import('../../src/modules/compra/eventos.routes.ts');

test('purchase summaries use the consolidated event and context contract', async () => {
  const app = express();
  app.use('/v2/compras', eventosCompraRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/v2/compras/resumos?ids=10`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${jwt.sign({ userId: 1 }, process.env.JWT_SECRET)}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.resumos[0].compraId, 10);
    assert.equal(body.resumos[0].contextoRevisao, 0);
    assert.equal(body.resumos[0].revisao, 0);
    assert.equal(body.resumos[0].classificacao, 'PENDENTE');
    assert.equal('eventosDisponiveis' in body.resumos[0], false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
