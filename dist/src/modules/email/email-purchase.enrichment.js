import { isPersistablePurchaseItem } from './purchase-items.persistence.js';
const MAX_EXTRACTION_TEXT_LENGTH = 12000;
function textOrNull(value) {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}
/**
 * Monta somente o contexto necessário para extração, sem HTML, anexos ou
 * qualquer credencial. O limite evita enviar corpos excessivamente grandes.
 */
export function buildPurchaseExtractionPrompt(email) {
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
export function buildPurchaseEvidenceText(email) {
    return [email.subject, email.snippet, email.textBody].filter((value) => Boolean(value?.trim())).join('\n');
}
function amountTextCandidates(amount) {
    const fixed = amount.toFixed(2);
    const ptBr = fixed.replace('.', ',');
    return [`${fixed}`, `${ptBr}`, `R$ ${fixed}`, `R$ ${ptBr}`];
}
function amountIsSupportedByText(amount, sourceText) {
    if (amount === null || !Number.isFinite(amount) || amount <= 0)
        return false;
    const normalized = sourceText.toLowerCase().replace(/\s+/g, ' ');
    return amountTextCandidates(amount).some((candidate) => normalized.includes(candidate.toLowerCase()));
}
/**
 * Normaliza o preco unitario a partir do total da propria linha do item.
 * Nao usa o total geral da compra, pois frete, taxas e descontos podem estar
 * fora do item. A divisao so ocorre com quantidade e total positivos e finitos.
 */
export function normalizePurchaseItemPrices(purchase) {
    return {
        ...purchase,
        items: purchase.items.map((item) => {
            if (item.unitPrice !== null && Number.isFinite(item.unitPrice) && item.unitPrice > 0)
                return item;
            const totalPrice = item.totalPrice;
            const quantity = item.quantity;
            if (totalPrice === null
                || !Number.isFinite(totalPrice)
                || totalPrice <= 0
                || quantity === null
                || !Number.isFinite(quantity)
                || quantity <= 0)
                return item;
            const unitPrice = totalPrice / quantity;
            if (!Number.isFinite(unitPrice) || unitPrice <= 0)
                return item;
            return { ...item, unitPrice: Number(unitPrice.toFixed(2)) };
        }),
    };
}
export function needsAiEnrichment(purchase) {
    // Um item identificado, mas sem nome e preco unitario validos, ainda e uma lacuna.
    const hasPersistableItem = purchase.items.some(isPersistablePurchaseItem);
    return Boolean(!textOrNull(purchase.establishment)
        || !textOrNull(purchase.orderNumber)
        || purchase.totalAmount === null
        || !textOrNull(purchase.paymentMethod.rawName)
        || !hasPersistableItem);
}
function normalizedComponentName(value) {
    return normalizeComparable(value?.trim() ?? '');
}
/** Componentes auxiliares positivos usam categoria textual, sem ID fixo. */
export function isPositivePurchaseComponent(item) {
    const category = normalizedComponentName(item.categoryName);
    const name = normalizedComponentName(item.name);
    return category === 'frete/taxas'
        || [
            'frete',
            'taxa',
            'taxa de servico',
            'taxa de entrega',
            'taxa de conveniencia',
            'taxa adicional',
            'taxa administrativa',
        ].includes(name);
}
function parseExplicitComponentAmount(value) {
    const match = value.match(/(?:r\$\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+)[,.]\d{2})/i);
    if (!match?.[1])
        return null;
    const normalized = match[1].includes(',')
        ? match[1].replace(/\./g, '').replace(',', '.')
        : match[1];
    const amount = Number(normalized);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
}
/**
 * Recupera o valor de uma taxa somente quando o rótulo e o dinheiro estão
 * explicitamente associados no texto. Isso evita usar totais ou diferenças
 * matemáticas como preço de componente.
 */
