function normalize(value) {
    return (value ?? '')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}
export function normalizeMerchant(value) {
    return normalize(value);
}
export function normalizeOrderNumber(value) {
    return normalize(value);
}
function amount(value) {
    if (value === null)
        return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}
function sameOptionalNumber(left, right) {
    return left === null || right === null || left === right;
}
function normalizedItem(item) {
    const name = 'compra_item_nome' in item ? item.compra_item_nome : item.name;
    const rawQuantity = 'compra_item_quantidade' in item ? item.compra_item_quantidade : item.quantity;
    const quantity = rawQuantity === null ? null : Number(rawQuantity);
    const price = 'compra_item_valor' in item ? amount(item.compra_item_valor) : (item.totalPrice ?? item.unitPrice);
    return {
        name: normalize(name),
        quantity,
        price: price === null ? null : Number(price.toFixed(2)),
    };
}
function itemsMatch(existing, incoming) {
    if (existing.length === 0 || incoming.length === 0 || existing.length !== incoming.length)
        return false;
    const remaining = existing.map(normalizedItem);
    for (const incomingItem of incoming.map(normalizedItem)) {
        const matchIndex = remaining.findIndex((candidate) => candidate.name === incomingItem.name && sameOptionalNumber(candidate.quantity, incomingItem.quantity) && sameOptionalNumber(candidate.price, incomingItem.price));
        if (matchIndex < 0)
            return false;
        remaining.splice(matchIndex, 1);
    }
    return remaining.length === 0;
}
function withinWindow(left, right, windowHours) {
    return Math.abs(left.getTime() - right.getTime()) <= windowHours * 60 * 60 * 1000;
}
function sameMerchant(existing, incoming) {
    const existingMerchant = normalizeMerchant(existing.compra_fonte);
    const incomingMerchant = normalizeMerchant(incoming.establishment);
    return Boolean(existingMerchant && incomingMerchant && existingMerchant === incomingMerchant);
}
function sameOrder(existing, incoming) {
    const existingOrder = normalizeOrderNumber(existing.compra_pedido_externo_id);
    const incomingOrder = normalizeOrderNumber(incoming.orderNumber);
    return Boolean(existingOrder && incomingOrder && existingOrder === incomingOrder);
}
/**
 * Procura uma compra existente sem transformar heuristicas em identidade
 * financeira. Pedido e estabelecimento sao a evidencia principal; sem pedido,
 * a janela temporal evita fundir compras recorrentes identicas.
 */
export function findReconciliationMatch(candidates, userId, incoming, incomingDate, windowHours) {
    if (incoming.orderNumber && incoming.establishment) {
        const orderMatches = candidates.filter((candidate) => candidate.usuario_id === userId && sameMerchant(candidate, incoming) && sameOrder(candidate, incoming));
        if (orderMatches.length === 1)
            return { purchase: orderMatches[0], reason: 'ORDER_NUMBER' };
        if (orderMatches.length > 1)
            return null;
    }
    if (!incoming.establishment || incoming.totalAmount === null)
        return null;
    const fallbackMatches = candidates.filter((candidate) => {
        if (candidate.usuario_id !== userId || candidate.compra_pedido_externo_id || !sameMerchant(candidate, incoming))
            return false;
        if (amount(candidate.compra_valor) !== incoming.totalAmount)
            return false;
        if (!withinWindow(candidate.compra_horario, incomingDate, windowHours))
            return false;
        if (candidate.tb_compra_item.length === 0 || incoming.items.length === 0) {
            return false;
        }
        return itemsMatch(candidate.tb_compra_item, incoming.items);
    });
    return fallbackMatches.length === 1 ? { purchase: fallbackMatches[0], reason: 'FALLBACK' } : null;
}
export function buildPurchaseUpdate(existing, incoming, paymentMethodId) {
    const data = {};
    if (!existing.compra_pedido_externo_id && incoming.orderNumber)
        data.compra_pedido_externo_id = incoming.orderNumber;
    if (!existing.compra_fonte && incoming.establishment)
        data.compra_fonte = incoming.establishment;
    if (existing.compra_valor === null && incoming.totalAmount !== null)
        data.compra_valor = incoming.totalAmount;
    if (existing.forma_pagamento_id === null && paymentMethodId !== null)
        data.forma_pagamento_id = paymentMethodId;
    return data;
}
