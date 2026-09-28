import axios from 'axios';
import { env } from '../../lib/env.js';
import type { EmailAttachmentMetadata } from './email-contracts.js';

const SUPPORTED_MIME_TYPES = new Set(['application/pdf', 'application/xml', 'text/xml']);

export type DownloadedGmailAttachment = {
  attachmentId: string;
  messageId: string;
  filename: string | null;
  mimeType: string;
  size: number;
  bytes: Buffer;
};

export class GmailAttachmentError extends Error {
  constructor(message: string) {
    // A mensagem deliberadamente nao inclui token, URL ou corpo retornado pelo Gmail.
    super(message);
    this.name = 'GmailAttachmentError';
  }
}

function assertSupportedMetadata(metadata: EmailAttachmentMetadata) {
  const attachmentId = metadata.attachmentId?.trim();
  const mimeType = metadata.mimeType?.trim().toLowerCase();
  if (!attachmentId) throw new GmailAttachmentError('attachmentId ausente');
  if (!mimeType || !SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new GmailAttachmentError('MIME de attachment nao suportado');
  }
  if (metadata.size !== null && (!Number.isSafeInteger(metadata.size) || metadata.size < 0)) {
    throw new GmailAttachmentError('Tamanho de attachment invalido');
  }
  if (metadata.size !== null && metadata.size > env.emailAttachmentMaxBytes) {
    throw new GmailAttachmentError('Attachment excede o limite configurado');
  }

  return { attachmentId, mimeType };
}

function decodeBase64UrlBytes(value: string) {
  if (!value || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new GmailAttachmentError('Dados base64url invalidos');
  }

  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const bytes = Buffer.from(padded, 'base64');
  if (bytes.length === 0) throw new GmailAttachmentError('Attachment vazio');
  if (bytes.length > env.emailAttachmentMaxBytes) {
    throw new GmailAttachmentError('Attachment excede o limite configurado');
  }
  return bytes;
}

/**
 * Baixa somente pelo endpoint autenticado do Gmail e mantém os bytes em memoria.
 * Extensao de arquivo nao concede confianca: o MIME declarado precisa ser XML ou PDF.
 */
export async function downloadGmailAttachment(
  accessToken: string,
  messageId: string,
  metadata: EmailAttachmentMetadata,
): Promise<DownloadedGmailAttachment> {
  const { attachmentId, mimeType } = assertSupportedMetadata(metadata);
  if (!messageId.trim()) throw new GmailAttachmentError('messageId ausente');

  let response: { data?: { data?: unknown } };
  try {
    response = await axios.get(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
  } catch {
    // Nao repassar o erro do Axios: ele pode carregar headers/configuracoes sensiveis.
    throw new GmailAttachmentError('Falha ao baixar attachment do Gmail');
  }

  const encodedData = response.data?.data;
  if (typeof encodedData !== 'string') throw new GmailAttachmentError('Resposta do Gmail sem dados');
  const bytes = decodeBase64UrlBytes(encodedData);

  return { attachmentId, messageId, filename: metadata.filename, mimeType, size: bytes.length, bytes };
}
