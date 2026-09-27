import test from 'node:test';
import assert from 'node:assert/strict';

import { EmailPurchaseExtractor } from '../dist/src/modules/email/email-purchase.extractor.js';

const email = (textBody, overrides = {}) => ({
  id: 'purchase-test',
  threadId: null,
  subject: null,
  from: null,
  to: null,
  snippet: null,
  internalDate: null,
  labelIds: [],
  textBody,
  htmlBody: null,
  links: [],
  attachments: [],
  ...overrides,
});

test('extrai total por Você pagou, não o primeiro valor', () => {
  const result = EmailPurchaseExtractor.extract(email('Produto: R$ 59,99\nVocê economizou: R$ 12,00\nVocê pagou: R$ 47,99'));
  assert.equal(result.totalAmount, 47.99);
});

test('extrai total da compra depois de produtos e frete', () => {
  const result = EmailPurchaseExtractor.extract(email('Produtos: R$ 79,80\nFrete: R$ 10,00\nTotal da compra: R$ 89,80'));
  assert.equal(result.totalAmount, 89.8);
});

test('extrai frete explicito como componente positivo', () => {
  const result = EmailPurchaseExtractor.extract(email('Produto\nCamiseta\nQuantidade: 2\nValor dos produtos: R$ 79,80\nFrete: R$ 10,00\nTotal da compra: R$ 89,80'));
  assert.equal(result.items[0].totalPrice, 79.8);
  assert.deepEqual(result.items[1], {
    name: 'Frete',
    quantity: 1,
    unit: null,
    unitPrice: 10,
    totalPrice: 10,
    categoryName: 'Frete/Taxas',
  });
});

test('extrai taxa de entrega com preco explicitamente associado', () => {
  const result = EmailPurchaseExtractor.extract(email('Taxa de entrega\nR$ 12,90'));
  assert.deepEqual(result.items[0], {
    name: 'Taxa de entrega',
    quantity: 1,
    unit: null,
    unitPrice: 12.9,
    totalPrice: 12.9,
    categoryName: 'Frete/Taxas',
  });
});

test('extrai taxa de servico com preco explicitamente associado', () => {
  const result = EmailPurchaseExtractor.extract(email('Taxa de servico\nR$ 9,90'));
  assert.equal(result.items[0].name, 'Taxa de servi\u00e7o');
  assert.equal(result.items[0].quantity, 1);
  assert.equal(result.items[0].unitPrice, 9.9);
  assert.equal(result.items[0].totalPrice, 9.9);
  assert.equal(result.items[0].categoryName, 'Frete/Taxas');
});

test('nao interpreta total como taxa positiva', () => {
  const result = EmailPurchaseExtractor.extract(email('Total\nR$ 262,80'));
  assert.equal(result.items.length, 0);
});

test('extrai taxa positiva especifica e desconto como ajuste', () => {
  const result = EmailPurchaseExtractor.extract(email('Produto: Produto X\nValor do produto: R$ 50,00\nTaxa de serviço: R$ 5,00\nDesconto: R$ 2,00\nTotal: R$ 53,00'));
  assert.equal(result.items[0].name, 'Produto X');
  assert.equal(result.items[1].name, 'Taxa de serviço');
  assert.equal(result.items[1].categoryName, 'Frete/Taxas');
  assert.equal(result.discountAmount, 2);
});

test('extrai Total e ignora parcela anterior', () => {
  const result = EmailPurchaseExtractor.extract(email('Parcela: R$ 30,00\nTotal: R$ 90,00'));
  assert.equal(result.totalAmount, 90);
});

test('valor sem label de total permanece nulo', () => {
  const result = EmailPurchaseExtractor.extract(email('Pix\nR$ 164,76'));
  assert.equal(result.totalAmount, null);
});

test('preço do produto sem total permanece nulo', () => {
  const result = EmailPurchaseExtractor.extract(email('Valor do produto: R$ 100,00\nFrete grátis'));
  assert.equal(result.totalAmount, null);
});

test('interpreta formatos monetários brasileiros', () => {
  const result = EmailPurchaseExtractor.extract(email('Total: R$1.299,90'));
  assert.equal(result.totalAmount, 1299.9);
});

test('extrai número de pedido com marcador', () => {
  const result = EmailPurchaseExtractor.extract(email('Pedido #PLENNA-84721'));
  assert.equal(result.orderNumber, 'PLENNA-84721');
});

test('extrai número alfanumérico em status de pedido', () => {
  const result = EmailPurchaseExtractor.extract(email('Seu pedido v91329869cea-01 foi entregue'));
  assert.equal(result.orderNumber, 'v91329869cea-01');
});

test('extrai número do pedido e Order', () => {
  assert.equal(EmailPurchaseExtractor.extract(email('Número do pedido: ABC123')).orderNumber, 'ABC123');
  assert.equal(EmailPurchaseExtractor.extract(email('Order #123ABC')).orderNumber, '123ABC');
});

test('não deriva pedido de CNPJ', () => {
  const result = EmailPurchaseExtractor.extract(email('CNPJ: 12.345.678/0001-99'));
  assert.equal(result.orderNumber, null);
});

