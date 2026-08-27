import test from 'node:test';
import assert from 'node:assert/strict';

import { EmailClassificationEngine } from '../dist/src/modules/email/classification.engine.js';

test('EmailClassificationEngine classifica compra clara', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm1',
    subject: 'Pedido confirmado - sua compra foi aprovada',
    from: 'Loja Teste <vendas@loja.com>',
    snippet: 'Pagamento aprovado e nota fiscal emitida.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'COMPRA');
});

test('EmailClassificationEngine classifica propaganda clara', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm2',
    subject: 'Oferta especial com desconto',
    from: 'Marketing <promo@loja.com>',
    snippet: 'Cupom e frete grátis por tempo limitado.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'PROPAGANDA');
});

test('EmailClassificationEngine ignora mensagem irrelevante', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm3',
    subject: 'Atualização de conta',
    from: 'Suporte <support@service.com>',
    snippet: 'Nenhum sinal comercial aqui.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'IGNORAR');
});

test('CATEGORY_PROMOTIONS isolada não obriga compra', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm4',
    subject: 'Boletim semanal',
    from: 'Newsletter <news@service.com>',
    snippet: 'Conteúdo promocional sem sinal de compra.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'AMBIGUA');
});

test('CATEGORY_PROMOTIONS com sinais promocionais vira propaganda', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm5',
    subject: 'Oferta com desconto',
    from: 'Newsletter <news@service.com>',
    snippet: 'Frete grátis por tempo limitado.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'PROPAGANDA');
});

test('mensagem neutra é ignorada e não chama IA', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm6',
    subject: 'Atualização de conta',
    from: 'Suporte <support@service.com>',
    snippet: 'Nenhum sinal comercial aqui.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'IGNORAR');
});

test('bodyText também contribui para identificar compra', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm7',
    subject: 'Sua compra',
    from: 'Loja <vendas@loja.com>',
    snippet: 'Resumo curto',
    bodyText: 'Pagamento aprovado e nota fiscal emitida no valor de R$ 199,90.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'COMPRA');
});
