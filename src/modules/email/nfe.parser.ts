import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type ParsedNFeIssuer = {
  name: string | null;
  cnpj: string | null;
};

export type ParsedNFeItem = {
  name: string | null;
  quantity: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
};

export type ParsedNFePayment = {
  code: string | null;
  name: string | null;
  amount: number | null;
};

export type ParsedNFe = {
  number: string | null;
  accessKey: string | null;
  issuedAt: Date | null;
  issuer: ParsedNFeIssuer;
  totalAmount: number | null;
  freightAmount: number | null;
  discountAmount: number | null;
  items: ParsedNFeItem[];
  payments: ParsedNFePayment[];
};

export class NFeXmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeXmlParseError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  processEntities: false,
  ignoreDeclaration: true,
  maxNestedTags: 100,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
  const record = asRecord(value);
  return record ? [record] : [];
}

function parseNonNegative(value: unknown) {
  const text = asText(value)?.replace(',', '.');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositive(value: unknown) {
  const parsed = parseNonNegative(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseDate(value: unknown) {
  const text = asText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseAccessKey(value: unknown) {
  const id = asText(value);
  const match = id?.match(/^NFe(\d{44})$/);
  return match?.[1] ?? null;
}

function paymentName(code: string | null, description: string | null) {
  const names: Record<string, string> = {
    '01': 'Dinheiro',
    '02': 'Cheque',
    '03': 'Cartão de crédito',
    '04': 'Cartão de débito',
    '05': 'Crédito loja',
    '10': 'Vale alimentação',
    '11': 'Vale refeição',
    '12': 'Vale presente',
    '13': 'Vale combustível',
    '14': 'Duplicata mercantil',
    '15': 'Boleto bancário',
    '16': 'Depósito bancário',
    '17': 'PIX',
    '18': 'Transferência bancária, carteira digital',
    '19': 'Programa de fidelidade, cashback, crédito virtual',
    '90': 'Sem pagamento',
  };
  return (code && names[code]) ?? description ?? (code === '99' ? 'Outros' : null);
}

function rejectUnsafeXml(xml: string) {
  // DTD e ENTITY podem habilitar resolução externa ou expansão de entidades;
  // rejeitar antes do parser cria uma barreira independente da biblioteca.
  if (/<\s*!DOCTYPE\b/i.test(xml) || /<\s*!ENTITY\b/i.test(xml)) {
    throw new NFeXmlParseError('XML com DTD ou entidade customizada nao suportado');
  }
}

function parseXml(xml: string) {
  rejectUnsafeXml(xml);
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new NFeXmlParseError('XML malformado');

  try {
    return asRecord(parser.parse(xml));
  } catch {
    throw new NFeXmlParseError('Falha ao interpretar XML');
  }
}

function findInfNFe(document: Record<string, unknown>) {
  const proc = asRecord(document.nfeProc);
  const nfe = asRecord(proc?.NFe ?? document.NFe);
  const infNFe = asRecord(nfe?.infNFe);
  if (!nfe || !infNFe) throw new NFeXmlParseError('XML nao possui estrutura de NF-e');
  return infNFe;
}

/**
 * Interpreta localmente somente a estrutura fiscal necessária ao Plenna.
 * O XML continua sendo tratado como conteúdo externo: nenhum dado é salvo,
 * enviado à IA ou usado para acessar rede durante esta etapa.
 */
export function parseNFeXml(bytes: Buffer): ParsedNFe {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new NFeXmlParseError('Attachment XML vazio');
  const document = parseXml(bytes.toString('utf8'));
  if (!document) throw new NFeXmlParseError('XML vazio ou invalido');

  const infNFe = findInfNFe(document);
  const ide = asRecord(infNFe.ide);
  const emit = asRecord(infNFe.emit);
  const total = asRecord(asRecord(infNFe.total)?.ICMSTot);
  const items = asArray(infNFe.det).map((det) => {
    const product = asRecord(det.prod);
    return {
      name: asText(product?.xProd),
      quantity: parsePositive(product?.qCom),
      unitPrice: parsePositive(product?.vUnCom),
      totalPrice: parseNonNegative(product?.vProd),
    };
  });

  const payments = asArray(asRecord(infNFe.pag)?.detPag).map((payment) => {
    const code = asText(payment.tPag);
    return {
      code,
      name: paymentName(code, asText(payment.xPag)),
      amount: parseNonNegative(payment.vPag),
    };
  });

  return {
    number: asText(ide?.nNF),
    accessKey: parseAccessKey(infNFe['@_Id']),
    issuedAt: parseDate(ide?.dhEmi ?? ide?.dEmi),
    issuer: { name: asText(emit?.xNome), cnpj: asText(emit?.CNPJ) },
    totalAmount: parseNonNegative(total?.vNF),
    freightAmount: parseNonNegative(total?.vFrete),
    discountAmount: parseNonNegative(total?.vDesc),
    items,
    payments,
  };
}
