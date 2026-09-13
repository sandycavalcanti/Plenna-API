import assert from 'node:assert/strict';
import test from 'node:test';
import { APLICATIVOS_COMPRA, encontrarAplicativoCompra } from '../../src/modules/tempo-uso/aplicativos-compra.catalog.js';

test('não inventa package IDs antes da aprovação do catálogo', () => {
  assert.deepEqual(APLICATIVOS_COMPRA, []);
  assert.equal(encontrarAplicativoCompra('com.exemplo.loja'), undefined);
});
