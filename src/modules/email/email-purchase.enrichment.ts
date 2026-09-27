import type {
  AIExtractedPurchase,
} from './ai-provider.js';
import type {
  ExtractedPurchase,
  ExtractedPurchaseItem,
  NormalizedEmail,
} from './email-contracts.js';
import { isPersistablePurchaseItem } from './purchase-items.persistence.js';

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

/**
 * Normaliza o preco unitario a partir do total da propria linha do item.
 * Nao usa o total geral da compra, pois frete, taxas e descontos podem estar
 * fora do item. A divisao so ocorre com quantidade e total positivos e finitos.
 */
export function normalizePurchaseItemPrices(purchase: ExtractedPurchase): ExtractedPurchase {
  return {
    ...purchase,
    items: purchase.items.map((item) => {
      if (item.unitPrice !== null && Number.isFinite(item.unitPrice) && item.unitPrice > 0) return item;

      const totalPrice = item.totalPrice;
      const quantity = item.quantity;
      if (
        totalPrice === null
        || !Number.isFinite(totalPrice)
        || totalPrice <= 0
        || quantity === null
        || !Number.isFinite(quantity)
        || quantity <= 0
      ) return item;

      const unitPrice = totalPrice / quantity;
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) return item;

      return { ...item, unitPrice: Number(unitPrice.toFixed(2)) };
    }),
  };
}

export function needsAiEnrichment(purchase: ExtractedPurchase) {
  // Um item identificado, mas sem nome e preco unitario validos, ainda e uma lacuna.
  const hasPersistableItem = purchase.items.some(isPersistablePurchaseItem);
  return Boolean(
    !textOrNull(purchase.establishment)
    || !textOrNull(purchase.orderNumber)
    || purchase.totalAmount === null
    || !textOrNull(purchase.paymentMethod.rawName)
    || !hasPersistableItem
  );
}

function normalizedComponentName(value: string | null) {
  return normalizeComparable(value?.trim() ?? '');
}

/** Componentes auxiliares positivos usam categoria textual, sem ID fixo. */
export function isPositivePurchaseComponent(item: ExtractedPurchaseItem) {
  const category = normalizedComponentName(item.categoryName);
  const name = normalizedComponentName(item.name);
  return category === 'frete/taxas'
    || ['frete', 'taxa', 'taxa de servico', 'taxa de entrega', 'taxa de conveniencia'].includes(name);
}

function samePositiveComponent(left: ExtractedPurchaseItem, right: ExtractedPurchaseItem) {
  const leftAmount = left.unitPrice ?? left.totalPrice;
  const rightAmount = right.unitPrice ?? right.totalPrice;
  return isPositivePurchaseComponent(left)
    && isPositivePurchaseComponent(right)
    && normalizedComponentName(left.name) === normalizedComponentName(right.name)
    && leftAmount !== null
    && rightAmount !== null
    && Math.abs(leftAmount - rightAmount) < 0.01;
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

function normalizeItemName(value: string | null) {
  return normalizeComparable(value?.trim() ?? '');
}

/**
 * Completa somente um item deterministico incompleto quando a IA retornou
 * exatamente o mesmo nome. Dados determinísticos preenchidos permanecem prioritarios.
 */
function mergeMatchingIncompleteItem(deterministic: ExtractedPurchaseItem, ai: ExtractedPurchaseItem) {
  if (isPersistablePurchaseItem(deterministic)) return deterministic;
  if (!deterministic.name?.trim() || !ai.name?.trim()) return deterministic;
  if (normalizeItemName(deterministic.name) !== normalizeItemName(ai.name)) return deterministic;

  return {
    ...deterministic,
    quantity: deterministic.quantity ?? ai.quantity,
    unitPrice: deterministic.unitPrice ?? ai.unitPrice,
    totalPrice: deterministic.totalPrice ?? ai.totalPrice,
    categoryName: deterministic.categoryName ?? ai.categoryName,
  };
}

/**
 * O dado deterministico tem precedencia. A IA preenche lacunas gerais e,
 * com correspondencia segura, completa um item deterministico incompleto.
 */
export function mergeExtractedPurchase(deterministic: ExtractedPurchase, ai: AIExtractedPurchase): ExtractedPurchase {
  const merged: ExtractedPurchase = {
    establishment: deterministic.establishment,
    orderNumber: deterministic.orderNumber,
    totalAmount: deterministic.totalAmount,
    discountAmount: deterministic.discountAmount ?? null,
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

  if (merged.discountAmount === null && ai.discountAmount !== undefined) {
    merged.discountAmount = ai.discountAmount;
  }

  if (!textOrNull(merged.paymentMethod.rawName) && textOrNull(ai.paymentMethodName)) {
    merged.paymentMethod = { rawName: textOrNull(ai.paymentMethodName) };
    addAiEvidence(merged, 'paymentMethod');
  }

  const aiItems = ai.items.filter(usableItem).map(toExtractedItem);
  if (merged.items.length === 0 && aiItems.length > 0) {
    merged.items = aiItems;
    addAiEvidence(merged, 'items');
  } else if (merged.items.length === 1 && aiItems.length === 1) {
    const completedItem = mergeMatchingIncompleteItem(merged.items[0], aiItems[0]);
    if (completedItem !== merged.items[0]) {
      merged.items = [completedItem];
      addAiEvidence(merged, 'items');
    }
  }

  // Componentes positivos retornados pela IA podem complementar produtos
  // determinísticos, mas somente quando o próprio modelo os marcou como
  // Frete/Taxas e sem duplicar nome e valor já presentes.
  const aiComponents = aiItems.filter((item) => isPositivePurchaseComponent(item));
  const newComponents = aiComponents.filter((item) => !merged.items.some((existing) => samePositiveComponent(existing, item)));
  if (newComponents.length > 0) {
    merged.items.push(...newComponents);
    addAiEvidence(merged, 'items');
  }

  return merged;
}

/**
 * Soma produtos e componentes positivos persistíveis e aplica desconto
 * explicitamente conhecido. Sem quantidade válida, a reconciliação permanece
 * inconclusiva para evitar confirmar uma compra com valor inventado.
 */
export function reconcilePurchaseTotal(
  totalAmount: number | null,
  items: ExtractedPurchaseItem[],
  discountAmount: number | null | undefined,
) {
  if (totalAmount === null || !Number.isFinite(totalAmount) || totalAmount <= 0) return false;

  let representedTotal = 0;
  for (const item of items) {
    if (!isPersistablePurchaseItem(item)) continue;
    if (item.quantity === null || !Number.isFinite(item.quantity) || item.quantity <= 0) return false;
    representedTotal += item.quantity * item.unitPrice;
  }

  const discount = discountAmount ?? 0;
  if (!Number.isFinite(discount) || discount < 0) return false;
  const reconciledTotal = representedTotal - discount;
  return Math.abs(reconciledTotal - totalAmount) <= 0.01;
}
