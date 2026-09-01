/**
 * Representa o email que as etapas de extracao poderao consumir,
 * independentemente do formato especifico retornado pela API do Gmail.
 *
 * O contrato preserva texto, HTML e metadados de fontes futuras sem
 * acoplar a camada de extracao ao Prisma ou ao payload bruto do Gmail.
 */
export interface NormalizedEmail {
  id: string;
  threadId: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  snippet: string | null;
  internalDate: string | null;
  labelIds: string[];
  textBody: string | null;
  htmlBody: string | null;
  links: EmailLink[];
  attachments: EmailAttachmentMetadata[];
}

/** Link preservado como dado de origem, sem fazer download do destino. */
export interface EmailLink {
  text: string | null;
  href: string;
}

/** Metadados do anexo; o conteudo sera tratado em uma etapa posterior. */
export interface EmailAttachmentMetadata {
  attachmentId: string | null;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
}

/** Forma de pagamento ainda textual, antes de qualquer lookup no banco. */
export interface ExtractedPaymentMethod {
  rawName: string | null;
}

export type InvoiceMetadataType = 'NFE_XML' | 'DANFE_PDF' | 'LINK';

/** Identifica uma possivel fonte fiscal sem interpretar ou armazenar o documento. */
export interface InvoiceMetadata {
  type: InvoiceMetadataType;
  number: string | null;
  accessKey: string | null;
  source: string | null;
}

export type ExtractionSource = 'EMAIL_TEXT' | 'EMAIL_HTML' | 'NFE_XML' | 'DANFE_PDF' | 'AI';

export type ExtractedPurchaseField =
  | 'establishment'
  | 'orderNumber'
  | 'totalAmount'
  | 'paymentMethod'
  | 'items'
  | 'invoice';

/**
 * Registra a origem de um dado extraido, sem afirmar que ele foi confirmado
 * pelo usuario ou persistido como dado definitivo da compra.
 */
export interface ExtractionEvidence {
  field: ExtractedPurchaseField;
  source: ExtractionSource;
  confidence: number | null;
  rawLabel: string | null;
  context: string | null;
}

export interface ExtractedPurchaseItem {
  name: string | null;
  quantity: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
  categoryName: string | null;
}

/**
 * Compra inferida a partir das fontes disponiveis antes da persistencia.
 * Valores ausentes permanecem null e nao devem ser substituidos por defaults.
 */
export interface ExtractedPurchase {
  establishment: string | null;
  orderNumber: string | null;
  totalAmount: number | null;
  paymentMethod: ExtractedPaymentMethod;
  items: ExtractedPurchaseItem[];
  invoice: InvoiceMetadata | null;
  evidence: ExtractionEvidence[];
}
