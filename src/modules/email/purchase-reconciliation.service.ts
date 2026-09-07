import type { ExtractedPurchase, ExtractedPurchaseItem } from './email-contracts.js';

export type ReconciliationItem = {
  compra_item_nome: string;
  compra_item_quantidade: number | string | { toString(): string } | null;
  compra_item_valor: number | string | { toString(): string };
};

export type ReconciliationPurchase = {
  compra_id: number;
  usuario_id: number;
  compra_fonte: string | null;
  compra_pedido_externo_id: string | null;
  compra_valor: number | string | { toString(): string } | null;
  forma_pagamento_id: number | null;
  compra_email_mensagem_id: string | null;
  compra_horario: Date;
  tb_compra_item: ReconciliationItem[];
};

export type ReconciliationMatch = {
  purchase: ReconciliationPurchase;
  reason: 'ORDER_NUMBER' | 'FALLBACK';
};

function normalize(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeMerchant(value: string | null | undefined) {
  return normalize(value);
}

export function normalizeOrderNumber(value: string | null | undefined) {
  return normalize(value);
}

function amount(value: number | string | { toString(): string } | null) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function sameOptionalNumber(left: number | null, right: number | null) {
  return left === null || right === null || left === right;
}

function normalizedItem(item: ReconciliationItem | ExtractedPurchaseItem) {
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

function itemsMatch(existing: ReconciliationItem[], incoming: ExtractedPurchaseItem[]) {
  if (existing.length === 0 || incoming.length === 0 || existing.length !== incoming.length) return false;

  const remaining = existing.map(normalizedItem);
  for (const incomingItem of incoming.map(normalizedItem)) {
    const matchIndex = remaining.findIndex(
      (candidate) => candidate.name === incomingItem.name && sameOptionalNumber(candidate.quantity, incomingItem.quantity) && sameOptionalNumber(candidate.price, incomingItem.price),
    );
    if (matchIndex < 0) return false;
    remaining.splice(matchIndex, 1);
  }

  return remaining.length === 0;
}

function withinWindow(left: Date, right: Date, windowHours: number) {
  return Math.abs(left.getTime() - right.getTime()) <= windowHours * 60 * 60 * 1000;
}

function sameMerchant(existing: ReconciliationPurchase, incoming: ExtractedPurchase) {
  const existingMerchant = normalizeMerchant(existing.compra_fonte);
  const incomingMerchant = normalizeMerchant(incoming.establishment);
  return Boolean(existingMerchant && incomingMerchant && existingMerchant === incomingMerchant);
}

function sameOrder(existing: ReconciliationPurchase, incoming: ExtractedPurchase) {
  const existingOrder = normalizeOrderNumber(existing.compra_pedido_externo_id);
  const incomingOrder = normalizeOrderNumber(incoming.orderNumber);
  return Boolean(existingOrder && incomingOrder && existingOrder === incomingOrder);
}

/**
 * Procura uma compra existente sem transformar heuristicas em identidade
 * financeira. Pedido e estabelecimento sao a evidencia principal; sem pedido,
 * a janela temporal evita fundir compras recorrentes identicas.
 */
export function findReconciliationMatch(candidates: ReconciliationPurchase[], userId: number, incoming: ExtractedPurchase, incomingDate: Date, windowHours: number): ReconciliationMatch | null {
  if (incoming.orderNumber && incoming.establishment) {
    const orderMatches = candidates.filter((candidate) => candidate.usuario_id === userId && sameMerchant(candidate, incoming) && sameOrder(candidate, incoming));
    if (orderMatches.length === 1) return { purchase: orderMatches[0], reason: 'ORDER_NUMBER' };
    if (orderMatches.length > 1) return null;
  }

  if (!incoming.establishment || incoming.totalAmount === null) return null;

  const fallbackMatches = candidates.filter((candidate) => {
    if (candidate.usuario_id !== userId || candidate.compra_pedido_externo_id || !sameMerchant(candidate, incoming)) return false;
    if (amount(candidate.compra_valor) !== incoming.totalAmount) return false;
    if (!withinWindow(candidate.compra_horario, incomingDate, windowHours)) return false;
    if (candidate.tb_compra_item.length === 0 || incoming.items.length === 0) {
      return false;
    }

    return itemsMatch(candidate.tb_compra_item, incoming.items);
  });

  return fallbackMatches.length === 1 ? { purchase: fallbackMatches[0], reason: 'FALLBACK' } : null;
}

export function buildPurchaseUpdate(existing: ReconciliationPurchase, incoming: ExtractedPurchase, paymentMethodId: number | null) {
  const data: {
    compra_pedido_externo_id?: string;
    compra_fonte?: string;
    compra_valor?: number;
    forma_pagamento_id?: number;
  } = {};

  if (!existing.compra_pedido_externo_id && incoming.orderNumber) data.compra_pedido_externo_id = incoming.orderNumber;
  if (!existing.compra_fonte && incoming.establishment) data.compra_fonte = incoming.establishment;
  if (existing.compra_valor === null && incoming.totalAmount !== null) data.compra_valor = incoming.totalAmount;
  if (existing.forma_pagamento_id === null && paymentMethodId !== null) data.forma_pagamento_id = paymentMethodId;

  return data;
}
