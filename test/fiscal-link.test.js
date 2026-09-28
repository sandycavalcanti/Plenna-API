import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { promises as dns } from 'node:dns';

const {
  getFiscalLinkCandidates,
  isFiscalLinkCandidate,
} = await import('../dist/src/modules/email/fiscal-link.candidate.js');
const {
  FiscalUrlPolicyError,
  validateFiscalUrl,
} = await import('../dist/src/modules/email/fiscal-url.policy.js');
const {
  FiscalDocumentDownloadError,
  downloadFiscalDocument,
} = await import('../dist/src/modules/email/fiscal-document.downloader.js');

const link = (text, href) => ({ text, href });
const limits = { maxBytes: 100, timeoutMs: 1000, maxRedirects: 2 };

test('identifica candidatos fiscais sem acessar a rede', () => {
  assert.equal(isFiscalLinkCandidate(link('Baixar nota fiscal', 'https://loja.example/download')), true);
  assert.equal(isFiscalLinkCandidate(link('DANFE', 'https://loja.example/documento')), true);
  assert.equal(isFiscalLinkCandidate(link(null, 'https://loja.example/file.pdf')), false);
  assert.equal(isFiscalLinkCandidate(link('Veja nossa nota da semana', 'https://loja.example/promocao')), false);
});

test('deduplica candidatos e respeita limite por email', () => {
  const result = getFiscalLinkCandidates([
    link('Nota fiscal', 'https://loja.example/nfe/1'),
    link('DANFE', 'https://loja.example/nfe/1'),
    link('XML da nota', 'https://loja.example/nfe/2'),
  ], 1);
  assert.deepEqual(result, [link('Nota fiscal', 'https://loja.example/nfe/1')]);
});

test('aplica HTTPS, porta, credenciais e fragmento', async () => {
  const validated = await validateFiscalUrl('https://8.8.8.8/nota?token=secret#pagina');
  assert.equal(validated.url.toString(), 'https://8.8.8.8/nota?token=secret');
  await assert.rejects(() => validateFiscalUrl('http://8.8.8.8/nota'), FiscalUrlPolicyError);
  await assert.rejects(() => validateFiscalUrl('https://user:pass@8.8.8.8/nota'), FiscalUrlPolicyError);
  await assert.rejects(() => validateFiscalUrl('https://8.8.8.8:8443/nota'), FiscalUrlPolicyError);
  await assert.rejects(() => validateFiscalUrl('javascript:alert(1)'), FiscalUrlPolicyError);
});

test('bloqueia IPs nao publicos em IPv4 e IPv6', async () => {
  for (const url of [
    'https://127.0.0.1/nota',
    'https://10.0.0.1/nota',
    'https://192.168.1.1/nota',
    'https://169.254.1.1/nota',
    'https://[::1]/nota',
    'https://[fc00::1]/nota',
    'https://[fe80::1]/nota',
    'https://[::ffff:127.0.0.1]/nota',
  ]) {
    await assert.rejects(() => validateFiscalUrl(url), FiscalUrlPolicyError);
  }
});

test('bloqueia hostname quando qualquer resposta DNS for privada', async () => {
  const originalLookup = dns.lookup;
  dns.lookup = async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '192.168.1.1', family: 4 },
  ];
  try {
    await assert.rejects(() => validateFiscalUrl('https://public.example/nota'), FiscalUrlPolicyError);
  } finally {
    dns.lookup = originalLookup;
  }
});

test('limita a resolucao DNS e limpa o timer quando ela trava', async () => {
  const originalLookup = dns.lookup;
  dns.lookup = () => new Promise(() => {});
  try {
    await assert.rejects(() => validateFiscalUrl('https://public.example/nota', 10), FiscalUrlPolicyError);
  } finally {
    dns.lookup = originalLookup;
  }
});

