import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.REQUESTY_API_KEY = process.env.REQUESTY_API_KEY ?? 'requesty-key';

const axios = (await import('axios')).default;
const { RequestyProvider } = await import('../dist/src/modules/email/requesty.provider.js');
const { mergeExtractedPurchase, needsAiEnrichment, buildPurchaseExtractionPrompt } = await import('../dist/src/modules/email/email-purchase.enrichment.js');

const email = (textBody = '', overrides = {}) => ({
  id: 'enrichment-test',
  threadId: null,
  subject: 'Pedido confirmado',
  from: 'Loja Teste <vendas@example.com>',
  to: 'cliente@example.com',
  snippet: 'Pagamento aprovado',
  internalDate: null,
  labelIds: [],
  textBody,
  htmlBody: null,
  links: [],
  attachments: [],
  ...overrides,
});

const purchase = (overrides = {}) => ({
  establishment: null,
  orderNumber: null,
  totalAmount: null,
  paymentMethod: { rawName: null },
  items: [],
  invoice: null,
  evidence: [],
  ...overrides,
});

const aiPurchase = (overrides = {}) => ({
  establishment: null,
  orderNumber: null,
  totalAmount: null,
  paymentMethodName: null,
  items: [],
  ...overrides,
});

test('Requesty extrai uma compra completa pelo contrato dedicado', async () => {
  const originalPost = axios.post;
  const originalKey = process.env.REQUESTY_API_KEY;
  process.env.REQUESTY_API_KEY = 'key';
  let request;
  axios.post = async (_url, body) => {
    request = body;
    return {
      data: {
        choices: [{ message: { content: JSON.stringify({
          establishment: 'Loja Exemplo',
          orderNumber: 'ABC123',
          totalAmount: 89.8,
          paymentMethodName: 'Cartão de crédito',
          items: [{ name: 'Camiseta', quantity: 2, unitPrice: 39.9, totalPrice: 79.8, categoryName: null }],
        }) } }],
      },
    };
  };

  const result = await new RequestyProvider().extractPurchase(buildPurchaseExtractionPrompt(email('Total da compra: R$ 89,80')));

  assert.equal(result.totalAmount, 89.8);
  assert.equal(result.items[0].name, 'Camiseta');
  assert.match(request.messages[1].content, /EXTRAINDO/);
  assert.match(request.messages[1].content, /totalAmount/);
  axios.post = originalPost;
  process.env.REQUESTY_API_KEY = originalKey;
});

test('prompt envia somente subject, from, snippet e textBody', () => {
  const prompt = buildPurchaseExtractionPrompt(email('Texto útil', {
    subject: 'Assunto',
    from: 'Loja <loja@example.com>',
    snippet: 'Resumo',
    htmlBody: '<script>segredo</script>',
    attachments: [{ attachmentId: 'att', filename: 'nota.xml', mimeType: 'application/xml', size: 1 }],
  }));
  assert.match(prompt, /subject: Assunto/);
  assert.match(prompt, /from: Loja <loja@example.com>/);
  assert.match(prompt, /snippet: Resumo/);
  assert.match(prompt, /textBody: Texto útil/);
  assert.doesNotMatch(prompt, /segredo|nota.xml|attachmentId/);
});

test('Requesty aplica defaults nulos e aceita purchase parcial válida', async () => {
  const originalPost = axios.post;
  axios.post = async () => ({ data: { choices: [{ message: { content: JSON.stringify({ totalAmount: 47.99 }) } }] } });
  const result = await new RequestyProvider().extractPurchase('texto');
  assert.deepEqual(result, {
    establishment: null,
    orderNumber: null,
    totalAmount: 47.99,
    paymentMethodName: null,
    items: [],
  });
  axios.post = originalPost;
});

test('Requesty rejeita respostas inválidas', async () => {
  const originalPost = axios.post;
  const invalidResponses = [
    'not-json',
    JSON.stringify({ unexpected: true }),
    JSON.stringify({ totalAmount: -1 }),
    JSON.stringify({ items: [{ name: 'Item', quantity: -2 }] }),
    JSON.stringify({ items: [{ name: 42 }] }),
    JSON.stringify({ establishment: 'x'.repeat(121) }),
  ];

  for (const content of invalidResponses) {
    axios.post = async () => ({ data: { choices: [{ message: { content } }] } });
    await assert.rejects(() => new RequestyProvider().extractPurchase('texto'));
  }
  axios.post = originalPost;
});

