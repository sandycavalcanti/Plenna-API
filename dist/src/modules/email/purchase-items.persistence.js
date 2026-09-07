import { Prisma } from '@prisma/client';
/**
 * Converte um item extraido em dados aceitos por tb_compra_item.
 * O valor persistido e sempre o unitPrice; totalPrice nao substitui o preco
 * unitario porque possui semantica diferente quando ha quantidade.
 */
export async function buildPersistedPurchaseItems(items, repository) {
    const persisted = [];
    for (const item of items) {
        const name = item.name?.trim();
        const unitPrice = item.unitPrice;
        if (!name || unitPrice === null || !Number.isFinite(unitPrice) || unitPrice <= 0)
            continue;
        let categoriaId = null;
        const categoryName = item.categoryName?.trim();
        if (categoryName) {
            const categories = await repository.tb_categoria.findMany({
                where: { categoria_nome: { equals: categoryName, mode: 'insensitive' } },
                select: { categoria_id: true },
            });
            // Mais de um resultado torna a categoria ambigua; o item continua
            // valido, mas sem FK inventada ou escolhida arbitrariamente.
            if (categories.length === 1)
                categoriaId = categories[0].categoria_id;
        }
        // Quantidades fiscais podem ser fracionarias; somente ausencia, NaN ou
        // valor nao positivo invalida a quantidade, sem transforma-la em inteiro.
        const quantity = item.quantity !== null && Number.isFinite(item.quantity) && item.quantity > 0
            ? new Prisma.Decimal(item.quantity.toString())
            : null;
        const unit = item.unit?.trim() ? item.unit.trim().slice(0, 10) : null;
        persisted.push({
            categoria_id: categoriaId,
            // O campo legado possui limite de 45 caracteres; truncar de forma
            // deterministica evita que um email invalido interrompa a sincronizacao.
            compra_item_nome: name.slice(0, 45),
            compra_item_valor: new Prisma.Decimal(unitPrice.toFixed(2)),
            compra_item_quantidade: quantity,
            compra_item_unidade_medida: unit,
        });
    }
    return persisted;
}
export function buildNestedPurchaseItems(items) {
    return items.map((item) => ({
        categoria_id: item.categoria_id,
        compra_item_nome: item.compra_item_nome,
        compra_item_valor: item.compra_item_valor,
        compra_item_quantidade: item.compra_item_quantidade,
        compra_item_unidade_medida: item.compra_item_unidade_medida,
    }));
}
/**
 * Impede que um email reconciliado substitua ou duplique os itens ja
 * persistidos. A primeira carga e a unica oportunidade automatica de inserir.
 */
export function shouldPersistPurchaseItems(existingItemCount, items) {
    return existingItemCount === 0 && items.length > 0;
}
/** Persiste itens somente quando o chamador ja decidiu que a compra nao possui itens. */
export async function persistPurchaseItems(compraId, items, repository) {
    if (items.length === 0)
        return false;
    await repository.tb_compra_item.createMany({
        data: items.map((item) => ({ ...item, compra_id: compraId })),
    });
    return true;
}
