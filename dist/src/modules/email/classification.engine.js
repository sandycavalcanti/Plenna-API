const BUY_SIGNALS = ['pedido confirmado', 'pagamento aprovado', 'compra realizada', 'recebemos seu pedido', 'recibo', 'nota fiscal', 'nf-e', 'pedido #'];
const PROMO_SIGNALS = ['oferta', 'desconto', 'promoção', 'cupom', 'frete grátis', 'marketing'];
const MAX_CLASSIFICATION_TEXT_LENGTH = 1200;
/**
 * Normaliza texto para comparação textual insensível a caixa e acentos.
 */
function normalize(value) {
    return (value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}
/**
 * Concatena apenas os campos mínimos necessários para a classificação.
 */
function buildHaystack(message) {
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
function scoreSignals(haystack, signals) {
    return signals.reduce((score, signal) => score + (haystack.includes(normalize(signal)) ? 1 : 0), 0);
}
function extractAmount(haystack) {
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
            if (Number.isFinite(value) && value > 0)
                return value;
        }
    }
    return null;
}
function hasMoney(haystack) {
    return extractAmount(haystack) !== null;
}
function hasPromotionLabel(labelIds) {
    return Boolean(labelIds?.includes('CATEGORY_PROMOTIONS'));
}
/**
 * Classificador determinístico usado como primeira camada do pipeline.
 */
export class EmailClassificationEngine {
    static classify(message) {
        const haystack = buildHaystack(message);
        const buyScore = scoreSignals(haystack, BUY_SIGNALS);
        const promoScore = scoreSignals(haystack, PROMO_SIGNALS);
        const hasPromoLabel = hasPromotionLabel(message.labelIds);
        if (buyScore > 0 && promoScore > 0) {
            return { outcome: 'AMBIGUA', clear: false, confidence: 'MEDIA' };
        }
        if (buyScore >= 2 || (buyScore >= 1 && hasMoney(haystack) && promoScore === 0)) {
            return {
                outcome: 'COMPRA',
                clear: true,
                confidence: buyScore >= 2 ? 'ALTA' : 'MEDIA',
                purchase: {
                    establishment: message.from ?? null,
                    amount: extractAmount(haystack),
                    paymentMethodName: null,
                },
            };
        }
        if (promoScore >= 2 || (promoScore >= 1 && hasPromoLabel && buyScore === 0)) {
            return {
                outcome: 'PROPAGANDA',
                clear: true,
                confidence: promoScore >= 2 ? 'ALTA' : 'MEDIA',
                categoryName: null,
            };
        }
        if (hasPromoLabel && buyScore === 0 && promoScore === 0) {
            return { outcome: 'AMBIGUA', clear: false, confidence: 'BAIXA' };
        }
        if (buyScore > 0 || promoScore > 0) {
            return { outcome: 'AMBIGUA', clear: false, confidence: 'MEDIA' };
        }
        return { outcome: 'IGNORAR', clear: true, confidence: 'BAIXA' };
    }
}
export function isClassificationLabel(value) {
    return value === 'COMPRA' || value === 'PROPAGANDA' || value === 'IGNORAR';
}