function findExplicitComponentAmount(itemName, sourceText) {
    const target = normalizedComponentName(itemName);
    if (!target)
        return null;
    const lines = sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const normalizedLine = normalizedComponentName(line).replace(/:\s*$/, '');
        if (normalizedLine !== target)
            continue;
        const inlineAmount = parseExplicitComponentAmount(line.split(':').slice(1).join(':'));
        if (inlineAmount !== null)
            return inlineAmount;
        const nextLineAmount = parseExplicitComponentAmount(lines[index + 1] ?? '');
        if (nextLineAmount !== null)
            return nextLineAmount;
    }
    return null;
}
/**
 * Completa apenas componentes positivos cujo valor aparece junto ao rótulo
 * da taxa. Produtos e regras gerais de reconciliação não passam por este
 * ajuste, preservando o escopo cirúrgico do enriquecimento.
 */
export function normalizePositiveComponentPrices(purchase, sourceText) {
    return {
        ...purchase,
        items: purchase.items.map((item) => {
            if (!isPositivePurchaseComponent(item))
                return item;
            if (item.unitPrice !== null && Number.isFinite(item.unitPrice) && item.unitPrice > 0)
                return item;
            const quantity = item.quantity ?? 1;
            if (!Number.isFinite(quantity) || quantity <= 0)
                return item;
            const explicitAmount = findExplicitComponentAmount(item.name, sourceText);
            if (explicitAmount === null)
                return item;
            return {
                ...item,
                quantity,
                unitPrice: Number((explicitAmount / quantity).toFixed(2)),
                totalPrice: item.totalPrice ?? explicitAmount,
            };
        }),
    };
}
function samePositiveComponent(left, right) {
    const leftAmount = left.unitPrice ?? left.totalPrice;
    const rightAmount = right.unitPrice ?? right.totalPrice;
    return isPositivePurchaseComponent(left)
        && isPositivePurchaseComponent(right)
        && normalizedComponentName(left.name) === normalizedComponentName(right.name)
        && leftAmount !== null
        && rightAmount !== null
        && Math.abs(leftAmount - rightAmount) < 0.01;
}
function normalizeComparable(value) {
    return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}
/**
 * Resolve o caso seguro de item único sem inventar produto ou valor.
 * O total só vira unitPrice quando o nome aparece no texto, há um único item,
 * os valores coincidem e não há sinais de frete, taxa, desconto ou parcela.
 */
export function resolveSafeSingleItemPrice(purchase, sourceText) {
    if (purchase.items.length !== 1 || purchase.totalAmount === null)
        return purchase;
    const [item] = purchase.items;
    if (!item.name?.trim() || (item.quantity !== null && item.quantity !== 1) || item.unitPrice !== null)
        return purchase;
    const normalizedSource = normalizeComparable(sourceText);
    const normalizedName = normalizeComparable(item.name.trim());
    const hasNameEvidence = normalizedName.length >= 3 && normalizedSource.includes(normalizedName);
    const hasModifier = /\b(frete|taxa|desconto|cupom|cashback|parcela|juros)\b/i.test(normalizedSource);
    if (!hasNameEvidence || hasModifier)
        return purchase;
    const candidate = item.totalPrice ?? null;
    const hasOneCurrencyValue = (sourceText.match(/R\$\s*\d[\d.]*[,.]\d{2}/gi) ?? []).length === 1;
    const matchesTotal = candidate !== null
        ? Math.abs(candidate - purchase.totalAmount) < 0.01
        : hasOneCurrencyValue;
    if (!matchesTotal)
        return purchase;
    return {
        ...purchase,
        items: [{ ...item, quantity: item.quantity ?? 1, unitPrice: candidate ?? purchase.totalAmount }],
    };
}
function usableItem(item) {
    return Boolean(textOrNull(item.name)
        || item.quantity !== null
        || item.unitPrice !== null
        || item.totalPrice !== null
        || textOrNull(item.categoryName));
}
function toExtractedItem(item) {
    return {
        name: textOrNull(item.name),
        quantity: item.quantity,
        unit: null,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        categoryName: textOrNull(item.categoryName),
    };
}
function addAiEvidence(purchase, field) {
    purchase.evidence.push({
        field,
        source: 'AI',
        confidence: null,
        rawLabel: null,
        context: null,
    });
}
function normalizeItemName(value) {
    return normalizeComparable(value?.trim() ?? '');
}
/**
 * Completa somente um item deterministico incompleto quando a IA retornou
 * exatamente o mesmo nome. Dados determinísticos preenchidos permanecem prioritarios.
 */
