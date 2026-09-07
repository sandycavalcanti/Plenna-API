import test from 'node:test';
import assert from 'node:assert/strict';

const { NFeXmlParseError, parseNFeXml } = await import('../dist/src/modules/email/nfe.parser.js');

const infNFe = (extra = '', payments = '') => `<infNFe Id="NFe35123456789012345678901234567890123456789012" versao="4.00"><ide><nNF>123</nNF><dhEmi>2026-09-07T10:20:00-03:00</dhEmi></ide><emit><CNPJ>12345678000199</CNPJ><xNome>Loja Teste Fiscal</xNome></emit><det nItem="1"><prod><xProd>Camiseta</xProd><qCom>2</qCom><vUnCom>39.90</vUnCom><vProd>79.80</vProd></prod></det>${extra}<total><ICMSTot><vProd>79.80</vProd><vFrete>10.00</vFrete><vDesc>2.00</vDesc><vNF>87.80</vNF></ICMSTot></total><pag><detPag><tPag>17</tPag><vPag>87.80</vPag></detPag>${payments}</pag></infNFe>`;
const nfe = (content) => Buffer.from(`<NFe xmlns="http://www.portalfiscal.inf.br/nfe">${content}</NFe>`);
const proc = (content) => Buffer.from(`<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${content}</nfeProc>`);

test('extrai NF-e com emitente, chave, totais, item e Pix', () => {
  const result = parseNFeXml(nfe(infNFe()));
  assert.deepEqual(result.issuer, { name: 'Loja Teste Fiscal', cnpj: '12345678000199' });
  assert.equal(result.number, '123');
  assert.equal(result.accessKey, '35123456789012345678901234567890123456789012');
  assert.equal(result.issuedAt?.toISOString(), '2026-09-07T13:20:00.000Z');
  assert.equal(result.totalAmount, 87.8);
  assert.equal(result.freightAmount, 10);
  assert.equal(result.discountAmount, 2);
  assert.deepEqual(result.items, [{ name: 'Camiseta', quantity: 2, unitPrice: 39.9, totalPrice: 79.8 }]);
  assert.deepEqual(result.payments, [{ code: '17', name: 'PIX', amount: 87.8 }]);
});

test('aceita nfeProc, raiz NFe e namespaces com prefixo', () => {
  const wrapped = proc(`<NFe xmlns="http://www.portalfiscal.inf.br/nfe">${infNFe()}</NFe>`);
  const prefixed = Buffer.from(`<nfe:NFe xmlns:nfe="http://www.portalfiscal.inf.br/nfe">${infNFe()}</nfe:NFe>`);
  assert.equal(parseNFeXml(wrapped).number, '123');
  assert.equal(parseNFeXml(prefixed).issuer.name, 'Loja Teste Fiscal');
});

test('preserva quantidade decimal e todos os pagamentos', () => {
  const xml = nfe(infNFe('<det nItem="2"><prod><xProd>Peso</xProd><qCom>0.500</qCom><vUnCom>12.00</vUnCom><vProd>6.00</vProd></prod></det>', '<detPag><tPag>03</tPag><vPag>40.00</vPag></detPag><detPag><tPag>99</tPag><xPag>Carteira externa</xPag><vPag>47.80</vPag></detPag>'));
  const result = parseNFeXml(xml);
  assert.equal(result.items[1].quantity, 0.5);
  assert.deepEqual(result.payments, [
    { code: '17', name: 'PIX', amount: 87.8 },
    { code: '03', name: 'Cartão de crédito', amount: 40 },
    { code: '99', name: 'Carteira externa', amount: 47.8 },
  ]);
});

test('rejeita DTD e ENTITY antes do parse', () => {
  for (const declaration of ['<!DOCTYPE foo [ <!ENTITY x "expansao"> ]>', '<!entity x "expansao">']) {
    assert.throws(() => parseNFeXml(Buffer.from(`${declaration}<NFe/>`)), NFeXmlParseError);
  }
});

test('rejeita XML invalido e XML generico sem estrutura NF-e', () => {
  assert.throws(() => parseNFeXml(Buffer.from('<NFe>')), /XML malformado/);
  assert.throws(() => parseNFeXml(Buffer.from('<Invoice><total>1</total></Invoice>')), /estrutura de NF-e/);
});

test('campos opcionais ausentes retornam null e nao coletam dados do consumidor', () => {
  const result = parseNFeXml(Buffer.from('<NFe><infNFe><emit><xNome>Somente Emitente</xNome></emit></infNFe></NFe>'));
  assert.deepEqual(result.issuer, { name: 'Somente Emitente', cnpj: null });
  assert.equal(result.number, null);
  assert.equal(result.totalAmount, null);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.payments, []);
});

test('valores invalidos nao viram NaN ou Infinity', () => {
  const result = parseNFeXml(nfe(infNFe().replace('<vNF>87.80</vNF>', '<vNF>NaN</vNF>').replace('<vFrete>10.00</vFrete>', '<vFrete>Infinity</vFrete>')));
  assert.equal(result.totalAmount, null);
  assert.equal(result.freightAmount, null);
});
