import { PDFParse } from 'pdf-parse';

export type ParsedDanfeItem = {
  name: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  totalPrice: number;
};

export type ParsedDanfe = {
  number: string | null;
  accessKey: string | null;
  issuedAt: Date | null;
  issuer: { name: string | null; cnpj: string | null };
  totalAmount: number | null;
  freightAmount: number | null;
  discountAmount: number | null;
  items: ParsedDanfeItem[];
  payment: string | null;
};

export type PdfTextResult = {
  status: 'TEXT_EXTRACTED' | 'TEXT_LAYER_NOT_AVAILABLE';
  text: string;
};

export type DanfePdfResult =
  | { status: 'PARSED'; danfe: ParsedDanfe }
  | { status: 'TEXT_LAYER_NOT_AVAILABLE'; danfe: null }
  | { status: 'NOT_DANFE'; danfe: null }
  | { status: 'INVALID_PDF'; danfe: null };

export class DanfePdfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DanfePdfParseError';
  }
}

function normalize(value: string) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase();
}

function parseNumber(value: string | null | undefined, positive = false) {
  if (!value) return null;
  const normalized = value.replace(/R\$\s*/gi, '').replace(/\s/g, '');
  let numericValue: string;

  if (normalized.includes(',')) {
    // Em 1.234,56 o ponto separa milhares e a virgula separa os centavos;
    // remover todo ponto sem distinguir esses papeis transformaria 47.99 em 4799.
    if (!/^\d{1,3}(?:\.\d{3})*,\d+$/.test(normalized) && !/^\d+,\d+$/.test(normalized)) return null;
    numericValue = normalized.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+\.\d{2}$/.test(normalized)) {
    // Quando nao ha virgula, dois digitos apos o ponto representam decimal,
    // como em 47.99 ou 1234.56, e nao um agrupamento de milhares.
    numericValue = normalized;
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized) || /^\d+$/.test(normalized)) {
    numericValue = normalized.replace(/\./g, '');
  } else {
    return null;
  }

  const parsed = Number(numericValue);
  if (!Number.isFinite(parsed) || (positive ? parsed <= 0 : parsed < 0)) return null;
  return parsed;
}

