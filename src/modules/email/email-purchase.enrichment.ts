import type {
  AIExtractedPurchase,
} from './ai-provider.js';
import type {
  ExtractedPurchase,
  ExtractedPurchaseItem,
  NormalizedEmail,
} from './email-contracts.js';

const MAX_EXTRACTION_TEXT_LENGTH = 12_000;

function textOrNull(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * Monta somente o contexto necessário para extração, sem HTML, anexos ou
 * qualquer credencial. O limite evita enviar corpos excessivamente grandes.
 */
export function buildPurchaseExtractionPrompt(email: NormalizedEmail) {
  const textBody = (email.textBody ?? '').slice(0, MAX_EXTRACTION_TEXT_LENGTH);
  return [
    'Extraia a compra do seguinte e-mail.',
    `subject: ${email.subject ?? ''}`,
    `from: ${email.from ?? ''}`,
    `snippet: ${email.snippet ?? ''}`,
    `textBody: ${textBody}`,
  ].join('\n');
}

/** Usa o mesmo corpo textual normalizado consumido pelo extrator e pela IA. */
export function buildPurchaseEvidenceText(email: NormalizedEmail) {
  return [email.subject, email.snippet, email.textBody].filter((value): value is string => Boolean(value?.trim())).join('\n');
}

export function needsAiEnrichment(purchase: ExtractedPurchase) {
  return Boolean(
    !textOrNull(purchase.establishment)
    || !textOrNull(purchase.orderNumber)
    || purchase.totalAmount === null
    || !textOrNull(purchase.paymentMethod.rawName)
    || purchase.items.length === 0
  );
}

function normalizeComparable(value: string) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * Resolve o caso seguro de item único sem inventar produto ou valor.
 * O total só vira unitPrice quando o nome aparece no texto, há um único item,
 * os valores coincidem e não há sinais de frete, taxa, desconto ou parcela.
 */
export function resolveSafeSingleItemPrice(purchase: ExtractedPurchase, sourceText: string): ExtractedPurchase {
  if (purchase.items.length !== 1 || purchase.totalAmount === null) return purchase;

  const [item] = purchase.items;
  if (!item.name?.trim() || (item.quantity !== null && item.quantity !== 1) || item.unitPrice !== null) return purchase;

  const normalizedSource = normalizeComparable(sourceText);
  const normalizedName = normalizeComparable(item.name.trim());
  const hasNameEvidence = normalizedName.length >= 3 && normalizedSource.includes(normalizedName);
  const hasModifier = /\b(frete|taxa|desconto|cupom|cashback|parcela|juros)\b/i.test(normalizedSource);
  if (!hasNameEvidence || hasModifier) return purchase;

  const candidate = item.totalPrice ?? null;
  const hasOneCurrencyValue = (sourceText.match(/R\$\s*\d[\d.]*[,.]\d{2}/gi) ?? []).length === 1;
  const matchesTotal = candidate !== null
    ? Math.abs(candidate - purchase.totalAmount) < 0.01
    : hasOneCurrencyValue;
  if (!matchesTotal) return purchase;

  return {
    ...purchase,
    items: [{ ...item, quantity: item.quantity ?? 1, unitPrice: candidate ?? purchase.totalAmount }],
  };
}

function usableItem(item: AIExtractedPurchase['items'][number]) {
  return Boolean(
    textOrNull(item.name)
    || item.quantity !== null
    || item.unitPrice !== null
    || item.totalPrice !== null
    || textOrNull(item.categoryName)
  );
}

function toExtractedItem(item: AIExtractedPurchase['items'][number]): ExtractedPurchaseItem {
  return {
    name: textOrNull(item.name),
    quantity: item.quantity,
    unit: null,
    unitPrice: item.unitPrice,
    totalPrice: item.totalPrice,
    categoryName: textOrNull(item.categoryName),
  };
}

function addAiEvidence(purchase: ExtractedPurchase, field: 'establishment' | 'orderNumber' | 'totalAmount' | 'paymentMethod' | 'items') {
  purchase.evidence.push({
    field,
    source: 'AI',
    confidence: null,
    rawLabel: null,
    context: null,
  });
}

/**
 * O dado deterministico tem precedencia. A IA somente preenche lacunas e
 * seus itens sao aceitos apenas quando nao existe item deterministico.
 */
export function mergeExtractedPurchase(deterministic: ExtractedPurchase, ai: AIExtractedPurchase): ExtractedPurchase {
  const merged: ExtractedPurchase = {
    establishment: deterministic.establishment,
    orderNumber: deterministic.orderNumber,
    totalAmount: deterministic.totalAmount,
    paymentMethod: { rawName: deterministic.paymentMethod.rawName },
    items: [...deterministic.items],
    invoice: deterministic.invoice,
    evidence: [...deterministic.evidence],
  };

  if (!textOrNull(merged.establishment) && textOrNull(ai.establishment)) {
    merged.establishment = textOrNull(ai.establishment);
    addAiEvidence(merged, 'establishment');
  }

  if (!textOrNull(merged.orderNumber) && textOrNull(ai.orderNumber)) {
    merged.orderNumber = textOrNull(ai.orderNumber);
    addAiEvidence(merged, 'orderNumber');
  }

  if (merged.totalAmount === null && ai.totalAmount !== null) {
    merged.totalAmount = ai.totalAmount;
    addAiEvidence(merged, 'totalAmount');
  }

  if (!textOrNull(merged.paymentMethod.rawName) && textOrNull(ai.paymentMethodName)) {
    merged.paymentMethod = { rawName: textOrNull(ai.paymentMethodName) };
    addAiEvidence(merged, 'paymentMethod');
  }

  const aiItems = ai.items.filter(usableItem).map(toExtractedItem);
  if (merged.items.length === 0 && aiItems.length > 0) {
    merged.items = aiItems;
    addAiEvidence(merged, 'items');
  }

  return merged;
}
