import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';

const {
  buildPurchaseUpdate,
  findReconciliationMatch,
  normalizeMerchant,
  normalizeOrderNumber,
} = await import('../dist/src/modules/email/purchase-reconciliation.service.js');
const { messageAlreadyPersisted } = await import('../dist/src/modules/email/email-sync.service.js');
const { prisma } = await import('../dist/src/lib/prisma.js');

function purchase(overrides = {}) {
  return {
    compra_id: 1,
    usuario_id: 1,
    compra_fonte: 'Loja X',
    compra_pedido_externo_id: null,
    compra_valor: 89.8,
    forma_pagamento_id: null,
    compra_email_mensagem_id: 'original-message',
    compra_horario: new Date('2026-09-02T12:00:00Z'),
    tb_compra_item: [],
    ...overrides,
  };
}

function extracted(overrides = {}) {
  return {
    establishment: ' loja x ',
    orderNumber: null,
    totalAmount: 89.8,
    paymentMethod: { rawName: null },
    items: [],
    invoice: null,
    evidence: [],
    ...overrides,
  };
}

test('normaliza estabelecimento e pedido sem fuzzy matching destrutivo', () => {
  assert.equal(normalizeMerchant('  Loja X  '), 'loja x');
  assert.equal(normalizeMerchant('São João'), 'sao joao');
  assert.equal(normalizeOrderNumber(' V91329869CEA-01 '), 'v91329869cea-01');
  assert.equal(normalizeOrderNumber('ABC-123'), 'abc-123');
});

test('mesmo usuario, loja e pedido reconcilia uma compra', () => {
  const match = findReconciliationMatch(
    [purchase({ compra_pedido_externo_id: 'V91329869CEA-01' })],
    1,
    extracted({ orderNumber: 'v91329869cea-01' }),
    new Date('2026-09-05T12:00:00Z'),
    24,
  );

  assert.equal(match?.purchase.compra_id, 1);
  assert.equal(match?.reason, 'ORDER_NUMBER');
});

test('mesmo pedido em loja diferente nao reconcilia', () => {
  const match = findReconciliationMatch(
    [purchase({ compra_fonte: 'Loja Y', compra_pedido_externo_id: 'ABC123' })],
    1,
    extracted({ orderNumber: 'ABC123' }),
    new Date('2026-09-02T12:00:00Z'),
    24,
  );
  assert.equal(match, null);
});

test('mesmo pedido em usuario diferente nao reconcilia', () => {
  const match = findReconciliationMatch(
    [purchase({ usuario_id: 2, compra_pedido_externo_id: 'ABC123' })],
    1,
    extracted({ orderNumber: 'ABC123' }),
    new Date('2026-09-02T12:00:00Z'),
    24,
  );
  assert.equal(match, null);
});

test('pedido externo diferente nao reconcilia', () => {
  const match = findReconciliationMatch(
    [purchase({ compra_pedido_externo_id: 'ABC123' })],
    1,
    extracted({ orderNumber: 'XYZ789' }),
    new Date('2026-09-02T12:00:00Z'),
    24,
  );
  assert.equal(match, null);
});

test('fallback sem pedido nao reconcilia sem itens persistidos', () => {
  const match = findReconciliationMatch(
    [purchase()],
    1,
    extracted(),
    new Date('2026-09-03T11:00:00Z'),
    24,
  );
  assert.equal(match, null);
});

test('fallback sem pedido nao reconcilia quando o email nao possui itens', () => {
  const match = findReconciliationMatch(
    [purchase({
      tb_compra_item: [{ compra_item_nome: 'Produto', compra_item_quantidade: 1, compra_item_valor: 89.8 }],
    })],
    1,
    extracted(),
    new Date('2026-09-02T13:00:00Z'),
    24,
  );
  assert.equal(match, null);
});

test('compra recorrente em mes diferente nao e fundida', () => {
  const match = findReconciliationMatch(
    [purchase({
      compra_horario: new Date('2026-08-05T12:00:00Z'),
      tb_compra_item: [{ compra_item_nome: 'Produto', compra_item_quantidade: 1, compra_item_valor: 89.8 }],
    })],
    1,
    extracted({ items: [{ name: 'Produto', quantity: 1, unitPrice: null, totalPrice: 89.8, categoryName: null }] }),
    new Date('2026-09-05T12:00:00Z'),
    24,
  );
  assert.equal(match, null);
});

