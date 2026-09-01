import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeBase64Url, normalizeGmailMessage } from '../dist/src/modules/email/gmail.normalizer.js';

const encoded = (value) => Buffer.from(value, 'utf8').toString('base64url');
const textPart = (text) => ({ mimeType: 'text/plain', body: { data: encoded(text) } });
const htmlPart = (html) => ({ mimeType: 'text/html', body: { data: encoded(html) } });

test('normaliza text/plain simples', () => {
  const result = normalizeGmailMessage({ id: 'plain', payload: textPart('Linha 1\nLinha 2') });
  assert.equal(result.textBody, 'Linha 1\nLinha 2');
  assert.equal(result.htmlBody, null);
});

test('normaliza text/html e produz texto seguro', () => {
  const result = normalizeGmailMessage({ id: 'html', payload: htmlPart('<p>Produto</p><p>R$ 47,99</p>') });
  assert.equal(result.htmlBody, '<p>Produto</p><p>R$ 47,99</p>');
  assert.equal(result.textBody, 'Produto\nR$ 47,99');
});

test('preserva text/plain e text/html em multipart/alternative', () => {
  const result = normalizeGmailMessage({
    id: 'alternative',
    payload: { mimeType: 'multipart/alternative', parts: [textPart('texto simples'), htmlPart('<p>texto HTML</p>')] },
  });
  assert.equal(result.textBody, 'texto simples');
  assert.equal(result.htmlBody, '<p>texto HTML</p>');
});

test('detecta metadata em multipart/mixed sem baixar attachment', () => {
  const result = normalizeGmailMessage({
    id: 'mixed',
    payload: {
      mimeType: 'multipart/mixed',
      parts: [textPart('corpo'), { mimeType: 'application/pdf', filename: 'nota.pdf', body: { attachmentId: 'att-pdf', size: 1234 } }],
    },
  });
  assert.equal(result.textBody, 'corpo');
  assert.deepEqual(result.attachments, [{ attachmentId: 'att-pdf', filename: 'nota.pdf', mimeType: 'application/pdf', size: 1234 }]);
});

test('percorre multipart aninhado', () => {
  const result = normalizeGmailMessage({
    id: 'nested',
    payload: { mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [textPart('plain nested'), htmlPart('<p>html nested</p>')] }] },
  });
  assert.equal(result.textBody, 'plain nested');
  assert.equal(result.htmlBody, '<p>html nested</p>');
});

test('mantem tabela ecommerce legivel', () => {
  const result = normalizeGmailMessage({
    id: 'table',
    payload: htmlPart('<table><tr><th>Produto</th><th>Quantidade</th></tr><tr><td>Calça de pijama</td><td>1</td></tr><tr><td>Você pagou</td><td>R$ 47,99</td></tr><tr><td>Pix</td></tr></table>'),
  });
  assert.match(result.textBody, /Produto\nQuantidade/);
  assert.match(result.textBody, /Você pagou\nR\$ 47,99/);
  assert.match(result.textBody, /Pix/);
});

test('extrai link sem acessar o href', () => {
  const result = normalizeGmailMessage({ id: 'link', payload: htmlPart('<a href="https://example.com/nf/order123">Baixar nota fiscal</a>') });
  assert.deepEqual(result.links, [{ text: 'Baixar nota fiscal', href: 'https://example.com/nf/order123' }]);
});

test('preserva metadata de PDF', () => {
  const result = normalizeGmailMessage({ id: 'pdf', payload: { mimeType: 'application/pdf', filename: 'nota.pdf', body: { attachmentId: 'pdf-1', size: 10 } } });
  assert.deepEqual(result.attachments[0], { attachmentId: 'pdf-1', filename: 'nota.pdf', mimeType: 'application/pdf', size: 10 });
});

test('preserva metadata de XML', () => {
  const result = normalizeGmailMessage({ id: 'xml', payload: { mimeType: 'application/xml', filename: 'nfe.xml', body: { attachmentId: 'xml-1', size: 20 } } });
  assert.deepEqual(result.attachments[0], { attachmentId: 'xml-1', filename: 'nfe.xml', mimeType: 'application/xml', size: 20 });
});

test('aceita payload sem corpo', () => {
  const result = normalizeGmailMessage({ id: 'empty', payload: {} });
  assert.equal(result.textBody, null);
  assert.equal(result.htmlBody, null);
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.attachments, []);
});

test('decodifica base64url UTF-8', () => {
  assert.equal(decodeBase64Url(encoded('C&A Você')), 'C&A Você');
});

test('decodifica entidades HTML', () => {
  const result = normalizeGmailMessage({ id: 'entities', payload: htmlPart('<p>C&amp;A &amp; Você&nbsp;&quot;ok&quot; &#39;</p>') });
  assert.equal(result.textBody, 'C&A & Você "ok" \'');
});

test('remove script do texto sem executar HTML', () => {
  const result = normalizeGmailMessage({ id: 'script', payload: htmlPart('<p>Pedido</p><script>alert("x")</script><p>Entregue</p>') });
  assert.equal(result.textBody, 'Pedido\nEntregue');
});

test('caso ecommerce representativo preserva dados e link fiscal', () => {
  const result = normalizeGmailMessage({
    id: 'ca',
    threadId: 'thread-ca',
    payload: {
      headers: [
        { name: 'Subject', value: 'Seu pedido foi entregue' },
        { name: 'From', value: 'C&A <pedido@ca.com>' },
        { name: 'To', value: 'cliente@example.com' },
      ],
      mimeType: 'multipart/alternative',
      parts: [htmlPart('<h1>Seu pedido foi entregue</h1><table><tr><td>Produto:</td><td>calça de pijama</td></tr><tr><td>Quantidade:</td><td>1</td></tr><tr><td>Valor do produto:</td><td>R$ 59,99</td></tr><tr><td>Você economizou:</td><td>R$ -12,00</td></tr><tr><td>Você pagou:</td><td>R$ 47,99</td></tr><tr><td>Forma:</td><td>Pix</td></tr></table><a href="https://example.com/nf/order123">Baixar nota fiscal</a>')],
    },
  });
  assert.equal(result.subject, 'Seu pedido foi entregue');
  assert.equal(result.from, 'C&A <pedido@ca.com>');
  assert.match(result.textBody, /Você pagou/);
  assert.match(result.textBody, /R\$ 47,99/);
  assert.equal(typeof result.htmlBody, 'string');
  assert.deepEqual(result.links, [{ text: 'Baixar nota fiscal', href: 'https://example.com/nf/order123' }]);
  assert.deepEqual(result.attachments, []);
});
