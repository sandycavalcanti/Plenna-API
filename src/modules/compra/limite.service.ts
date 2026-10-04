import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { NotificationService } from '../notification/notification.service.js';
import { getMonthBounds } from './metricas.service.js';

type LimitDatabase = Pick<
  Prisma.TransactionClient,
  'tb_usuario' | 'tb_compra' | 'tb_preferencia' | 'tb_notificacao' | '$queryRaw'
>;

type LimitType = 'LIMITE_COMPRA' | 'LIMITE_CATEGORIA' | 'LIMITE_MENSAL';

type CategoryTotal = {
  categoriaId: number;
  categoriaNome: string;
  totalCents: number;
};

export function toCents(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  return Math.round(numberValue * 100);
}

function itemTotalCents(value: Prisma.Decimal | number | string, quantity: Prisma.Decimal | number | string | null) {
  const valueCents = toCents(value);
  if (valueCents === null) return null;

  const effectiveQuantity = quantity === null ? 1 : Number(quantity);
  if (!Number.isFinite(effectiveQuantity) || effectiveQuantity <= 0) return null;

  return Math.round(valueCents * effectiveQuantity);
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export function isConfiguredLimit(cents: number | null): cents is number {
  return cents !== null && cents >= 0;
}

export function calculatePurchaseAboveLimit(
  purchaseValue: Prisma.Decimal | number | string | null | undefined,
  configuredLimit: Prisma.Decimal | number | string | null | undefined,
) {
  const purchaseCents = toCents(purchaseValue);
  const limitCents = toCents(configuredLimit);

  if (purchaseCents === null || !isConfiguredLimit(limitCents)) return null;
  return purchaseCents > limitCents;
}

function notificationTitle(type: LimitType) {
  if (type === 'LIMITE_COMPRA') return 'Alerta de limite por compra';
  if (type === 'LIMITE_CATEGORIA') return 'Alerta de limite por categoria';
  return 'Alerta de limite mensal';
}

function purchaseMessage(purchaseCents: number, limitCents: number) {
  return `Esta compra de ${formatMoney(purchaseCents)} ultrapassou o limite planejado de ${formatMoney(limitCents)} para uma única compra.`;
}

function categoryMessage(category: CategoryTotal, limitCents: number, monthlyExceeded: boolean) {
  const context = monthlyExceeded
    ? 'O limite mensal geral também foi ultrapassado.'
    : 'O orçamento mensal geral ainda está dentro do planejado.';
  return `Os gastos de ${category.categoriaNome} chegaram a ${formatMoney(category.totalCents)} e ultrapassaram o limite mensal de ${formatMoney(limitCents)} para a categoria. ${context}`;
}

function monthlyMessage(totalCents: number, limitCents: number) {
  return `Os gastos confirmados do mês chegaram a ${formatMoney(totalCents)} e ultrapassaram o limite mensal geral de ${formatMoney(limitCents)}.`;
}

async function persistAlert(
  db: LimitDatabase,
  userId: number,
  purchaseId: number,
  type: LimitType,
  message: string,
  categoryId?: number,
) {
  const idempotencyKey = categoryId === undefined
    ? `${userId}:${purchaseId}:${type}`
    : `${userId}:${purchaseId}:${type}:${categoryId}`;

  const result = await NotificationService.createNotification({
    userId,
    type,
    title: notificationTitle(type),
    message,
    idempotencyKey,
    purchaseId,
    categoryId: categoryId ?? null,
    event: null,
  }, db);

  return {
    type,
    categoryId: categoryId ?? null,
    idempotencyKey,
    created: result.created,
    notificationId: result.notification.notificacao_id,
  };
}

export async function evaluateConfirmedPurchaseLimits(
  purchaseId: number,
  db: LimitDatabase = prisma,
) {
  const purchase = await db.tb_compra.findFirst({
    where: {
      compra_id: purchaseId,
      compra_ativo: 1,
      compra_status: 'CONFIRMADA',
    },
    select: {
      compra_id: true,
      usuario_id: true,
      compra_valor: true,
      compra_horario: true,
      compra_acima_limite: true,
      tb_usuario: {
        select: {
          usuario_meta_valor_compra: true,
          usuario_meta_valor_mensal: true,
        },
      },
      tb_compra_item: {
        where: { compra_item_ativo: 1 },
        select: {
          categoria_id: true,
          compra_item_valor: true,
          compra_item_quantidade: true,
          tb_categoria: { select: { categoria_nome: true } },
        },
      },
    },
  });

  if (!purchase) {
    return {
      eligible: false as const,
      reason: 'NOT_ACTIVE_CONFIRMED' as const,
      alerts: [],
    };
  }

  const purchaseCents = toCents(purchase.compra_valor);
  const purchaseLimitCents = toCents(purchase.tb_usuario.usuario_meta_valor_compra);
  const purchaseAboveLimit = calculatePurchaseAboveLimit(
    purchase.compra_valor,
    purchase.tb_usuario.usuario_meta_valor_compra,
  );

  if (purchase.compra_acima_limite !== purchaseAboveLimit) {
    await db.tb_compra.update({
      where: { compra_id: purchase.compra_id },
      data: { compra_acima_limite: purchaseAboveLimit },
    });
  }

  const categoryTotals = new Map<number, CategoryTotal>();
  for (const item of purchase.tb_compra_item) {
    if (item.categoria_id === null) continue;
    const lineTotalCents = itemTotalCents(item.compra_item_valor, item.compra_item_quantidade);
    if (lineTotalCents === null) continue;

    const current = categoryTotals.get(item.categoria_id);
    categoryTotals.set(item.categoria_id, {
      categoriaId: item.categoria_id,
      categoriaNome: item.tb_categoria?.categoria_nome ?? 'esta categoria',
      totalCents: (current?.totalCents ?? 0) + lineTotalCents,
    });
  }

  const categoryIds = [...categoryTotals.keys()];
  const { start, end } = getMonthBounds(purchase.compra_horario);
  const [monthlyPurchases, preferences] = await Promise.all([
    db.tb_compra.findMany({
      where: {
        usuario_id: purchase.usuario_id,
        compra_ativo: 1,
        compra_status: 'CONFIRMADA',
        compra_horario: { gte: start, lt: end },
      },
      select: {
        compra_valor: true,
        tb_compra_item: {
          where: {
            compra_item_ativo: 1,
            ...(categoryIds.length > 0 ? { categoria_id: { in: categoryIds } } : {}),
          },
          select: {
            categoria_id: true,
            compra_item_valor: true,
            compra_item_quantidade: true,
          },
        },
      },
    }),
    categoryIds.length === 0
      ? Promise.resolve([])
      : db.tb_preferencia.findMany({
          where: {
            usuario_id: purchase.usuario_id,
            categoria_id: { in: categoryIds },
          },
          select: {
            categoria_id: true,
            preferencia_meta: true,
          },
        }),
  ]);

  const monthlyCategoryTotals = new Map<number, number>();
  for (const monthlyPurchase of monthlyPurchases) {
    for (const item of monthlyPurchase.tb_compra_item) {
      if (item.categoria_id === null) continue;
      const lineTotalCents = itemTotalCents(item.compra_item_valor, item.compra_item_quantidade);
      if (lineTotalCents === null) continue;
      monthlyCategoryTotals.set(
        item.categoria_id,
        (monthlyCategoryTotals.get(item.categoria_id) ?? 0) + lineTotalCents,
      );
    }
  }

  const preferenceByCategory = new Map<number, number>();
  for (const preference of preferences) {
    const limitCents = toCents(preference.preferencia_meta);
    if (isConfiguredLimit(limitCents) && !preferenceByCategory.has(preference.categoria_id)) {
      preferenceByCategory.set(preference.categoria_id, limitCents);
    }
  }

  const monthlyValues = monthlyPurchases
    .map((monthlyPurchase) => toCents(monthlyPurchase.compra_valor))
    .filter((value): value is number => value !== null);
  const monthlyTotalCents = monthlyValues.reduce((sum, value) => sum + value, 0);
  const monthlyLimitCents = toCents(purchase.tb_usuario.usuario_meta_valor_mensal);
  const monthlyExceeded = isConfiguredLimit(monthlyLimitCents)
    ? monthlyTotalCents > monthlyLimitCents
    : false;

  const alerts = [];
  if (purchaseAboveLimit === true && purchaseCents !== null && purchaseLimitCents !== null) {
    alerts.push(await persistAlert(
      db,
      purchase.usuario_id,
      purchase.compra_id,
      'LIMITE_COMPRA',
      purchaseMessage(purchaseCents, purchaseLimitCents),
    ));
  }

  for (const category of categoryTotals.values()) {
    const limitCents = preferenceByCategory.get(category.categoriaId);
    const monthlyCategoryTotal = monthlyCategoryTotals.get(category.categoriaId) ?? 0;
    if (limitCents === undefined || monthlyCategoryTotal <= limitCents) continue;

    alerts.push(await persistAlert(
      db,
      purchase.usuario_id,
      purchase.compra_id,
      'LIMITE_CATEGORIA',
      categoryMessage({ ...category, totalCents: monthlyCategoryTotal }, limitCents, monthlyExceeded),
      category.categoriaId,
    ));
  }

  if (monthlyExceeded && monthlyLimitCents !== null) {
    alerts.push(await persistAlert(
      db,
      purchase.usuario_id,
      purchase.compra_id,
      'LIMITE_MENSAL',
      monthlyMessage(monthlyTotalCents, monthlyLimitCents),
    ));
  }

  return {
    eligible: true as const,
    purchaseId: purchase.compra_id,
    userId: purchase.usuario_id,
    purchaseAboveLimit,
    monthlyTotalCents,
    monthlyLimitCents,
    monthlyExceeded,
    categoryTotals: [...categoryTotals.values()].map((category) => ({
      ...category,
      monthlyTotalCents: monthlyCategoryTotals.get(category.categoriaId) ?? 0,
      limitCents: preferenceByCategory.get(category.categoriaId) ?? null,
    })),
    alerts,
  };
}

export { itemTotalCents };