test('não deriva pedido de código de rastreio', () => {
  const result = EmailPurchaseExtractor.extract(email('Rastreio: BR123456789'));
  assert.equal(result.orderNumber, null);
});

test('extrai formas textuais de pagamento', () => {
  assert.equal(EmailPurchaseExtractor.extract(email('Pagamento: PIX')).paymentMethod.rawName, 'Pix');
  assert.equal(EmailPurchaseExtractor.extract(email('Cartão de crédito final 1234')).paymentMethod.rawName, 'Cartão de crédito');
  assert.equal(EmailPurchaseExtractor.extract(email('Cartão de débito')).paymentMethod.rawName, 'Cartão de débito');
  assert.equal(EmailPurchaseExtractor.extract(email('Boleto bancário')).paymentMethod.rawName, 'Boleto');
  assert.equal(EmailPurchaseExtractor.extract(email('')).paymentMethod.rawName, null);
});

test('extrai estabelecimento apenas do display name do remetente', () => {
  assert.equal(EmailPurchaseExtractor.extract(email('Pedido confirmado', { from: 'C&A <pedido@ca.com>' })).establishment, 'C&A');
  assert.equal(EmailPurchaseExtractor.extract(email('Pedido confirmado', { from: 'pedido@ca.com' })).establishment, null);
});

test('extrai item, quantidade e valor unitário', () => {
  const result = EmailPurchaseExtractor.extract(email('Produto\nCalça de pijama avulsa feminina\nQuantidade\n1\nValor do produto\nR$ 47,99'));
  assert.deepEqual(result.items, [{
    name: 'Calça de pijama avulsa feminina',
    quantity: 1,
    unit: null,
    unitPrice: 47.99,
    totalPrice: null,
    categoryName: null,
  }]);
});

test('diferencia valor unitário de subtotal', () => {
  const result = EmailPurchaseExtractor.extract(email('Produto: Camiseta\nQuantidade: 2\nValor unitário: R$ 39,90\nSubtotal: R$ 79,80'));
  assert.equal(result.items[0].quantity, 2);
  assert.equal(result.items[0].unitPrice, 39.9);
  assert.equal(result.items[0].totalPrice, 79.8);
});

test('texto promocional não gera item', () => {
  const result = EmailPurchaseExtractor.extract(email('Nossos produtos estão com desconto\n20% OFF'));
  assert.deepEqual(result.items, []);
});

test('não extrai salário como total', () => {
  const result = EmailPurchaseExtractor.extract(email('Vaga aberta\nSalário: R$ 5.000,00'));
  assert.equal(result.totalAmount, null);
});

test('não extrai parcela sem total', () => {
  const result = EmailPurchaseExtractor.extract(email('Pagamento em 3x de R$ 30,00'));
  assert.equal(result.totalAmount, null);
});

test('caso C&A extrai pedido, total, Pix e item', () => {
  const result = EmailPurchaseExtractor.extract(email(
    'Seu pedido v91329869cea-01 foi entregue\nProduto\ncalça de pijama avulsa feminina em algodão xadrez azul GG\nQuantidade\n1\nValor do produto\nR$ 59,99\nVocê economizou\nR$ -12,00\nFrete\nGrátis\nVocê pagou\nR$ 47,99\nPix',
    { from: 'C&A <pedido@ca.com>' }
  ));
  assert.equal(result.establishment, 'C&A');
  assert.equal(result.orderNumber, 'v91329869cea-01');
  assert.equal(result.totalAmount, 47.99);
  assert.equal(result.paymentMethod.rawName, 'Pix');
  assert.equal(result.items[0].name, 'calça de pijama avulsa feminina em algodão xadrez azul GG');
  assert.equal(result.items[0].quantity, 1);
});

test('caso Loja Teste Plenna extrai dados principais', () => {
  const result = EmailPurchaseExtractor.extract(email(
    'Seu pedido #PLENNA-84721 foi confirmado.\nRecebemos seu pedido #PLENNA-84721 e o pagamento foi aprovado.\nCamiseta básica\nQuantidade: 2\nValor dos produtos: R$ 79,80\nFrete: R$ 10,00\nTotal da compra: R$ 89,80\nPagamento realizado com cartão de crédito.\nLoja Teste Plenna',
    { from: 'Loja Teste Plenna <vendas@plenna.test>' }
  ));
  assert.equal(result.establishment, 'Loja Teste Plenna');
  assert.equal(result.orderNumber, 'PLENNA-84721');
  assert.equal(result.totalAmount, 89.8);
  assert.equal(result.paymentMethod.rawName, 'Cartão de crédito');
  assert.equal(result.items[0].name, 'Camiseta básica');
  assert.equal(result.items[0].quantity, 2);
});

test('evidências usam EMAIL_TEXT e confidence nulo', () => {
  const result = EmailPurchaseExtractor.extract(email('Total da compra: R$ 89,80\nPix'));
  assert.ok(result.evidence.some((item) => item.field === 'totalAmount' && item.source === 'EMAIL_TEXT' && item.confidence === null));
  assert.ok(result.evidence.some((item) => item.field === 'paymentMethod' && item.rawLabel === 'Pix'));
});

