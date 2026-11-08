/** Desabilitar o v2 não pode ignorar exclusões nem a proteção de dados já migrados. */
export async function hasUsageStorage(tx) {
    return (await usageStorageKind(tx)) !== null;
}
export async function usageStorageKind(tx) {
    const rows = await tx.$queryRaw `SELECT to_regclass('public.tb_monitoramento_instalacao')::text AS current,to_regclass('public.rf017_authorization')::text AS relation`;
    return rows[0]?.current ? 'current' : rows[0]?.relation ? 'prototype' : null;
}
