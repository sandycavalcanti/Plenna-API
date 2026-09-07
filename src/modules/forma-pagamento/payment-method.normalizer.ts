export type CanonicalPaymentMethodName =
  | 'Pix'
  | 'Cartão de crédito'
  | 'Cartão de débito'
  | 'Boleto'
  | 'PayPal';

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:final\s+)?\d{4}$/, '');
}

/**
 * Converge aliases conhecidos para nomes canônicos, sem fuzzy matching.
 * O texto canônico ainda nao representa um ID ou registro persistido.
 */
export function normalizePaymentMethodName(rawName: string | null | undefined): CanonicalPaymentMethodName | null {
  if (!rawName?.trim()) return null;

  const normalized = normalizeText(rawName);
  const aliases: Record<string, CanonicalPaymentMethodName> = {
    pix: 'Pix',
    'pagamento pix': 'Pix',
    'pix pagamento instantaneo': 'Pix',
    credito: 'Cartão de crédito',
    'cartao credito': 'Cartão de crédito',
    'cartao de credito': 'Cartão de crédito',
    debito: 'Cartão de débito',
    'cartao debito': 'Cartão de débito',
    'cartao de debito': 'Cartão de débito',
    boleto: 'Boleto',
    'boleto bancario': 'Boleto',
    paypal: 'PayPal',
  };

  return aliases[normalized] ?? null;
}