test('Requesty aceita todos os campos nulos e resposta completa', async () => {
  const originalPost = axios.post;
  axios.post = async () => ({ data: { choices: [{ message: { content: JSON.stringify({
    establishment: null,
    orderNumber: null,
    totalAmount: null,
    paymentMethodName: null,
    items: [],
  }) } }] } });
  const empty = await new RequestyProvider().extractPurchase('texto');
  assert.equal(empty.totalAmount, null);

  axios.post = async () => ({ data: { choices: [{ message: { content: JSON.stringify({
    establishment: 'Loja',
    orderNumber: 'ABC123',
    totalAmount: 89.8,
    paymentMethodName: 'Pix',
    items: [{ name: 'Produto', quantity: 1, unitPrice: 89.8, totalPrice: null, categoryName: null }],
  }) } }] } });
  const complete = await new RequestyProvider().extractPurchase('texto');
  assert.equal(complete.orderNumber, 'ABC123');
  assert.equal(complete.items[0].quantity, 1);
  axios.post = originalPost;
});

test('falha HTTP do Requesty não vira dado extraído', async () => {
  const originalPost = axios.post;
  axios.post = async () => { throw new Error('timeout'); };
  await assert.rejects(() => new RequestyProvider().extractPurchase('texto'), /timeout/);
  axios.post = originalPost;
});

test('needsAiEnrichment identifica lacunas e compra completa', () => {
  assert.equal(needsAiEnrichment(purchase()), true);
  assert.equal(needsAiEnrichment(purchase({
    establishment: 'C&A',
    orderNumber: 'ABC123',
    totalAmount: 47.99,
    paymentMethod: { rawName: 'Pix' },
    items: [{ name: 'Item', quantity: 1, unitPrice: null, totalPrice: null, categoryName: null }],
  })), false);
});

test('merge preserva determinístico em conflito e não duplica evidência', () => {
  const deterministic = purchase({
    establishment: 'C&A',
    orderNumber: 'v91329869cea-01',
    totalAmount: 47.99,
    paymentMethod: { rawName: 'Pix' },
    items: [{ name: 'Calça', quantity: 1, unitPrice: 59.99, totalPrice: null, categoryName: null }],
    evidence: [{ field: 'totalAmount', source: 'EMAIL_TEXT', confidence: null, rawLabel: 'Você pagou', context: 'Você pagou R$ 47,99' }],
  });
  const result = mergeExtractedPurchase(deterministic, aiPurchase({
    establishment: 'Outro',
    orderNumber: 'OUTRO',
    totalAmount: 59.99,
    paymentMethodName: 'Cartão',
    items: [{ name: 'Outra', quantity: 1, unitPrice: 59.99, totalPrice: null, categoryName: null }],
  }));
  assert.equal(result.totalAmount, 47.99);
  assert.equal(result.paymentMethod.rawName, 'Pix');
  assert.equal(result.items[0].name, 'Calça');
  assert.equal(result.evidence.filter((item) => item.source === 'AI').length, 0);
  assert.equal(result.evidence.length, 1);
});

test('merge usa IA somente para preencher lacunas e registra evidência usada', () => {
  const result = mergeExtractedPurchase(purchase({ establishment: 'Loja Exemplo', totalAmount: 89.8 }), aiPurchase({
    establishment: 'Outro',
    orderNumber: 'ABC123',
    totalAmount: 10,
    paymentMethodName: 'Cartão de crédito',
    items: [{ name: 'Camiseta', quantity: 2, unitPrice: 39.9, totalPrice: 79.8, categoryName: null }],
  }));
  assert.equal(result.establishment, 'Loja Exemplo');
  assert.equal(result.orderNumber, 'ABC123');
  assert.equal(result.totalAmount, 89.8);
  assert.equal(result.paymentMethod.rawName, 'Cartão de crédito');
  assert.equal(result.items[0].totalPrice, 79.8);
  assert.deepEqual(result.evidence.map((item) => item.field), ['orderNumber', 'paymentMethod', 'items']);
  assert.ok(result.evidence.every((item) => item.source === 'AI' && item.confidence === null));
});

test('merge preserva itens determinísticos e aceita itens AI quando lista está vazia', () => {
  const deterministicItems = purchase({ items: [{ name: 'Existente', quantity: null, unitPrice: null, totalPrice: null, categoryName: null }] });
  const ai = aiPurchase({ items: [{ name: 'Novo', quantity: 1, unitPrice: 10, totalPrice: null, categoryName: null }] });
  assert.equal(mergeExtractedPurchase(deterministicItems, ai).items[0].name, 'Existente');
  assert.equal(mergeExtractedPurchase(purchase(), ai).items[0].name, 'Novo');
});
