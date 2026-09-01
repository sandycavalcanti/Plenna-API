import type {
  EmailAttachmentMetadata,
  EmailLink,
  NormalizedEmail,
} from './email-contracts.js';

type GmailBody = {
  data?: unknown;
  attachmentId?: unknown;
  size?: unknown;
};

type GmailPart = {
  mimeType?: unknown;
  filename?: unknown;
  body?: unknown;
  parts?: unknown;
  headers?: unknown;
};

export type GmailRawMessage = {
  id?: unknown;
  threadId?: unknown;
  snippet?: unknown;
  internalDate?: unknown;
  labelIds?: unknown;
  payload?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function getString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function getBody(part: GmailPart) {
  return asRecord(part.body) as GmailBody | null;
}

function getHeader(part: GmailPart, name: string) {
  if (!Array.isArray(part.headers)) return null;

  const header = part.headers.find((value) => {
    const record = asRecord(value);
    return getString(record?.name)?.toLowerCase() === name.toLowerCase();
  });

  return getString(asRecord(header)?.value);
}

/** Decodifica o formato base64url utilizado pelo Gmail sem alterar o texto UTF-8. */
export function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function decodeEntity(entity: string) {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  if (namedEntities[entity]) return namedEntities[entity];

  const numericMatch = entity.match(/^#(x[\da-f]+|\d+)$/i);
  if (!numericMatch) return `&${entity};`;

  const codePoint = numericMatch[1].toLowerCase().startsWith('x')
    ? Number.parseInt(numericMatch[1].slice(1), 16)
    : Number.parseInt(numericMatch[1], 10);

  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return `&${entity};`;
  }

  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/gi, (_, entity: string) => decodeEntity(entity));
}

/**
 * Converte HTML em texto sem interpretar a arvore nem carregar recursos.
 * Tags estruturais recebem quebras de linha para preservar labels de tabelas.
 */
export function htmlToText(html: string) {
  const withoutUnsafeContent = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*(script|style|iframe|object|embed|noscript|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(br|p|div|li|tr|td|th|h[1-6]|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|td|th|h[1-6]|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');

  return decodeHtmlEntities(withoutUnsafeContent)
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 && (index === 0 || line !== lines[index - 1]))
    .join('\n')
    .trim();
}

function extractLinks(html: string): EmailLink[] {
  const links: EmailLink[] = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const attributes = match[1] ?? '';
    const hrefMatch = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = decodeHtmlEntities((hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '').trim());
    if (!href || /[\u0000-\u001f\u007f]/.test(href) || /^(?:javascript|vbscript|data):/i.test(href)) continue;

    const text = htmlToText(match[2] ?? '') || null;
    links.push({ text, href });
  }

  return links;
}

function isAttachment(part: GmailPart, body: GmailBody | null) {
  const mimeType = getString(part.mimeType)?.toLowerCase() ?? '';
  const filename = getString(part.filename)?.trim() ?? '';
  const hasAttachmentId = Boolean(getString(body?.attachmentId)?.trim());
  const isInlineText = (mimeType === 'text/plain' || mimeType === 'text/html') && !filename && !hasAttachmentId;
  return !isInlineText && (hasAttachmentId || Boolean(filename));
}

function attachmentMetadata(part: GmailPart, body: GmailBody): EmailAttachmentMetadata {
  const size = typeof body.size === 'number' && Number.isSafeInteger(body.size) && body.size >= 0 ? body.size : null;
  return {
    attachmentId: getString(body.attachmentId),
    filename: getString(part.filename),
    mimeType: getString(part.mimeType),
    size,
  };
}

function collectParts(value: unknown, textParts: string[], htmlParts: string[], attachments: EmailAttachmentMetadata[]) {
  const part = asRecord(value) as GmailPart | null;
  if (!part) return;

  const mimeType = getString(part.mimeType)?.toLowerCase();
  const body = getBody(part);
  const encodedData = getString(body?.data);

  if (mimeType === 'text/plain' && encodedData) {
    const text = decodeBase64Url(encodedData).replace(/\r\n?/g, '\n').trim();
    if (text) textParts.push(text);
  }

  if (mimeType === 'text/html' && encodedData) {
    const html = decodeBase64Url(encodedData).replace(/\r\n?/g, '\n');
    if (html.trim()) htmlParts.push(html);
  }

  if (body && isAttachment(part, body)) {
    attachments.push(attachmentMetadata(part, body));
  }

  const nestedParts = Array.isArray(part.parts) ? part.parts : [];
  for (const nestedPart of nestedParts) collectParts(nestedPart, textParts, htmlParts, attachments);
}

export function normalizeGmailMessage(message: GmailRawMessage): NormalizedEmail {
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  const attachments: EmailAttachmentMetadata[] = [];
  collectParts(message.payload, textParts, htmlParts, attachments);
  const payload = asRecord(message.payload) as GmailPart | null;

  const htmlBody = htmlParts[0] ?? null;
  const textBody = textParts[0] ?? (htmlBody ? htmlToText(htmlBody) || null : null);
  const labelIds = Array.isArray(message.labelIds)
    ? message.labelIds.filter((label): label is string => typeof label === 'string')
    : [];

  return {
    id: getString(message.id) ?? '',
    threadId: getString(message.threadId),
    subject: payload ? getHeader(payload, 'Subject') : null,
    from: payload ? getHeader(payload, 'From') : null,
    to: payload ? getHeader(payload, 'To') : null,
    snippet: getString(message.snippet),
    internalDate: getString(message.internalDate),
    labelIds,
    textBody,
    htmlBody,
    links: htmlBody ? extractLinks(htmlBody) : [],
    attachments,
  };
}
