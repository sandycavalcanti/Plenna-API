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

test('promoção com preço não vira compra', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm8',
    subject: 'Compre agora por R$ 566,66',
    from: 'Shopee <promo@shopee.com>',
    snippet: 'Oferta com desconto e frete grátis.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'PROPAGANDA');
});

test('pedido sem evidência transacional forte continua promocional', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm9',
    subject: 'Seu pedido por R$ 566,66',
    from: 'Loja <vendas@loja.com>',
    snippet: 'Oferta especial com desconto.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'PROPAGANDA');
});

test('vaga aberta para desenvolvedor backend é ignorada', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm10',
    subject: 'Vaga aberta para Desenvolvedor Backend',
    from: 'RH <recrutamento@empresa.com>',
    snippet: 'Processo seletivo com benefícios e salário em R$ 9.000,00.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'IGNORAR');
});

test('nova oportunidade de carreira é ignorada', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm11',
    subject: 'Nova oportunidade de carreira na empresa X',
    from: 'RH <carreira@empresa.com>',
    snippet: 'Estamos com inscrições abertas para processo seletivo.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'IGNORAR');
});

test('inscrições abertas para processo seletivo é ignorado', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm12',
    subject: 'Inscrições abertas para processo seletivo',
    from: 'RH <talentos@empresa.com>',
    snippet: 'Oportunidade profissional para sua carreira.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'IGNORAR');
});

test('ganhe 20% OFF na SHEIN vira propaganda', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm13',
    subject: 'Ganhe 20% OFF na SHEIN',
    from: 'SHEIN <promo@shein.com>',
    snippet: 'Cupom e frete grátis na próxima compra.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'PROPAGANDA');
});

test('cupom de R$ 50 para sua próxima compra vira propaganda', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm14',
    subject: 'Cupom de R$ 50 para sua próxima compra',
    from: 'Loja <promo@loja.com>',
    snippet: 'Oferta exclusiva e desconto especial.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'PROPAGANDA');
});

test('pagamento aprovado em contexto transacional vira compra', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm15',
    subject: 'Seu pagamento foi aprovado',
    from: 'Loja <vendas@loja.com>',
    snippet: 'Pedido confirmado e nota fiscal emitida.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'COMPRA');
});

test('pedido chegou com identificador transacional vira compra', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm18',
    subject: 'Olha que ótimo, Sandy! Seu pedido v91329869cea-01 chegou!',
    from: 'C&A <pedido@ca.com>',
    snippet: 'Seu pedido está em trânsito e foi entregue.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'COMPRA');
});

test('pedido foi entregue vira compra', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm19',
    subject: 'Seu pedido foi entregue',
    from: 'Loja <pedidos@loja.com>',
    snippet: 'Acompanhe seu pedido e veja o comprovante.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'COMPRA');
});

test('pedido enviado vira compra', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm20',
    subject: 'Pedido enviado. Acompanhe sua entrega',
    from: 'Loja <pedidos@loja.com>',
    snippet: 'Recebemos seu pedido e ele já foi despachado.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'COMPRA');
});

test('confirmação transacional com CATEGORY_PROMOTIONS ainda pode ser compra', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm21',
    subject: 'Seu pedido foi entregue',
    from: 'Loja <vendas@loja.com>',
    snippet: 'Pagamento aprovado e nota fiscal emitida.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'COMPRA');
});

test('marketing secundário no corpo não derruba compra explícita no subject', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm22',
    subject: 'Seu pedido v91329869cea-01 chegou!',
    from: 'C&A <pedido@ca.com>',
    snippet: 'Oferta de produtos relacionados e desconto adicional.',
    bodyText: 'Confira também nossas novidades da semana e cupons promocionais.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'COMPRA');
});

test('produtos que acabaram de chegar continuam propaganda', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm23',
    subject: 'Confira os produtos que acabaram de chegar',
    from: 'Loja <promo@loja.com>',
    snippet: 'Oferta especial com desconto.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'PROPAGANDA');
});

test('novidades da semana continuam propaganda', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm24',
    subject: 'Acabaram de chegar: novidades da semana',
    from: 'Loja <promo@loja.com>',
    snippet: 'Ganhe desconto na próxima compra.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'PROPAGANDA');
});

test('ganhe desconto no seu próximo pedido continua propaganda', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm25',
    subject: 'Ganhe desconto no seu próximo pedido',
    from: 'Loja <promo@loja.com>',
    snippet: 'Cupom de oferta especial.',
    labelIds: ['CATEGORY_PROMOTIONS'],
  });

  assert.equal(result.outcome, 'PROPAGANDA');
});

test('email de vaga com salário em reais não vira compra', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm16',
    subject: 'Vaga aberta para Analista com salário de R$ 6.500,00',
    from: 'RH <carreira@empresa.com>',
    snippet: 'Benefícios e oportunidade de crescimento.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'IGNORAR');
});

test('email de vaga com benefícios e valor salarial continua ignorado', () => {
  const result = EmailClassificationEngine.classify({
    id: 'm17',
    subject: 'Oportunidade profissional com benefícios',
    from: 'RH <jobs@empresa.com>',
    snippet: 'Processo seletivo com salário de R$ 8.000,00.',
    labelIds: [],
  });

  assert.equal(result.outcome, 'IGNORAR');
});
