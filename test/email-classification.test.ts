import test from 'node:test';
import assert from 'node:assert/strict';

test('EmailClassificationEngine classifica compra clara', async () => {
  const { EmailClassificationEngine } = await import('../src/modules/email/classification.engine.js');

  const result = EmailClassificationEngine.classify({
    id: 'm1',
    subject: 'Pedido confirmado - sua compra foi aprovada',
    from: 'Loja Teste <vendas@loja.com>',
    snippet: 'Pagamento aprovado e nota fiscal emitida.',
    labelIds: [],
  });

  assert.equal(result.action, 'COMPRA');
});

test('EmailClassificationEngine classifica propaganda clara', async () => {
  const { EmailClassificationEngine } = await import('../src/modules/email/classification.engine.js');

  const result = EmailClassificationEngine.classify({
    id: 'm2',
    subject: 'Oferta especial com desconto',
    from: 'Marketing <promo@loja.com>',
    snippet: 'Cupom e frete grátis por tempo limitado.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.action, 'PROPAGANDA');
});

test('EmailClassificationEngine ignora mensagem irrelevante', async () => {
  const { EmailClassificationEngine } = await import('../src/modules/email/classification.engine.js');

  const result = EmailClassificationEngine.classify({
    id: 'm3',
    subject: 'Atualização de conta',
    from: 'Suporte <support@service.com>',
    snippet: 'Nenhum sinal comercial aqui.',
    labelIds: [],
  });

  assert.equal(result.action, 'IGNORAR');
});

test('CATEGORY_PROMOTIONS isolada não obriga compra', async () => {
  const { EmailClassificationEngine } = await import('../src/modules/email/classification.engine.js');

  const result = EmailClassificationEngine.classify({
    id: 'm4',
    subject: 'Boletim semanal',
    from: 'Newsletter <news@service.com>',
    snippet: 'Conteúdo promocional sem sinal de compra.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.action, 'PROPAGANDA');
});
