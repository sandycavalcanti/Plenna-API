import { Prisma } from '@prisma/client';
import type { ExtractedPurchaseItem } from './email-contracts.js';

export type PurchaseItemCategoryRepository = {
  tb_categoria: {
    findMany(args: {
      where: { categoria_nome: { equals: string; mode: 'insensitive' } };
      select: { categoria_id: true };
    }): Promise<Array<{ categoria_id: number }>>;
  };
};

export type PersistedPurchaseItem = {
  categoria_id: number | null;
  compra_item_nome: string;
  compra_item_valor: Prisma.Decimal;
  compra_item_quantidade: number | null;
};

/**
 * Converte um item extraido em dados aceitos por tb_compra_item.
 * O valor persistido e sempre o unitPrice; totalPrice nao substitui o preco
 * unitario porque possui semantica diferente quando ha quantidade.
 */
export async function buildPersistedPurchaseItems(
  items: ExtractedPurchaseItem[],
  repository: PurchaseItemCategoryRepository,
): Promise<PersistedPurchaseItem[]> {
  const persisted: PersistedPurchaseItem[] = [];

  for (const item of items) {
    const name = item.name?.trim();
    const unitPrice = item.unitPrice;
    if (!name || unitPrice === null || !Number.isFinite(unitPrice) || unitPrice <= 0) continue;

    let categoriaId: number | null = null;
    const categoryName = item.categoryName?.trim();
    if (categoryName) {
      const categories = await repository.tb_categoria.findMany({
        where: { categoria_nome: { equals: categoryName, mode: 'insensitive' } },
        select: { categoria_id: true },
      });
      // Mais de um resultado torna a categoria ambigua; o item continua
      // valido, mas sem FK inventada ou escolhida arbitrariamente.
      if (categories.length === 1) categoriaId = categories[0].categoria_id;
    }

    const quantity = item.quantity !== null && Number.isInteger(item.quantity) && item.quantity > 0
      ? item.quantity
      : null;

    persisted.push({
      categoria_id: categoriaId,
      // O campo legado possui limite de 45 caracteres; truncar de forma
      // deterministica evita que um email invalido interrompa a sincronizacao.
      compra_item_nome: name.slice(0, 45),
      compra_item_valor: new Prisma.Decimal(unitPrice.toFixed(2)),
      compra_item_quantidade: quantity,
    });
  }

  return persisted;
}

export function buildNestedPurchaseItems(items: PersistedPurchaseItem[]) {
  return items.map((item) => ({
    categoria_id: item.categoria_id,
    compra_item_nome: item.compra_item_nome,
    compra_item_valor: item.compra_item_valor,
    compra_item_quantidade: item.compra_item_quantidade,
  }));
}

/**
 * Impede que um email reconciliado substitua ou duplique os itens ja
 * persistidos. A primeira carga e a unica oportunidade automatica de inserir.
 */
export function shouldPersistPurchaseItems(existingItemCount: number, items: PersistedPurchaseItem[]) {
  return existingItemCount === 0 && items.length > 0;
}

export type PurchaseItemWriteRepository = {
  tb_compra_item: {
    createMany(args: { data: Array<PersistedPurchaseItem & { compra_id: number }> }): Promise<unknown>;
  };
};

/** Persiste itens somente quando o chamador ja decidiu que a compra nao possui itens. */
export async function persistPurchaseItems(
  compraId: number,
  items: PersistedPurchaseItem[],
  repository: PurchaseItemWriteRepository,
) {
  if (items.length === 0) return false;

  await repository.tb_compra_item.createMany({
    data: items.map((item) => ({ ...item, compra_id: compraId })),
  });
  return true;
}