function mergeMatchingIncompleteItem(deterministic, ai) {
    if (isPersistablePurchaseItem(deterministic))
        return deterministic;
    if (!deterministic.name?.trim() || !ai.name?.trim())
        return deterministic;
    if (normalizeItemName(deterministic.name) !== normalizeItemName(ai.name))
        return deterministic;
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
export function mergeExtractedPurchase(deterministic, ai, sourceText = '') {
    const merged = {
        establishment: deterministic.establishment,
        orderNumber: deterministic.orderNumber,
        totalAmount: deterministic.totalAmount,
        totalAmountSource: deterministic.totalAmountSource ?? null,
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
    // O total da IA so pode superar um fallback fraco quando o proprio valor
    // aparece no texto recebido; um valor semanticamente deterministico sempre vence.
    const aiTotalSupported = ai.totalAmount !== null
        && (!sourceText || amountIsSupportedByText(ai.totalAmount, sourceText));
    if (aiTotalSupported
        && (merged.totalAmount === null || merged.totalAmountSource === 'CLASSIFICATION_FALLBACK')) {
        merged.totalAmount = ai.totalAmount;
        merged.totalAmountSource = 'AI';
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
    }
    else if (merged.items.length > 0 && aiItems.length > 0) {
        const remainingAiItems = [...aiItems];
        let itemEvidenceAdded = false;
        merged.items = merged.items.map((deterministicItem) => {
            const deterministicName = normalizeItemName(deterministicItem.name);
            const matchIndex = deterministicName
                ? remainingAiItems.findIndex((aiItem) => deterministicName === normalizeItemName(aiItem.name))
                : -1;
            if (matchIndex < 0)
                return deterministicItem;
            const [aiItem] = remainingAiItems.splice(matchIndex, 1);
            const completedItem = mergeMatchingIncompleteItem(deterministicItem, aiItem);
            if (completedItem !== deterministicItem)
                itemEvidenceAdded = true;
            return completedItem;
        });
        if (itemEvidenceAdded) {
            addAiEvidence(merged, 'items');
        }
        // Componentes positivos sem correspondencia podem complementar a lista,
        // mesmo quando a IA tambem retornou o produto principal.
        const newComponents = remainingAiItems
            .filter((item) => isPositivePurchaseComponent(item))
            .filter((item) => !merged.items.some((existing) => samePositiveComponent(existing, item)));
        if (newComponents.length > 0) {
            merged.items.push(...newComponents);
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
export function reconcilePurchaseTotal(totalAmount, items, discountAmount) {
    if (totalAmount === null || !Number.isFinite(totalAmount) || totalAmount <= 0)
        return false;
    let representedTotal = 0;
    for (const item of items) {
        if (!isPersistablePurchaseItem(item))
            continue;
        // Componentes positivos explicitamente cobrados representam uma linha
        // única quando a origem não informou quantidade; isso é compatível com a
        // persistência, que aceita quantidade nula, sem flexibilizar produtos.
        const effectiveQuantity = (item.quantity === null || item.quantity === undefined) && isPositivePurchaseComponent(item)
            ? 1
            : item.quantity;
        if (effectiveQuantity === null || !Number.isFinite(effectiveQuantity) || effectiveQuantity <= 0)
            return false;
        representedTotal += effectiveQuantity * item.unitPrice;
    }
    const discount = discountAmount ?? 0;
    if (!Number.isFinite(discount) || discount < 0)
        return false;
    const reconciledTotal = representedTotal - discount;
    return Math.abs(reconciledTotal - totalAmount) <= 0.01;
}