test('não transforma status genérico em número de pedido', () => {
  for (const status of ['recebido', 'realizado', 'separado', 'pronto', 'cancelado']) {
    assert.equal(EmailPurchaseExtractor.extract(email(`Pedido ${status}`)).orderNumber, null);
  }
  assert.equal(EmailPurchaseExtractor.extract(email('Seu pedido ABC123 foi enviado')).orderNumber, 'ABC123');
  assert.equal(EmailPurchaseExtractor.extract(email('Seu pedido v91329869cea-01 foi entregue')).orderNumber, 'v91329869cea-01');
  assert.equal(EmailPurchaseExtractor.extract(email('Número do pedido: ABC123')).orderNumber, 'ABC123');
});

test('boundary semântico impede vazamento entre produtos', () => {
  const result = EmailPurchaseExtractor.extract(email('Produto\nCamiseta\nProduto\nCalça\nQuantidade\n2\nValor do produto\nR$ 79,90'));
  assert.deepEqual(result.items, [
    { name: 'Camiseta', quantity: null, unit: null, unitPrice: null, totalPrice: null, categoryName: null },
    { name: 'Calça', quantity: 2, unit: null, unitPrice: 79.9, totalPrice: null, categoryName: null },
  ]);
});

test('preserva a representação original do estabelecimento', () => {
  assert.equal(EmailPurchaseExtractor.extract(email('Estabelecimento: São João Comércio')).establishment, 'São João Comércio');
  assert.equal(EmailPurchaseExtractor.extract(email('Loja: C&A')).establishment, 'C&A');
  assert.equal(EmailPurchaseExtractor.extract(email('Vendido por: Loja São José')).establishment, 'Loja São José');
});
test('associa preco adjacente de tabela HTML linearizada ao item', () => {
  const result = EmailPurchaseExtractor.extract(email('Jaqueta Jeans Oversized\nQuantidade: 1\nR$ 249,90'));
  assert.equal(result.items[0].name, 'Jaqueta Jeans Oversized');
  assert.equal(result.items[0].quantity, 1);
  assert.equal(result.items[0].unitPrice, 249.9);
});

test('nao associa preco de recomendacao ao produto principal', () => {
  const result = EmailPurchaseExtractor.extract(email('Produto A\nQuantidade: 1\nR$ 50,00\nVoce tambem pode gostar\nBolsa\nR$ 79,90'));
  assert.equal(result.items[0].unitPrice, 50);
  assert.equal(result.items.length, 1);
});

test('prioriza total semantico em linha consecutiva', () => {
  const result = EmailPurchaseExtractor.extract(email('Produto A\nR$ 189,90\nFrete\nR$ 14,90\nDesconto\nR$ 20,00\nTotal final\nR$ 184,80'));
  assert.equal(result.totalAmount, 184.8);
  assert.equal(result.totalAmountSource, 'DETERMINISTIC_SEMANTIC');
});
test('extrai produto com atributos, preco e frete sem atravessar delimitadores', () => {
  const result = EmailPurchaseExtractor.extract(email([
    'Tenis Casual Branco',
    'Tamanho: 37',
    'Quantidade: 1',
    'R$ 189,90',
    'Frete',
    'R$ 14,90',
  ].join('\n')));
  assert.equal(result.items[0].name, 'Tenis Casual Branco');
  assert.equal(result.items[0].unitPrice, 189.9);
  assert.equal(result.items[1].name, 'Frete');
  assert.equal(result.items[1].unitPrice, 14.9);
});

test('extrai tres produtos de blocos consecutivos sem confundir subtotal', () => {
  const result = EmailPurchaseExtractor.extract(email([
    'Mouse Gamer RGB', 'Quantidade: 1', 'R$ 149,90',
    'Teclado Mecânico', 'Quantidade: 1', 'R$ 229,90',
    'Mousepad XL', 'Quantidade: 1', 'R$ 69,90',
    'Subtotal dos produtos', 'R$ 449,70',
    'Frete', 'R$ 18,50',
  ].join('\n')));
  assert.deepEqual(result.items.slice(0, 3).map((item) => [item.name, item.unitPrice]), [
    ['Mouse Gamer RGB', 149.9],
    ['Teclado Mecânico', 229.9],
    ['Mousepad XL', 69.9],
  ]);
});

test('extrai produto e taxa mas ignora recomendacoes sem quantidade', () => {
  const result = EmailPurchaseExtractor.extract(email([
    'Jaqueta Jeans Oversized', 'Cor: Azul', 'Tamanho: M', 'Quantidade: 1', 'R$ 249,90',
    'Subtotal', 'R$ 249,90',
    'Taxa de entrega', 'R$ 12,90',
    'Você também pode gostar', 'Bolsa Transversal', 'R$ 79,90',
  ].join('\n')));
  assert.equal(result.items[0].name, 'Jaqueta Jeans Oversized');
  assert.equal(result.items[0].unitPrice, 249.9);
  assert.equal(result.items[1].name, 'Taxa de entrega');
  assert.equal(result.items.length, 2);
});
