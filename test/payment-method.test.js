import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? 'postgresql://localhost:5432/plenna_test';

const { normalizePaymentMethodName } = await import('../dist/src/modules/forma-pagamento/payment-method.normalizer.js');
const { PaymentMethodResolver } = await import('../dist/src/modules/forma-pagamento/payment-method.resolver.js');

function repository(rows) {
  const calls = { findMany: 0, create: 0, update: 0, upsert: 0 };
  return {
    calls,
    tb_forma_pagamento: {
      findMany: async () => {
        calls.findMany += 1;
        return rows;
      },
      create: async () => { calls.create += 1; },
      update: async () => { calls.update += 1; },
      upsert: async () => { calls.upsert += 1; },
    },
  };
}

test('normaliza aliases de Pix', () => {
  assert.equal(normalizePaymentMethodName('Pix'), 'Pix');
  assert.equal(normalizePaymentMethodName('PIX'), 'Pix');
  assert.equal(normalizePaymentMethodName(' pix '), 'Pix');
  assert.equal(normalizePaymentMethodName('Pix - pagamento instantâneo'), 'Pix');
});

test('normaliza aliases de crédito', () => {
  assert.equal(normalizePaymentMethodName('Cartão de crédito'), 'Cartão de crédito');
  assert.equal(normalizePaymentMethodName('cartao de credito'), 'Cartão de crédito');
  assert.equal(normalizePaymentMethodName('cartao credito'), 'Cartão de crédito');
  assert.equal(normalizePaymentMethodName('credito'), 'Cartão de crédito');
});

test('normaliza aliases de débito', () => {
  assert.equal(normalizePaymentMethodName('Cartão de débito'), 'Cartão de débito');
  assert.equal(normalizePaymentMethodName('cartao debito'), 'Cartão de débito');
  assert.equal(normalizePaymentMethodName('debito'), 'Cartão de débito');
});

test('normaliza boleto e PayPal', () => {
  assert.equal(normalizePaymentMethodName('Boleto'), 'Boleto');
  assert.equal(normalizePaymentMethodName('boleto bancário'), 'Boleto');
  assert.equal(normalizePaymentMethodName('paypal'), 'PayPal');
});

test('mantém comportamento conservador para nomes ambíguos ou desconhecidos', () => {
  assert.equal(normalizePaymentMethodName('cartão'), null);
  assert.equal(normalizePaymentMethodName(''), null);
  assert.equal(normalizePaymentMethodName(null), null);
  assert.equal(normalizePaymentMethodName('forma desconhecida'), null);
});

test('remove detalhes secundários sem guardar dígitos do cartão', () => {
  assert.equal(normalizePaymentMethodName('Cartão de crédito final 1234'), 'Cartão de crédito');
  assert.equal(normalizePaymentMethodName('Cartão de débito **** 9876'), 'Cartão de débito');
});

test('resolver retorna ID e nome real do registro existente', async () => {
  const db = repository([{ forma_pagamento_id: 17, forma_pagamento_nome: 'PIX' }]);
  const result = await PaymentMethodResolver.resolve(' pix ', db);
  assert.deepEqual(result, { id: 17, name: 'PIX' });
  assert.equal(db.calls.findMany, 1);
  assert.equal(db.calls.create, 0);
  assert.equal(db.calls.update, 0);
  assert.equal(db.calls.upsert, 0);
});

test('resolver compara nomes do banco sem depender de caixa ou acentos', async () => {
  const db = repository([{ forma_pagamento_id: 28, forma_pagamento_nome: 'cartao credito' }]);
  const result = await PaymentMethodResolver.resolve('Cartão de Crédito', db);
  assert.deepEqual(result, { id: 28, name: 'cartao credito' });
});

test('resolver retorna null sem consultar banco para null ou vazio', async () => {
  const db = repository([]);
  assert.equal(await PaymentMethodResolver.resolve(null, db), null);
  assert.equal(await PaymentMethodResolver.resolve('   ', db), null);
  assert.equal(db.calls.findMany, 0);
});

test('resolver retorna null para forma inexistente e não cria registro', async () => {
  const db = repository([{ forma_pagamento_id: 17, forma_pagamento_nome: 'Pix' }]);
  assert.equal(await PaymentMethodResolver.resolve('Klarna', db), null);
  assert.equal(db.calls.findMany, 0);
  assert.equal(db.calls.create, 0);
  assert.equal(db.calls.update, 0);
  assert.equal(db.calls.upsert, 0);
});

test('resolver retorna null quando há registros canônicos duplicados', async () => {
  const db = repository([
    { forma_pagamento_id: 1, forma_pagamento_nome: 'Pix' },
    { forma_pagamento_id: 2, forma_pagamento_nome: 'PIX' },
  ]);
  assert.equal(await PaymentMethodResolver.resolve('Pix', db), null);
});