function parseQuantity(value: string | null | undefined) {
  if (!value || !/^\d+(?:[.,]\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseUnit(value: string | null | undefined) {
  // A unidade so e preservada quando aparece na mesma estrutura textual do
  // item; ausencia de coluna confiavel nao autoriza inventar UN.
  const unit = value?.trim().toUpperCase();
  return unit ? unit.slice(0, 10) : null;
}

function moneyPattern() {
  return '(?:R\\$\\s*)?(?:\\d{1,3}(?:\\.\\d{3})+|\\d+)(?:,\\d{2}|\\.\\d{2})';
}

function findLabeledAmount(text: string, labels: RegExp) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    if (!labels.test(normalize(lines[index]))) continue;
    const nearby = `${lines[index]} ${lines[index + 1] ?? ''}`;
    const match = nearby.match(new RegExp(`(${moneyPattern()})`));
    const amount = parseNumber(match?.[1]);
    if (amount !== null) return amount;
  }
  return null;
}

function extractAccessKey(text: string) {
  const normalizedText = normalize(text);
  const labelIndex = normalizedText.search(/CHAVE\s+DE\s+ACESSO/);
  if (labelIndex < 0) return null;
  const context = text.slice(labelIndex, labelIndex + 240);
  for (const match of context.matchAll(/\d[\d\s.-]{42,100}\d/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length === 44) return digits;
  }
  return null;
}

function extractNumber(text: string) {
  for (const line of text.split(/\r?\n/).map((item) => item.trim())) {
    const upper = normalize(line);
    if (!upper) continue;
    if (!/(?:NF[- ]?E|NUMERO|N[º°])/.test(upper)) continue;
    const match = upper.match(/(?:NF[- ]?E\s+(?:NUMERO|N[º°])|NF[- ]?E|NUMERO|N[º°])\s*[:.-]?\s*(\d[\d./-]{0,20})/i);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function extractIssuer(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let name: string | null = null;
  let cnpj: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const upper = normalize(line);
    if (!name && /(?:EMITENTE|RAZAO SOCIAL|NOME\/RAZAO SOCIAL)/.test(upper)) {
      const value = line.replace(/^[^:]{0,40}:\s*/i, '').trim();
      name = value && !/^(EMITENTE|RAZAO SOCIAL|NOME\/RAZAO SOCIAL)$/i.test(normalize(value))
        ? value
        : lines[index + 1] ?? null;
    }
    if (!cnpj && /CNPJ/.test(upper)) {
      const match = line.match(/CNPJ[^\d]*([\d./-]{14,18})/i);
      if (match?.[1]) cnpj = match[1];
    }
  }
  return { name: name?.slice(0, 160) ?? null, cnpj };
}

function extractIssuedAt(text: string) {
  const match = normalize(text).match(/DATA\s+DA\s+EMISSAO[^\d]*(\d{2})[/-](\d{2})[/-](\d{4})/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractItems(text: string): ParsedDanfeItem[] {
  const amount = moneyPattern();
  const items: ParsedDanfeItem[] = [];
  for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const match = line.match(new RegExp(`^(.{2,100}?)\\s+(\\d+(?:[.,]\\d+)?)(?:\\s+([A-Za-z]{1,10}))?\\s+(${amount})\\s+(${amount})$`));
    if (!match || /(?:DESCRICAO|PRODUTO|QUANTIDADE|VALOR|TOTAL|FRETE|DESCONTO)/i.test(match[1])) continue;
    const quantity = parseQuantity(match[2]);
    const unitPrice = parseNumber(match[4], true);
    const totalPrice = parseNumber(match[5]);
    if (quantity === null || unitPrice === null || totalPrice === null) continue;
    items.push({ name: match[1].replace(/[|;]+$/, '').trim(), quantity, unit: parseUnit(match[3]), unitPrice, totalPrice });
  }
  return items;
}

function extractPayment(text: string) {
  const methods = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!/(?:FORMA\s+DE\s+PAGAMENTO|PAGAMENTO)/.test(normalize(line))) continue;
    const upper = normalize(line);
    if (/PIX/.test(upper)) methods.add('Pix');
    if (/CARTAO\s+DE\s+CREDITO/.test(upper)) methods.add('Cartao de credito');
    if (/CARTAO\s+DE\s+DEBITO/.test(upper)) methods.add('Cartao de debito');
    if (/BOLETO/.test(upper)) methods.add('Boleto');
  }
  return methods.size === 1 ? [...methods][0] : null;
}

/**
 * Exige sinais combinados de documento fiscal para não classificar um PDF
 * arbitrário como DANFE por causa de uma única palavra coincidente.
 */
export function detectDanfe(text: string) {
  const upper = normalize(text);
  const hasDanfeTitle = /DANFE|DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRONICA/.test(upper);
  const hasKey = /CHAVE\s+DE\s+ACESSO/.test(upper) && extractAccessKey(text) !== null;
  const hasFiscalTotal = /VALOR\s+TOTAL\s+(?:DA\s+NOTA|NF[- ]?E)/.test(upper);
  const hasIssuer = /EMITENTE|RAZAO SOCIAL/.test(upper) && /CNPJ/.test(upper);
  const hasFiscalIdentity = /(?:NF[- ]?E|NUMERO)\b/.test(upper) && /SERIE/.test(upper);
  return Number(hasDanfeTitle) + Number(hasKey) + Number(hasFiscalTotal) + Number(hasIssuer || hasFiscalIdentity) >= 2;
}

export function parseDanfeText(text: string): ParsedDanfe | null {
  if (!detectDanfe(text)) return null;
  const issuer = extractIssuer(text);
  return {
    number: extractNumber(text),
    accessKey: extractAccessKey(text),
    issuedAt: extractIssuedAt(text),
    issuer,
    totalAmount: findLabeledAmount(text, /VALOR\s+TOTAL\s+(?:DA\s+NOTA|NF[- ]?E)\b/),
    freightAmount: findLabeledAmount(text, /(?:VALOR\s+DO\s+)?FRETE\b/),
    discountAmount: findLabeledAmount(text, /(?:VALOR\s+DO\s+)?DESCONTO\b/),
    items: extractItems(text),
    payment: extractPayment(text),
  };
}

/**
 * Usa somente bytes locais e a API textual do pdf-parse. OCR, renderização,
 * links e recursos externos ficam fora desta fase; destroy() libera o worker.
 */
export async function extractPdfText(bytes: Buffer): Promise<PdfTextResult> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new DanfePdfParseError('PDF vazio');
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({
      data: new Uint8Array(bytes),
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      enableXfa: false,
      isEvalSupported: false,
      stopAtErrors: true,
    });
    const result = await parser.getText({ lineEnforce: true, pageJoiner: '\n' });
    const text = result.text.trim();
    return text ? { status: 'TEXT_EXTRACTED', text } : { status: 'TEXT_LAYER_NOT_AVAILABLE', text: '' };
  } catch {
    throw new DanfePdfParseError('PDF invalido ou nao foi possivel extrair texto');
  } finally {
    if (parser) {
      try { await parser.destroy(); } catch { /* libera recursos sem substituir o erro principal */ }
    }
  }
}

export async function parseDanfePdf(bytes: Buffer): Promise<DanfePdfResult> {
  let extracted: PdfTextResult;
  try {
    extracted = await extractPdfText(bytes);
  } catch (error) {
    if (error instanceof DanfePdfParseError) return { status: 'INVALID_PDF', danfe: null };
    throw error;
  }
  if (extracted.status === 'TEXT_LAYER_NOT_AVAILABLE') return { status: extracted.status, danfe: null };
  const danfe = parseDanfeText(extracted.text);
  return danfe ? { status: 'PARSED', danfe } : { status: 'NOT_DANFE', danfe: null };
}
