import test from 'node:test';
import assert from 'node:assert/strict';

const { mergePurchaseSources, parseFiscalAttachments } = await import('../dist/src/modules/email/purchase-source.merge.js');
const { GmailAttachmentError } = await import('../dist/src/modules/email/gmail.attachment.js');

function purchase(overrides = {}) {
  return {
    establishment: 'Loja Email',
    orderNumber: 'PED-1',
    totalAmount: 90,
    paymentMethod: { rawName: 'Pix' },
    items: [{ name: 'Item email', quantity: 1, unit: null, unitPrice: 90, totalPrice: null, categoryName: null }],
    invoice: null,
    evidence: [],
    ...overrides,
  };
}

function nfe(overrides = {}) {
  return {
    number: '123',
    accessKey: '35123456789012345678901234567890123456789012',
    issuedAt: null,
    issuer: { name: 'Loja Fiscal', cnpj: '12345678000199' },
    totalAmount: 47.99,
    freightAmount: 0,
    discountAmount: 0,
    items: [{ name: 'Item fiscal', quantity: 0.5, unit: 'KG', unitPrice: 8, totalPrice: 4 }],
    payments: [],
    ...overrides,
  };
}

function danfe(overrides = {}) {
  return {
    number: '456',
    accessKey: null,
    issuedAt: null,
    issuer: { name: 'Loja Danfe', cnpj: '98765432000199' },
    totalAmount: 80,
    freightAmount: null,
    discountAmount: null,
    items: [{ name: 'Item danfe', quantity: 2, unit: 'UN', unitPrice: 40, totalPrice: 80 }],
    payment: null,
    ...overrides,
  };
}

test('merge fiscal por campo preserva pedido do ecommerce e escolhe XML', () => {
  const result = mergePurchaseSources(purchase({ totalAmount: 59.99 }), null, { nfe: [nfe()], danfe: [danfe()] });
  assert.equal(result.establishment, 'Loja Fiscal');
  assert.equal(result.orderNumber, 'PED-1');
  assert.equal(result.totalAmount, 47.99);
  assert.equal(result.invoice.number, '123');
  assert.equal(result.invoice.accessKey, nfe().accessKey);
  assert.deepEqual(result.items, [{ name: 'Item fiscal', quantity: 0.5, unit: 'KG', unitPrice: 8, totalPrice: 4, categoryName: null }]);
});

test('DANFE preenche total e itens quando XML nao fornece esses dados', () => {
  const result = mergePurchaseSources(purchase(), null, {
    nfe: [nfe({ totalAmount: null, items: [] })],
    danfe: [danfe({ number: '123', accessKey: nfe().accessKey, issuer: nfe().issuer })],
  });
  assert.equal(result.totalAmount, 80);
  assert.equal(result.establishment, 'Loja Fiscal');
  assert.equal(result.items[0].name, 'Item danfe');
});

test('email permanece como fallback de pagamento quando fiscal esta ausente', () => {
  const result = mergePurchaseSources(purchase({ paymentMethod: { rawName: 'Pix' } }), null, { nfe: [nfe()], danfe: [] });
  assert.equal(result.paymentMethod.rawName, 'Pix');
});

test('pagamento fiscal unico e canonico vence email divergente', () => {
  const result = mergePurchaseSources(purchase({ paymentMethod: { rawName: 'Pix' } }), null, {
    nfe: [nfe({ payments: [{ code: '03', name: 'Cartão de crédito', amount: 47.99 }] })],
    danfe: [],
  });
  assert.equal(result.paymentMethod.rawName, 'Cartão de crédito');
});

test('pagamentos fiscais multiplos nao sao reduzidos arbitrariamente', () => {
  const result = mergePurchaseSources(purchase({ paymentMethod: { rawName: 'Pix' } }), null, {
    nfe: [nfe({ payments: [
      { code: '03', name: 'Cartão de crédito', amount: 20 },
      { code: '17', name: 'PIX', amount: 27.99 },
    ] })],
    danfe: [],
  });
  assert.equal(result.paymentMethod.rawName, 'Pix');
});

