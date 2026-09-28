import test from 'node:test';
import assert from 'node:assert/strict';

const { buildPurchaseEvidenceText, normalizePurchaseItemPrices, resolveSafeSingleItemPrice } = await import('../dist/src/modules/email/email-purchase.enrichment.js');
const { isCompleteAutomaticPurchase } = await import('../dist/src/modules/email/email-sync.service.js');

function purchase(overrides = {}) {
  return {
    establishment: 'Loja',
    orderNumber: 'ABC-1',
    totalAmount: 89.90,
    paymentMethod: { rawName: 'Pix' },
    items: [],
    invoice: null,
    evidence: [],
    ...overrides,
  };
}

test('item unico com nome e total correspondente recebe quantidade e unitPrice', () => {
  const result = resolveSafeSingleItemPrice(purchase({
    items: [{ name: 'Assinatura Premium', quantity: 1, unit: null, unitPrice: null, totalPrice: 89.90, categoryName: null }],
  }), 'Assinatura Premium - R$ 89,90');

  assert.equal(result.items[0].quantity, 1);
  assert.equal(result.items[0].unitPrice, 89.90);
});

test('textBody e usado quando bodyText nao existe', () => {
  const normalizedEmail = {
    subject: 'Pagamento aprovado',
    snippet: null,
    textBody: 'Assinatura Premium - R$ 89,90',
  };
  const result = resolveSafeSingleItemPrice(purchase({
    items: [{ name: 'Assinatura Premium', quantity: null, unit: null, unitPrice: null, totalPrice: 89.90, categoryName: null }],
  }), buildPurchaseEvidenceText(normalizedEmail));

  assert.equal(result.items[0].quantity, 1);
  assert.equal(result.items[0].unitPrice, 89.90);
});

test('item unico sem evidencia de nome nao e inventado', () => {
  const result = resolveSafeSingleItemPrice(purchase({
    items: [{ name: 'Compra', quantity: null, unit: null, unitPrice: null, totalPrice: null, categoryName: null }],
  }), 'Pagamento aprovado no valor de R$ 89,90');

  assert.equal(result.items[0].unitPrice, null);
  assert.equal(result.items[0].quantity, null);
});

test('frete ou desconto impedem usar total como valor unitario', () => {
  const result = resolveSafeSingleItemPrice(purchase({
    items: [{ name: 'Camiseta', quantity: 1, unit: null, unitPrice: null, totalPrice: 89.90, categoryName: null }],
  }), 'Camiseta R$ 79,90 Frete R$ 10,00 Total R$ 89,90');

  assert.equal(result.items[0].unitPrice, null);
});

test('totalPrice e quantidade resolvem unitPrice de item unico', () => {
  const result = normalizePurchaseItemPrices(purchase({
    items: [{ name: 'Produto', quantity: 1, unit: null, unitPrice: null, totalPrice: 59.90, categoryName: null }],
  }));

  assert.equal(result.items[0].unitPrice, 59.90);
});

test('totalPrice dividido pela quantidade resolve preco unitario', () => {
  const result = normalizePurchaseItemPrices(purchase({
    items: [{ name: 'Meias', quantity: 2, unit: null, unitPrice: null, totalPrice: 100, categoryName: null }],
  }));

  assert.equal(result.items[0].unitPrice, 50);
});

test('unitPrice existente nao e alterado pela normalizacao', () => {
  const result = normalizePurchaseItemPrices(purchase({
    items: [{ name: 'Produto', quantity: 2, unit: null, unitPrice: 40, totalPrice: 100, categoryName: null }],
  }));

  assert.equal(result.items[0].unitPrice, 40);
});

test('totalPrice ou quantidade invalidos nao geram unitPrice', () => {
  const invalidTotal = normalizePurchaseItemPrices(purchase({
    items: [{ name: 'Produto', quantity: 1, unit: null, unitPrice: null, totalPrice: 0, categoryName: null }],
  }));
  const invalidQuantity = normalizePurchaseItemPrices(purchase({
    items: [{ name: 'Produto', quantity: 0, unit: null, unitPrice: null, totalPrice: 100, categoryName: null }],
  }));

  assert.equal(invalidTotal.items[0].unitPrice, null);
  assert.equal(invalidQuantity.items[0].unitPrice, null);
});

test('totalPrice do item nao depende do total geral da compra nem de frete', () => {
  const result = normalizePurchaseItemPrices(purchase({
    totalAmount: 99.90,
    items: [{ name: 'Produto', quantity: 1, unit: null, unitPrice: null, totalPrice: 89.90, categoryName: null }],
  }));

  assert.equal(result.items[0].unitPrice, 89.90);
});

test('auto-confirmacao exige estabelecimento, total, pagamento, data e item persistido', () => {
  const date = new Date('2026-09-26T12:00:00Z');
  assert.equal(isCompleteAutomaticPurchase('Loja', 89.90, 1, 1, date, true, true), true);
  assert.equal(isCompleteAutomaticPurchase('Loja', 89.90, null, 1, date, true, true), false);
  assert.equal(isCompleteAutomaticPurchase('Loja', 89.90, 1, 0, date, true, true), false);
  assert.equal(isCompleteAutomaticPurchase(null, 89.90, 1, 1, date, true, true), false);
  assert.equal(isCompleteAutomaticPurchase('Loja', null, 1, 1, date, true, true), false);
  assert.equal(isCompleteAutomaticPurchase('Loja', 89.90, 1, 1, date, false, true), false);
  assert.equal(isCompleteAutomaticPurchase('Loja', 89.90, 1, 1, date, true, false), false);
  assert.equal(isCompleteAutomaticPurchase('Loja', 10, 1, 1, date, true, false), false);
});
