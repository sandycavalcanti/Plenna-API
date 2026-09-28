import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? 'client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? 'client-secret';
process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? 'https://example.com/callback';
process.env.EMAIL_ATTACHMENT_MAX_BYTES = '32';

const axios = (await import('axios')).default;
const { GmailAttachmentError, downloadGmailAttachment } = await import('../dist/src/modules/email/gmail.attachment.js');

const metadata = (overrides = {}) => ({ attachmentId: 'att-1', filename: 'nota.xml', mimeType: 'application/xml', size: null, ...overrides });
const encoded = (bytes) => Buffer.from(bytes).toString('base64url');

test('baixa XML como bytes base64url pela API Gmail', async () => {
  const originalGet = axios.get;
  let request;
  axios.get = async (...args) => { request = args; return { data: { data: encoded(Buffer.from([0, 255, 10])) } }; };
  try {
    const result = await downloadGmailAttachment('secret-token', 'message/1', metadata());
    assert.deepEqual(result.bytes, Buffer.from([0, 255, 10]));
    assert.equal(result.size, 3);
    assert.match(request[0], /messages\/message%2F1\/attachments\/att-1/);
    assert.equal(request[1].headers.Authorization, 'Bearer secret-token');
  } finally { axios.get = originalGet; }
});

test('baixa PDF como bytes sem converter para texto', async () => {
  const originalGet = axios.get;
  axios.get = async () => ({ data: { data: encoded(Buffer.from('%PDF\0binary')) } });
  try {
    const result = await downloadGmailAttachment('token', 'message', metadata({ filename: 'nota.pdf', mimeType: 'application/pdf' }));
    assert.ok(Buffer.isBuffer(result.bytes));
    assert.deepEqual(result.bytes, Buffer.from('%PDF\0binary'));
  } finally { axios.get = originalGet; }
});

test('rejeita metadata ausente, MIME nao suportado e tamanho acima do limite', async () => {
  await assert.rejects(() => downloadGmailAttachment('token', 'message', metadata({ attachmentId: null })), GmailAttachmentError);
  await assert.rejects(() => downloadGmailAttachment('token', 'message', metadata({ mimeType: 'text/plain' })), /MIME/);
  await assert.rejects(() => downloadGmailAttachment('token', 'message', metadata({ size: 33 })), /limite/);
});

test('rejeita resposta sem data, base64 invalido, vazio e conteudo acima do limite', async () => {
  const originalGet = axios.get;
  const responses = [{ data: {} }, { data: { data: '%%%invalid' } }, { data: { data: '' } }, { data: { data: encoded(Buffer.alloc(33)) } }];
  try {
    for (const response of responses) {
      axios.get = async () => response;
      await assert.rejects(() => downloadGmailAttachment('secret-token', 'message', metadata()), GmailAttachmentError);
    }
  } finally { axios.get = originalGet; }
});

test('converte erro Gmail em erro seguro sem vazar token ou resposta', async () => {
  const originalGet = axios.get;
  axios.get = async () => { throw new Error('secret-token payload fiscal'); };
  try {
    await assert.rejects(
      () => downloadGmailAttachment('secret-token', 'message', metadata()),
      (error) => error instanceof GmailAttachmentError && !error.message.includes('secret-token') && !error.message.includes('fiscal'),
    );
  } finally { axios.get = originalGet; }
});

test('nao realiza fetch externo e rejeita extensao XML com MIME incompativel', async () => {
  const originalGet = axios.get;
  let calls = 0;
  axios.get = async () => { calls += 1; return { data: { data: encoded(Buffer.from('x')) } }; };
  try {
    await assert.rejects(() => downloadGmailAttachment('token', 'message', metadata({ filename: 'nota.xml', mimeType: 'application/octet-stream' })), /MIME/);
    assert.equal(calls, 0);
  } finally { axios.get = originalGet; }
});
