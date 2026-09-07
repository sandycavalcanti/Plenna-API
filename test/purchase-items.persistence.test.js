import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildNestedPurchaseItems,
  buildPersistedPurchaseItems,
  persistPurchaseItems,
  shouldPersistPurchaseItems,
} = await import('../dist/src/modules/email/purchase-items.persistence.js');

function item(overrides = {}) {
  return {
    name: 'Camiseta',
    quantity: 2,
    unitPrice: 39.9,
    totalPrice: 79.8,
    categoryName: null,
    ...overrides,
  };
}

function repository(categories = []) {
  const calls = [];
  return {
    calls,
    tb_categoria: {
      findMany: async (args) => {
        calls.push(args);
        return categories;
      },
    },
  };
}

test('persiste item valido usando unitPrice e quantidade', async () => {
  const result = await buildPersistedPurchaseItems([item()], repository());
  assert.equal(result.length, 1);
  assert.equal(result[0].compra_item_nome, 'Camiseta');
  assert.equal(result[0].compra_item_quantidade, 2);
  assert.equal(result[0].compra_item_valor.toString(), '39.9');
});

test('preserva quantidade ausente como null e nao usa totalPrice', async () => {
  const result = await buildPersistedPurchaseItems([item({ quantity: null, unitPrice: 10, totalPrice: 30 })], repository());
  assert.equal(result[0].compra_item_quantidade, null);
  assert.equal(result[0].compra_item_valor.toString(), '10');
});

test('quantidade invalida vira null sem descartar item valido', async () => {
  const result = await buildPersistedPurchaseItems([item({ quantity: 1.5 })], repository());
  assert.equal(result[0].compra_item_quantidade, null);
});

test('resolve categoria existente e deixa null quando nao encontra', async () => {
  const found = await buildPersistedPurchaseItems([item({ categoryName: 'Vestuario' })], repository([{ categoria_id: 9 }]));
  const missing = await buildPersistedPurchaseItems([item({ categoryName: 'Inexistente' })], repository());
  assert.equal(found[0].categoria_id, 9);
  assert.equal(missing[0].categoria_id, null);
});

test('categoria ambigua nao e escolhida arbitrariamente', async () => {
  const result = await buildPersistedPurchaseItems([item({ categoryName: 'Casa' })], repository([{ categoria_id: 1 }, { categoria_id: 2 }]));
  assert.equal(result[0].categoria_id, null);
});

test('descarta item sem nome ou sem unitPrice valido', async () => {
  const result = await buildPersistedPurchaseItems([
    item({ name: ' ' }),
    item({ unitPrice: null }),
    item({ unitPrice: 0 }),
    item({ unitPrice: Number.NaN }),
  ], repository());
  assert.deepEqual(result, []);
});

test('descarta somente itens invalidos e preserva os validos', async () => {
  const result = await buildPersistedPurchaseItems([
    item({ name: null }),
    item({ name: 'Calca', unitPrice: 59.99, quantity: 1 }),
  ], repository());
  assert.equal(result.length, 1);
  assert.equal(result[0].compra_item_nome, 'Calca');
});

test('trunca nome no limite de VARCHAR(45) de forma deterministica', async () => {
  const result = await buildPersistedPurchaseItems([item({ name: 'A'.repeat(60) })], repository());
  assert.equal(result[0].compra_item_nome.length, 45);
});

test('nested create carrega os campos corretos do item', () => {
  const nested = buildNestedPurchaseItems([{
    categoria_id: null,
    compra_item_nome: 'Camiseta',
    compra_item_valor: { toString: () => '39.90' },
    compra_item_quantidade: 2,
  }]);
  assert.equal(nested[0].compra_item_nome, 'Camiseta');
  assert.equal(nested[0].compra_item_quantidade, 2);
  assert.equal(nested[0].categoria_id, null);
});

test('itens so devem ser persistidos quando a compra ainda nao possui itens', () => {
  const items = [{ categoria_id: null, compra_item_nome: 'Produto', compra_item_valor: 10, compra_item_quantidade: null }];
  assert.equal(shouldPersistPurchaseItems(0, items), true);
  assert.equal(shouldPersistPurchaseItems(1, items), false);
  assert.equal(shouldPersistPurchaseItems(0, []), false);
});

test('persistPurchaseItems associa todos os itens a compra', async () => {
  let received = null;
  const repository = { tb_compra_item: { createMany: async (args) => { received = args.data; } } };
  await persistPurchaseItems(42, [{ categoria_id: null, compra_item_nome: 'Produto', compra_item_valor: 10, compra_item_quantidade: null }], repository);
  assert.equal(received[0].compra_id, 42);
});

test('falha na escrita dos itens propaga erro sem outra operação parcial da camada', async () => {
  let calls = 0;
  const repository = { tb_compra_item: { createMany: async () => { calls += 1; throw new Error('falha'); } } };
  await assert.rejects(() => persistPurchaseItems(42, [{ categoria_id: null, compra_item_nome: 'Produto', compra_item_valor: 10, compra_item_quantidade: null }], repository), /falha/);
  assert.equal(calls, 1);
});
