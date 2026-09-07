import axios from 'axios';
import https from 'node:https';
import type { ValidatedFiscalUrl } from './fiscal-url.policy.js';
import { FiscalUrlPolicyError, validateFiscalUrl } from './fiscal-url.policy.js';

const ALLOWED_CONTENT_TYPES = new Set(['application/xml', 'text/xml', 'application/pdf']);

export class FiscalDocumentDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FiscalDocumentDownloadError';
  }
}

export type DownloadedFiscalDocument = {
  url: string;
  contentType: string;
  bytes: Buffer;
};

function normalizedContentType(value: unknown) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

function contentLength(headers: Record<string, unknown>) {
  const raw = headers['content-length'];
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isExpectedTransportError(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  // Somente codigos de rede/timeout sao opcionais; erros Axios de configuracao
  // ou adapter desconhecidos devem propagar para nao esconder bugs do fetcher.
  return typeof code === 'string' && new Set([
    'ECONNABORTED',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
  ]).has(code);
}

function createPinnedAgent(validated: ValidatedFiscalUrl) {
  return new https.Agent({
    rejectUnauthorized: true,
    servername: validated.hostname,
    lookup: (_hostname, _options, callback) => callback(null, validated.address, validated.family),
  });
}

function assertMagic(contentType: string, bytes: Buffer) {
  if (contentType === 'application/pdf') {
    if (!bytes.subarray(0, 4).equals(Buffer.from('%PDF'))) {
      throw new FiscalDocumentDownloadError('Bytes nao correspondem a PDF');
    }
    return;
  }

  // XML pode possuir BOM e espacos antes da declaracao; HTML/login nao e
  // encaminhado ao parser fiscal mesmo que o servidor tenha mentido no MIME.
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (!text.startsWith('<') || /^<\s*html\b/i.test(text)) {
    throw new FiscalDocumentDownloadError('Bytes nao correspondem a XML');
  }
}

/**
 * Baixa um documento fiscal apenas por HTTPS, com IP validado e fixado na
 * conexao. O limite e aplicado durante o stream para evitar buffers sem fim.
 */
export async function downloadFiscalDocument(
  rawUrl: string,
  maxBytes: number,
  timeoutMs: number,
  maxRedirects: number,
): Promise<DownloadedFiscalDocument> {
  let currentUrl = rawUrl;
  const visited = new Set<string>();

  for (let redirectCount = 0; ; redirectCount += 1) {
    const validated = await validateFiscalUrl(currentUrl, timeoutMs);
    const requestUrl = validated.url.toString();
    if (visited.has(requestUrl)) throw new FiscalDocumentDownloadError('Redirect circular');
    visited.add(requestUrl);

    const agent = createPinnedAgent(validated);
    let response;
    try {
      response = await axios.get(requestUrl, {
        responseType: 'stream',
        timeout: timeoutMs,
        maxRedirects: 0,
        decompress: false,
        // Proxy de ambiente quebraria o vinculo entre DNS validado e IP fixado.
        proxy: false,
        validateStatus: () => true,
        httpsAgent: agent,
        headers: {
          Host: validated.url.host,
          'User-Agent': 'Plenna-Fiscal-Link-Fetcher/1.0',
        },
      });
    } catch (error) {
      agent.destroy();
      if (isExpectedTransportError(error)) {
        throw new FiscalDocumentDownloadError('Falha ao acessar documento fiscal');
      }
      throw error;
    }

    try {
      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers?.location;
        if (typeof location !== 'string' || !location.trim()) {
          throw new FiscalDocumentDownloadError('Redirect sem destino');
        }
        if (redirectCount >= maxRedirects) {
          throw new FiscalDocumentDownloadError('Limite de redirects excedido');
        }
        response.data?.destroy?.();
        currentUrl = new URL(location, validated.url).toString();
        continue;
      }
      if (status < 200 || status >= 300) {
        throw new FiscalDocumentDownloadError('Resposta HTTP fiscal nao aceita');
      }

      const contentType = normalizedContentType(response.headers?.['content-type']);
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new FiscalDocumentDownloadError('Content-Type fiscal nao suportado');
      }
      if (response.headers?.['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        throw new FiscalDocumentDownloadError('Conteudo comprimido nao suportado');
      }

      const length = contentLength(response.headers ?? {});
      if (length !== null && length > maxBytes) {
        throw new FiscalDocumentDownloadError('Documento fiscal excede o limite');
      }

      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of response.data as AsyncIterable<Buffer | Uint8Array | string>) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > maxBytes) {
            response.data.destroy?.();
            throw new FiscalDocumentDownloadError('Documento fiscal excede o limite');
          }
          chunks.push(bytes);
        }
      } catch (error) {
        if (error instanceof FiscalDocumentDownloadError) throw error;
        if (isExpectedTransportError(error)) {
          throw new FiscalDocumentDownloadError('Falha ao receber documento fiscal');
        }
        throw error;
      }

      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0) throw new FiscalDocumentDownloadError('Documento fiscal vazio');
      assertMagic(contentType, bytes);
      return { url: requestUrl, contentType, bytes };
    } finally {
      agent.destroy();
    }
  }
}

export function isExpectedFiscalLinkError(error: unknown) {
  return error instanceof FiscalUrlPolicyError || error instanceof FiscalDocumentDownloadError;
}