test('baixa XML e PDF somente por stream local limitado', async () => {
  const originalGet = axios.get;
  const requests = [];
  axios.get = async (url, config) => {
    requests.push({ url, config });
    return {
      status: 200,
      headers: { 'content-type': 'application/xml', 'content-length': '9' },
      data: (async function* () { yield Buffer.from('<NFe/>'); })(),
    };
  };
  try {
    const xml = await downloadFiscalDocument('https://8.8.8.8/nota#x', ...Object.values(limits));
    assert.equal(xml.contentType, 'application/xml');
    assert.equal(xml.bytes.toString(), '<NFe/>');
    assert.equal(requests[0].config.maxRedirects, 0);
    assert.equal(requests[0].config.decompress, false);
    assert.equal(requests[0].config.proxy, false);
    assert.equal(requests[0].config.headers.Authorization, undefined);
    assert.equal(requests[0].config.headers.Cookie, undefined);

    axios.get = async () => ({
      status: 200,
      headers: { 'content-type': 'application/pdf; charset=binary' },
      data: (async function* () { yield Buffer.from('%PDF-1.7\n'); })(),
    });
    const pdf = await downloadFiscalDocument('https://8.8.8.8/nota.pdf', ...Object.values(limits));
    assert.equal(pdf.contentType, 'application/pdf');
    assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  } finally {
    axios.get = originalGet;
  }
});

test('classifica somente codigos de transporte conhecidos como falha esperada', async () => {
  const originalGet = axios.get;
  try {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']) {
      axios.get = async () => {
        const error = new Error(code);
        error.code = code;
        throw error;
      };
      await assert.rejects(
        () => downloadFiscalDocument('https://8.8.8.8/start', ...Object.values(limits)),
        FiscalDocumentDownloadError,
      );
    }

    axios.get = async () => { throw new axios.AxiosError('opcao invalida', 'ERR_BAD_OPTION_VALUE'); };
    await assert.rejects(
      () => downloadFiscalDocument('https://8.8.8.8/start', ...Object.values(limits)),
      (error) => error instanceof axios.AxiosError && error.code === 'ERR_BAD_OPTION_VALUE',
    );
  } finally {
    axios.get = originalGet;
  }
});

test('revalida redirects, bloqueia HTTP e limita a cadeia', async () => {
  const originalGet = axios.get;
  let call = 0;
  axios.get = async () => {
    call += 1;
    if (call === 1) return { status: 302, headers: { location: 'https://1.1.1.1/next' }, data: (async function* () {})() };
    return { status: 200, headers: { 'content-type': 'application/xml' }, data: (async function* () { yield Buffer.from('<NFe/>'); })() };
  };
  try {
    const result = await downloadFiscalDocument('https://8.8.8.8/start', ...Object.values(limits));
    assert.equal(result.contentType, 'application/xml');
    assert.equal(call, 2);
  } finally {
    axios.get = originalGet;
  }
});

test('redirect para IP privado e erro programatico nao sao aceitos', async () => {
  const originalGet = axios.get;
  axios.get = async () => ({
    status: 302,
    headers: { location: 'https://127.0.0.1/private' },
    data: (async function* () {})(),
  });
  try {
    await assert.rejects(() => downloadFiscalDocument('https://8.8.8.8/start', ...Object.values(limits)), FiscalUrlPolicyError);
    axios.get = async () => { throw new TypeError('bug inesperado'); };
    await assert.rejects(() => downloadFiscalDocument('https://8.8.8.8/start', ...Object.values(limits)), TypeError);
  } finally {
    axios.get = originalGet;
  }
});

test('rejeita MIME, magic bytes, tamanho e status incompatíveis', async () => {
  const originalGet = axios.get;
  const response = (headers, bytes, status = 200) => ({
    status,
    headers,
    data: (async function* () { yield Buffer.from(bytes); })(),
  });
  try {
    axios.get = async () => response({ 'content-type': 'text/html' }, '<html>login</html>');
    await assert.rejects(() => downloadFiscalDocument('https://8.8.8.8/x', ...Object.values(limits)), FiscalDocumentDownloadError);
    axios.get = async () => response({ 'content-type': 'application/pdf' }, 'not-pdf');
    await assert.rejects(() => downloadFiscalDocument('https://8.8.8.8/x', ...Object.values(limits)), FiscalDocumentDownloadError);
    axios.get = async () => response({ 'content-type': 'application/xml', 'content-length': '101' }, '<NFe/>');
    await assert.rejects(() => downloadFiscalDocument('https://8.8.8.8/x', ...Object.values(limits)), FiscalDocumentDownloadError);
    axios.get = async () => response({ 'content-type': 'application/xml' }, 'x'.repeat(101));
    await assert.rejects(() => downloadFiscalDocument('https://8.8.8.8/x', ...Object.values(limits)), FiscalDocumentDownloadError);
    axios.get = async () => response({}, 'error', 404);
    await assert.rejects(() => downloadFiscalDocument('https://8.8.8.8/x', ...Object.values(limits)), FiscalDocumentDownloadError);
  } finally {
    axios.get = originalGet;
  }
});
