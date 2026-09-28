import test from 'node:test';
import assert from 'node:assert/strict';

const { testMarkerFromMessage } = await import('../dist/src/modules/email/email-sync.service.js');

const message = (subject) => ({
  id: 'test-message',
  subject,
});

test('normaliza marcador numerico do fixture HTML-003', () => {
  assert.equal(
    testMarkerFromMessage(message('[PLENNA TEST 03] Seu pedido foi confirmado')),
    'HTML-003',
  );
});

test('normaliza marcador numerico do fixture HTML-001', () => {
  assert.equal(
    testMarkerFromMessage(message('[PLENNA TEST 01] Pedido confirmado')),
    'HTML-001',
  );
});

test('mantem compatibilidade com marcador antigo', () => {
  assert.equal(
    testMarkerFromMessage(message('[PLENNA TEST HTML-003] Pedido confirmado')),
    'HTML-003',
  );
});
