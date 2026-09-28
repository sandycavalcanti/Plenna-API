import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { DanfePdfParseError, detectDanfe, extractPdfText, parseDanfePdf, parseDanfeText } = await import('../dist/src/modules/email/danfe.pdf.parser.js');

const key = '35123456789012345678901234567890123456789012';
const danfeText = `DANFE\nDOCUMENTO AUXILIAR DA NOTA FISCAL ELETRONICA\nCHAVE DE ACESSO\n${key.slice(0, 4)} ${key.slice(4, 8)} ${key.slice(8)}\nNFe NUMERO 12345 SERIE 1\nDATA DA EMISSAO 07/09/2026\nEMITENTE: Loja Teste Fiscal\nCNPJ: 12.345.678/0001-99\nDESCRICAO QUANTIDADE VALOR UNITARIO VALOR TOTAL\nCamiseta 2 39,90 79,80\nValor total da nota: R$ 87,80\nFrete: R$ 10,00\nDesconto: R$ 2,00\nForma de pagamento: Pix`;

function pdfWithText(text) {
  const escape = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)').replaceAll('\n', ') Tj 0 -16 Td (');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${escape.length + 36} >>\nstream\nBT /F1 10 Tf 40 750 Td (${escape}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets[index + 1] = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('extrai texto local de PDF e garante camada textual', async () => {
  const result = await extractPdfText(pdfWithText('DANFE'));
  assert.equal(result.status, 'TEXT_EXTRACTED');
  assert.match(result.text, /DANFE/);
});

test('detecta e interpreta DANFE textual com campos fiscais', () => {
  assert.equal(detectDanfe(danfeText), true);
  const result = parseDanfeText(danfeText);
  assert.equal(result?.issuer.name, 'Loja Teste Fiscal');
  assert.equal(result?.issuer.cnpj, '12.345.678/0001-99');
  assert.equal(result?.number, '12345');
  assert.equal(result?.accessKey, key);
  assert.equal(result?.totalAmount, 87.8);
  assert.equal(result?.freightAmount, 10);
  assert.equal(result?.discountAmount, 2);
  assert.equal(result?.items[0].quantity, 2);
  assert.equal(result?.items[0].unit, null);
  assert.equal(result?.items[0].unitPrice, 39.9);
  assert.equal(result?.items[0].totalPrice, 79.8);
  assert.equal(result?.payment, 'Pix');
});

test('interpreta formatos monetarios brasileiros e decimais com ponto', () => {
  const withTotal = (amount) => parseDanfeText(danfeText.replace('R$ 87,80', amount));
  assert.equal(withTotal('47,99')?.totalAmount, 47.99);
  assert.equal(withTotal('47.99')?.totalAmount, 47.99);
  assert.equal(withTotal('1.234,56')?.totalAmount, 1234.56);
  assert.equal(withTotal('1234,56')?.totalAmount, 1234.56);
  assert.equal(withTotal('1234.56')?.totalAmount, 1234.56);
  assert.equal(withTotal('R$ 59,99')?.totalAmount, 59.99);
  assert.equal(withTotal('R$ 59.99')?.totalAmount, 59.99);
});

test('aplica o mesmo parsing aos valores unitario e total do item', () => {
  const result = parseDanfeText(danfeText.replace('39,90 79,80', '47.99 1.234,56'));
  assert.equal(result?.items[0].unitPrice, 47.99);
  assert.equal(result?.items[0].totalPrice, 1234.56);
});

test('rejeita PDF textual que nao possui evidencias combinadas de DANFE', () => {
  assert.equal(detectDanfe('Relatorio financeiro\nValor total: R$ 100,00'), false);
  assert.equal(parseDanfeText('NF-e promocional\nR$ 10,00'), null);
});

test('chave aceita separadores somente quando resulta em 44 digitos', () => {
  assert.equal(parseDanfeText(danfeText.replace(key.slice(0, 44), '1234 5678')).accessKey, key);
  assert.equal(parseDanfeText(danfeText.replace(/3512 3456[\s\S]*?NFe/, '123')).accessKey, null);
});

test('quantidade decimal e layout ambiguo sao tratados conservadoramente', () => {
  const decimal = parseDanfeText(`${danfeText}\nPeso 0,500 12,00 6,00`);
  assert.equal(decimal?.items.at(-1)?.quantity, 0.5);
  const ambiguous = parseDanfeText(`${danfeText}\nProduto sem colunas claras\nR$ 9,90`);
  assert.equal(ambiguous?.items.length, 1);
});

test('extrai unidade de medida quando ela esta associada na mesma linha do item', () => {
  const result = parseDanfeText(danfeText.replace('Camiseta 2 39,90 79,80', 'Banana Prata 0.500 KG 8,00 4,00'));
  assert.equal(result?.items[0].name, 'Banana Prata');
  assert.equal(result?.items[0].quantity, 0.5);
  assert.equal(result?.items[0].unit, 'KG');
  assert.equal(result?.items[0].unitPrice, 8);
  assert.equal(result?.items[0].totalPrice, 4);
});

test('layout DANFE sem unidade nao inventa UN', () => {
  const result = parseDanfeText(danfeText.replace('Camiseta 2 39,90 79,80', 'Camiseta 2 39,90 79,80'));
  assert.equal(result?.items[0].unit, null);
});

test('PDF sem camada textual retorna status controlado e PDF invalido vira erro de dominio', async () => {
  const empty = await parseDanfePdf(pdfWithText(''));
  assert.equal(empty.status, 'TEXT_LAYER_NOT_AVAILABLE');
  const invalid = await parseDanfePdf(Buffer.from('not a pdf'));
  assert.equal(invalid.status, 'INVALID_PDF');
  await assert.rejects(() => extractPdfText(Buffer.alloc(0)), DanfePdfParseError);
});

test('nao há API de URL, rede, screenshot ou imagem no parser', () => {
  const source = readFileSync(new URL('../src/modules/email/danfe.pdf.parser.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /getScreenshot|getImage|getFromUrl|fetch\s*\(/);
  assert.match(source, /new Uint8Array\(bytes\)/);
});
