import assert from 'node:assert/strict';
import test from 'node:test';
import { APLICATIVOS_COMPRA, encontrarAplicativoCompra } from '../../src/modules/tempo-uso/aplicativos-compra.catalog.js';

test('cada aplicativo do catálogo canônico é aceito pelo lookup do sync', () => {
  assert.equal(new Set(APLICATIVOS_COMPRA.map(app => app.packageId)).size, APLICATIVOS_COMPRA.length);
  for (const app of APLICATIVOS_COMPRA) {
    assert.equal(encontrarAplicativoCompra(app.packageId), app);
    assert.ok(app.nomeApp.trim());
  }
});

test('package desconhecido não é autorizado', () => {
  assert.equal(encontrarAplicativoCompra('com.exemplo.loja'), undefined);
});
