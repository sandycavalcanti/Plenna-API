import type { GmailMessageDetail } from './gmail.types.js';
import type { EmailClassificationLabel } from './ai-provider.js';

export type DeterministicEmailClassification =
  | { outcome: 'COMPRA'; clear: true; confidence: 'ALTA' | 'MEDIA'; purchase: { establishment?: string | null; amount?: number | null; paymentMethodName?: string | null } }
  | { outcome: 'PROPAGANDA'; clear: true; confidence: 'ALTA' | 'MEDIA'; categoryName?: string | null }
  | { outcome: 'IGNORAR'; clear: true; confidence: 'BAIXA' }
  | { outcome: 'AMBIGUA'; clear: false; confidence: 'BAIXA' | 'MEDIA' };

const STRONG_PURCHASE_SIGNALS = [
  'pedido confirmado',
  'seu pedido chegou',
  'pedido chegou',
  'pedido entregue',
  'seu pedido foi entregue',
  'pagamento aprovado',
  'compra realizada',
  'recebemos seu pedido',
  'acompanhe seu pedido',
  'recibo',
  'nota fiscal',
  'nf-e',
  'pedido enviado',
  'pedido despachado',
  'pedido foi aprovado',
  'confirmacao do pedido',
];

const PROMO_SIGNALS = [
  'compre agora',
  'oferta',
  'desconto',
  'promoção',
  'cupom',
  'frete grátis',
  'cashback',
  'últimas unidades',
  'ultimas unidades',
  'até',
  'off',
];

const IRRELEVANT_CAREER_SIGNALS = [
  'vaga',
  'vagas',
  'emprego',
  'carreira',
  'recrutamento',
  'recruitment',
  'processo seletivo',
  'seleção',
  'selecao',
  'oportunidade profissional',
  'oportunidade de carreira',
  'newsletter de carreira',
  'benefícios',
  'beneficios',
  'trabalhe conosco',
  'hiring',
  'job opening',
];

const MAX_CLASSIFICATION_TEXT_LENGTH = 1200;

/**
 * Normaliza texto para comparação textual insensível a caixa e acentos.
 */
function normalize(value: string | null | undefined) {
  return (value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * Concatena apenas os campos mínimos necessários para a classificação.
 */
export function buildClassificationHaystack(message: GmailMessageDetail) {
  return [message.subject, message.from, message.snippet, message.bodyText?.slice(0, MAX_CLASSIFICATION_TEXT_LENGTH)]
    .map(normalize)
    .join(' ');
}

/**
 * Soma quantos sinais conhecidos existem na mensagem.
 *
 * Cada sinal também é normalizado antes da comparação para evitar falhas
 * causadas por acentos ou capitalização.
 */
export function scoreSignals(haystack: string, signals: string[]) {
  return signals.reduce((score, signal) => score + (haystack.includes(normalize(signal)) ? 1 : 0), 0);
}

export function extractAmount(haystack: string) {
  const patterns = [
    /R\$\s?(\d{1,3}(?:\.\d{3})*,\d{2})/,
    /\b(\d{1,3}(?:\.\d{3})*,\d{2})\b/,
    /\b(\d{1,3}(?:,\d{3})*\.\d{2})\b/,
    /\b(\d+(?:[.,]\d{2}))\b/,
  ];

  for (const pattern of patterns) {
    const match = haystack.match(pattern)?.[1];
    if (match) {
      const normalized = match.replace(/\./g, '').replace(',', '.');
      const value = Number(normalized);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }

  return null;
}

function hasMoney(haystack: string) {
  return extractAmount(haystack) !== null;
}

function hasPromotionLabel(labelIds: string[] | undefined) {
  return Boolean(labelIds?.includes('CATEGORY_PROMOTIONS'));
}

export function hasStrongPurchaseEvidence(message: GmailMessageDetail) {
  const haystack = buildClassificationHaystack(message);
  return scoreSignals(haystack, STRONG_PURCHASE_SIGNALS) > 0;
}

export function hasOrderStatusEvidence(message: GmailMessageDetail) {
  const haystack = buildClassificationHaystack(message);
  const hasPedido = haystack.includes(normalize('pedido'));
  const hasStatus = [
    'chegou',
    'entregue',
    'enviado',
    'despachado',
    'confirmado',
    'recebemos seu pedido',
    'acompanhe seu pedido',
  ].some((signal) => haystack.includes(normalize(signal)));

  return hasPedido && hasStatus;
}

export function hasPromotionalEvidence(message: GmailMessageDetail) {
  const haystack = buildClassificationHaystack(message);
  return scoreSignals(haystack, PROMO_SIGNALS) > 0 || hasPromotionLabel(message.labelIds);
}

export function hasCareerOrIrrelevantEvidence(message: GmailMessageDetail) {
  const haystack = buildClassificationHaystack(message);
  return scoreSignals(haystack, IRRELEVANT_CAREER_SIGNALS) > 0;
}

/**
 * Classificador determinístico usado como primeira camada do pipeline.
 */
export class EmailClassificationEngine {
  static classify(message: GmailMessageDetail): DeterministicEmailClassification {
    const haystack = buildClassificationHaystack(message);
    const purchaseScore = scoreSignals(haystack, STRONG_PURCHASE_SIGNALS);
    const promoScore = scoreSignals(haystack, PROMO_SIGNALS);
    const irrelevantScore = scoreSignals(haystack, IRRELEVANT_CAREER_SIGNALS);
    const hasPromoLabel = hasPromotionLabel(message.labelIds);
    const hasStrongPurchase = purchaseScore > 0;
    const hasOrderStatus = hasOrderStatusEvidence(message);
    const hasPromoSignals = promoScore > 0;

    if (irrelevantScore > 0) {
      return { outcome: 'IGNORAR', clear: true, confidence: 'BAIXA' };
    }

    if (hasStrongPurchase || hasOrderStatus) {
      return {
        outcome: 'COMPRA',
        clear: true,
        confidence: purchaseScore >= 2 || hasOrderStatus ? 'ALTA' : 'MEDIA',
        purchase: {
          establishment: message.from ?? null,
          amount: extractAmount(haystack),
          paymentMethodName: null,
        },
      };
    }

    if (hasPromoSignals) {
      return {
        outcome: 'PROPAGANDA',
        clear: true,
        confidence: promoScore >= 2 ? 'ALTA' : 'MEDIA',
        categoryName: null,
      };
    }

    if (hasPromoLabel) {
      return { outcome: 'AMBIGUA', clear: false, confidence: 'MEDIA' };
    }

    if (hasMoney(haystack)) {
      return { outcome: 'AMBIGUA', clear: false, confidence: 'MEDIA' };
    }

    return { outcome: 'IGNORAR', clear: true, confidence: 'BAIXA' };
  }
}

export function isClassificationLabel(value: string): value is EmailClassificationLabel {
  return value === 'COMPRA' || value === 'PROPAGANDA' || value === 'IGNORAR';
}