test('fallback ambiguo com duas compras nao escolhe arbitrariamente', () => {
  const match = findReconciliationMatch(
    [purchase({ compra_id: 1 }), purchase({ compra_id: 2 })],
    1,
    extracted(),
    new Date('2026-09-02T13:00:00Z'),
    24,
  );
  assert.equal(match, null);
});

test('itens sao comparados sem depender da ordem quando ambos existem', () => {
  const match = findReconciliationMatch(
    [purchase({
      tb_compra_item: [
        { compra_item_nome: 'Calça', compra_item_quantidade: 1, compra_item_valor: 30 },
        { compra_item_nome: 'Camiseta', compra_item_quantidade: 2, compra_item_valor: 59.8 },
      ],
    })],
    1,
    extracted({
      items: [
        { name: 'Camiseta', quantity: 2, unitPrice: null, totalPrice: 59.8, categoryName: null },
        { name: 'Calça', quantity: 1, unitPrice: null, totalPrice: 30, categoryName: null },
      ],
    }),
    new Date('2026-09-02T13:00:00Z'),
    24,
  );
  assert.equal(match?.reason, 'FALLBACK');
});

test('itens ausentes na compra Gmail nao sao inventados para comparar', () => {
  const match = findReconciliationMatch(
    [purchase()],
    1,
    extracted({ items: [{ name: 'Produto', quantity: 2, unitPrice: null, totalPrice: 89.8, categoryName: null }] }),
    new Date('2026-09-02T13:00:00Z'),
    24,
  );
  assert.equal(match, null);
});

test('itens diferentes nao reconciliam o fallback', () => {
  const match = findReconciliationMatch(
    [purchase({
      tb_compra_item: [{ compra_item_nome: 'Calca', compra_item_quantidade: 1, compra_item_valor: 89.8 }],
    })],
    1,
    extracted({ items: [{ name: 'Camiseta', quantity: 1, unitPrice: null, totalPrice: 89.8, categoryName: null }] }),
    new Date('2026-09-02T13:00:00Z'),
    24,
  );
  assert.equal(match, null);
});

test('preenche pedido, fonte, valor e pagamento somente em lacunas', () => {
  const update = buildPurchaseUpdate(
    purchase({ compra_fonte: null, compra_pedido_externo_id: null, compra_valor: null, forma_pagamento_id: null }),
    extracted({ establishment: 'Loja X', orderNumber: 'ABC123', totalAmount: 10 }),
    7,
  );
  assert.deepEqual(update, {
    compra_pedido_externo_id: 'ABC123',
    compra_fonte: 'Loja X',
    compra_valor: 10,
    forma_pagamento_id: 7,
  });
});

test('conflitos nao sobrescrevem valores persistidos', () => {
  const update = buildPurchaseUpdate(
    purchase({ compra_fonte: 'Loja Original', compra_pedido_externo_id: 'ORIGINAL', compra_valor: 50, forma_pagamento_id: 2 }),
    extracted({ establishment: 'Outra Loja', orderNumber: 'DIFERENTE', totalAmount: 99 }),
    8,
  );
  assert.deepEqual(update, {});
});

test('message ID original permanece preservado no modelo simplificado', () => {
  const existing = purchase();
  const update = buildPurchaseUpdate(existing, extracted({ orderNumber: 'ABC123' }), null);
  assert.equal(existing.compra_email_mensagem_id, 'original-message');
  assert.equal('compra_email_mensagem_id' in update, false);
});

test('mesma mensagem Gmail e ignorada antes de nova classificacao', async () => {
  const originalPurchaseFind = prisma.tb_compra.findFirst;
  const originalPromotionFind = prisma.tb_propaganda.findFirst;
  prisma.tb_compra.findFirst = async () => ({ compra_id: 1 });
  prisma.tb_propaganda.findFirst = async () => null;

  try {
    assert.equal(await messageAlreadyPersisted(1, 'same-message'), true);
  } finally {
    prisma.tb_compra.findFirst = originalPurchaseFind;
    prisma.tb_propaganda.findFirst = originalPromotionFind;
  }
});
