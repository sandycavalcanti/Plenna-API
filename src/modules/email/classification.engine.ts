import type { GmailMessageDetail } from './gmail.types.js';
import type { EmailClassificationLabel } from './ai-provider.js';

export type DeterministicEmailClassification =
  | { outcome: 'COMPRA'; clear: true; confidence: 'ALTA' | 'MEDIA'; purchase: { establishment?: string | null; amount?: number | null; paymentMethodName?: string | null } }
  | { outcome: 'PROPAGANDA'; clear: true; confidence: 'ALTA' | 'MEDIA' }
  | { outcome: 'IGNORAR'; clear: true; confidence: 'BAIXA' }
  | { outcome: 'AMBIGUA'; clear: false; confidence: 'BAIXA' | 'MEDIA' };

const STRONG_PURCHASE_SIGNALS = ['pedido confirmado', 'seu pedido chegou', 'pedido chegou', 'pedido entregue', 'seu pedido foi entregue', 'pagamento aprovado', 'compra realizada', 'recebemos seu pedido', 'acompanhe seu pedido', 'recibo', 'nota fiscal', 'nf-e', 'pedido enviado', 'pedido despachado', 'pedido foi aprovado', 'confirmacao do pedido'];

// Sinais comerciais fortes. Termos curtos como "off" e "até" foram removidos
// porque não expressam intenção comercial sem contexto.
const PROMO_SIGNALS = ['compre agora', 'oferta', 'desconto', 'promocao', 'cupom', 'frete gratis', 'cashback', 'ultimas unidades', 'matricula', 'assinatura', 'produto', 'produtos', 'servico', 'venda'];

const IRRELEVANT_CAREER_SIGNALS = ['vaga', 'vagas', 'emprego', 'carreira', 'recrutamento', 'recruitment', 'processo seletivo', 'selecao', 'oportunidade profissional', 'oportunidade de carreira', 'newsletter de carreira', 'beneficios', 'trabalhe conosco', 'hiring', 'job opening'];

// Conteúdo técnico, acadêmico, editorial e operacional não é propaganda só
// porque veio de uma empresa ou recebeu o rótulo CATEGORY_PROMOTIONS.
const IRRELEVANT_CONTENT_SIGNALS = ['google classroom', 'sala de aula', 'comunicado', 'simulado', 'professor', 'alunos', 'security advisory', 'security alert', 'vulnerability', 'vulnerabilidade', 'changelog', 'release notes', 'newsletter tecnica', 'noticia', 'editorial', 'comunicado institucional', 'atualizacao do produto', 'incident report', 'alerta operacional', 'atualizacao operacional'];

const MAX_CLASSIFICATION_TEXT_LENGTH = 1200;

/** Normaliza texto sem diferenciar caixa ou acentos. */
function normalize(value: string | null | undefined) {
  return (value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Mantém somente os campos necessários para decidir a intenção da mensagem. */
export function buildClassificationHaystack(message: GmailMessageDetail) {
  return [message.subject, message.from, message.snippet, message.bodyText?.slice(0, MAX_CLASSIFICATION_TEXT_LENGTH)].map(normalize).join(' ');
}

/** Limites de palavra evitam sinais coincidindo dentro de outra palavra. */
export function scoreSignals(haystack: string, signals: string[]) {
  return signals.reduce((score, signal) => {
    const normalizedSignal = normalize(signal).trim();
    if (!normalizedSignal) return score;
    const escaped = normalizedSignal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return score + (new RegExp(`(?:^|\\s)${escaped}(?=\\s|$|[.,!?;:])`, 'i').test(haystack) ? 1 : 0);
  }, 0);
}

export function extractAmount(haystack: string) {
  const patterns = [/R\$\s?(\d{1,3}(?:\.\d{3})*,\d{2})/, /\b(\d{1,3}(?:\.\d{3})*,\d{2})\b/, /\b(\d{1,3}(?:,\d{3})*\.\d{2})\b/, /\b(\d+(?:[.,]\d{2}))\b/];
  for (const pattern of patterns) {
    const match = haystack.match(pattern)?.[1];
    if (match) {
      const value = Number(match.replace(/\./g, '').replace(',', '.'));
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

function hasMoney(haystack: string) { return extractAmount(haystack) !== null; }
function hasPromotionLabel(labelIds: string[] | undefined) { return Boolean(labelIds?.includes('CATEGORY_PROMOTIONS')); }

export function hasStrongPurchaseEvidence(message: GmailMessageDetail) { return scoreSignals(buildClassificationHaystack(message), STRONG_PURCHASE_SIGNALS) > 0; }

export function hasOrderStatusEvidence(message: GmailMessageDetail) {
  const haystack = buildClassificationHaystack(message);
  return scoreSignals(haystack, ['pedido']) > 0 && scoreSignals(haystack, ['chegou', 'entregue', 'enviado', 'despachado', 'confirmado']) > 0;
}

export function hasPromotionalEvidence(message: GmailMessageDetail) {
  // CATEGORY_PROMOTIONS é evidência fraca e nunca confirma propaganda sozinho.
  return scoreSignals(buildClassificationHaystack(message), PROMO_SIGNALS) > 0;
}

export function hasCareerOrIrrelevantEvidence(message: GmailMessageDetail) {
  const haystack = buildClassificationHaystack(message);
  return scoreSignals(haystack, IRRELEVANT_CAREER_SIGNALS) > 0 || scoreSignals(haystack, IRRELEVANT_CONTENT_SIGNALS) > 0;
}

/** Primeira camada: classificação por intenção, antes da IA. */
export class EmailClassificationEngine {
  static classify(message: GmailMessageDetail): DeterministicEmailClassification {
    const haystack = buildClassificationHaystack(message);
    const purchaseScore = scoreSignals(haystack, STRONG_PURCHASE_SIGNALS);
    const promoScore = scoreSignals(haystack, PROMO_SIGNALS);
    const irrelevantScore = scoreSignals(haystack, IRRELEVANT_CAREER_SIGNALS) + scoreSignals(haystack, IRRELEVANT_CONTENT_SIGNALS);
    const hasStrongPurchase = purchaseScore > 0;
    const hasOrderStatus = hasOrderStatusEvidence(message);

    if (irrelevantScore > 0) return { outcome: 'IGNORAR', clear: true, confidence: 'BAIXA' };
    if (hasStrongPurchase || hasOrderStatus) {
      return { outcome: 'COMPRA', clear: true, confidence: purchaseScore >= 2 || hasOrderStatus ? 'ALTA' : 'MEDIA', purchase: { establishment: message.from ?? null, amount: extractAmount(haystack), paymentMethodName: null } };
    }
    if (promoScore > 0) return { outcome: 'PROPAGANDA', clear: true, confidence: promoScore >= 2 ? 'ALTA' : 'MEDIA' };
    if (hasPromotionLabel(message.labelIds) || hasMoney(haystack)) return { outcome: 'AMBIGUA', clear: false, confidence: 'MEDIA' };
    return { outcome: 'IGNORAR', clear: true, confidence: 'BAIXA' };
  }
}

export function isClassificationLabel(value: string): value is EmailClassificationLabel {
  return value === 'COMPRA' || value === 'PROPAGANDA' || value === 'IGNORAR';
}
