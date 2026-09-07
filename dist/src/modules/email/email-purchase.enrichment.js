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
export function needsAiEnrichment(purchase) {
    return Boolean(!textOrNull(purchase.establishment)
        || !textOrNull(purchase.orderNumber)
        || purchase.totalAmount === null
        || !textOrNull(purchase.paymentMethod.rawName)
        || purchase.items.length === 0);
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
/**
 * O dado deterministico tem precedencia. A IA somente preenche lacunas e
 * seus itens sao aceitos apenas quando nao existe item deterministico.
 */
export function mergeExtractedPurchase(deterministic, ai) {
    const merged = {
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