test('Requesty preenche lacunas somente quando nao existe fonte superior', () => {
  const result = mergePurchaseSources(purchase({ establishment: null, orderNumber: null, totalAmount: null, paymentMethod: { rawName: null }, items: [] }), {
    establishment: 'Loja IA',
    orderNumber: 'IA-1',
    totalAmount: 12,
    paymentMethodName: 'Boleto',
    items: [{ name: 'Item IA', quantity: 1, unitPrice: 12, totalPrice: null, categoryName: null }],
  }, { nfe: [], danfe: [] });
  assert.equal(result.establishment, 'Loja IA');
  assert.equal(result.orderNumber, 'IA-1');
  assert.equal(result.totalAmount, 12);
  assert.equal(result.paymentMethod.rawName, 'Boleto');
  assert.equal(result.items[0].name, 'Item IA');
});

test('pedido do email nao e substituido pelo numero fiscal da nota', () => {
  const result = mergePurchaseSources(purchase({ orderNumber: 'v91329869cea-01' }), null, { nfe: [nfe({ number: '999999' })], danfe: [] });
  assert.equal(result.orderNumber, 'v91329869cea-01');
  assert.equal(result.invoice.number, '999999');
});

test('itens fiscais nao sao concatenados com itens do email', () => {
  const result = mergePurchaseSources(purchase(), null, { nfe: [nfe()], danfe: [] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, 'Item fiscal');
});

test('multiplos XMLs com identidades diferentes nao formam Frankenstein fiscal', () => {
  const result = mergePurchaseSources(purchase(), null, { nfe: [nfe(), nfe({ number: '999' })], danfe: [] });
  assert.equal(result.totalAmount, 90);
  assert.equal(result.invoice, null);
  assert.equal(result.items[0].name, 'Item email');
});

test('anexo fiscal invalido e isolado sem impedir fontes do email', async () => {
  let downloads = 0;
  const result = await parseFiscalAttachments([
    { attachmentId: 'bad', filename: 'nota.xml', mimeType: 'application/xml', size: 10 },
    { attachmentId: null, filename: 'imagem.png', mimeType: 'image/png', size: 10 },
  ], async () => {
    downloads += 1;
    return { bytes: Buffer.from('<xml-invalido>') };
  });
  assert.equal(downloads, 1);
  assert.deepEqual(result, { nfe: [], danfe: [] });
});

test('XML e DANFE com a mesma chave podem compartilhar campos ausentes', () => {
  const result = mergePurchaseSources(purchase({ totalAmount: 10 }), null, {
    nfe: [nfe({ number: null, accessKey: nfe().accessKey, totalAmount: null })],
    danfe: [danfe({ number: '123', accessKey: nfe().accessKey, totalAmount: 47.99 })],
  });
  assert.equal(result.invoice.number, '123');
  assert.equal(result.totalAmount, 47.99);
});

test('XML e DANFE com chaves diferentes nao sao combinados', () => {
  const result = mergePurchaseSources(purchase({ totalAmount: 90 }), null, {
    nfe: [nfe({ number: '111', accessKey: null, totalAmount: null, items: [], issuer: { name: 'XML A', cnpj: '11111111000111' } })],
    danfe: [danfe({ number: '222', accessKey: '99999999999999999999999999999999999999999999', totalAmount: 150, items: [] })],
  });
  assert.equal(result.invoice.number, '111');
  assert.equal(result.invoice.accessKey, null);
  assert.equal(result.totalAmount, 90);
});

test('sem chave, mesmo numero e CNPJ confirmam compatibilidade fiscal', () => {
  const result = mergePurchaseSources(purchase({ totalAmount: 10 }), null, {
    nfe: [nfe({ number: '123', accessKey: null, totalAmount: null, issuer: { name: 'XML', cnpj: '11111111000111' } })],
    danfe: [danfe({ number: '123', accessKey: null, totalAmount: 80, issuer: { name: 'DANFE', cnpj: '11111111000111' } })],
  });
  assert.equal(result.totalAmount, 80);
  assert.equal(result.invoice.number, '123');
});

test('sem chave, numero diferente impede complementar XML', () => {
  const result = mergePurchaseSources(purchase({ totalAmount: 10 }), null, {
    nfe: [nfe({ number: '123', accessKey: null, totalAmount: null, items: [], issuer: { name: 'XML', cnpj: '11111111000111' } })],
    danfe: [danfe({ number: '456', accessKey: null, totalAmount: 80, issuer: { name: 'DANFE', cnpj: '11111111000111' }, items: [] })],
  });
  assert.equal(result.totalAmount, 10);
  assert.equal(result.invoice.number, '123');
});

test('total igual sozinho nao identifica a mesma NF-e', () => {
  const result = mergePurchaseSources(purchase({ totalAmount: 90 }), null, {
    nfe: [nfe({ number: null, accessKey: null, totalAmount: 90, issuer: { name: null, cnpj: null }, items: [] })],
    danfe: [danfe({ number: null, accessKey: null, totalAmount: 90, issuer: { name: null, cnpj: null }, items: [] })],
  });
  assert.equal(result.invoice.type, 'NFE_XML');
  assert.equal(result.invoice.number, null);
  assert.equal(result.invoice.accessKey, null);
  assert.equal(result.totalAmount, 90);
});

test('DANFE com chave sem identidade suficiente nao complementa XML sem chave', () => {
  const result = mergePurchaseSources(purchase({ totalAmount: 10 }), null, {
    nfe: [nfe({ number: '123', accessKey: null, totalAmount: null, items: [], issuer: { name: 'XML', cnpj: '11111111000111' } })],
    danfe: [danfe({ number: null, accessKey: '99999999999999999999999999999999999999999999', totalAmount: 80, items: [] })],
  });
  assert.equal(result.totalAmount, 10);
  assert.equal(result.invoice.accessKey, null);
});

test('DANFE conflitante nao substitui pagamento ou itens inferiores', () => {
  const result = mergePurchaseSources(purchase({ totalAmount: 90, paymentMethod: { rawName: 'Pix' } }), null, {
    nfe: [nfe({ number: '111', accessKey: null, totalAmount: null, items: [], payments: [], issuer: { name: 'XML', cnpj: '11111111000111' } })],
    danfe: [danfe({ number: '222', accessKey: null, totalAmount: 150, payment: 'Boleto', items: [] })],
  });
  assert.equal(result.paymentMethod.rawName, 'Pix');
  assert.equal(result.items[0].name, 'Item email');
});

test('somente DANFE e somente XML preservam o comportamento de fonte fiscal', () => {
  const onlyDanfe = mergePurchaseSources(purchase(), null, { nfe: [], danfe: [danfe()] });
  const onlyXml = mergePurchaseSources(purchase(), null, { nfe: [nfe()], danfe: [] });
  assert.equal(onlyDanfe.totalAmount, 80);
  assert.equal(onlyXml.totalAmount, 47.99);
});

test('erro conhecido de attachment e isolado, erro inesperado propaga', async () => {
  const known = await parseFiscalAttachments([
    { attachmentId: 'bad', filename: 'nota.xml', mimeType: 'application/xml', size: 10 },
  ], async () => { throw new GmailAttachmentError('falha segura'); });
  assert.deepEqual(known, { nfe: [], danfe: [] });

  await assert.rejects(
    () => parseFiscalAttachments([
      { attachmentId: 'unexpected', filename: 'nota.xml', mimeType: 'application/xml', size: 10 },
    ], async () => { throw new TypeError('erro de programacao'); }),
    TypeError,
  );
});
