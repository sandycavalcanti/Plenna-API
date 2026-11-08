import type { Prisma } from '@prisma/client';
/** Desabilitar o v2 não pode ignorar exclusões nem a proteção de dados já migrados. */
export async function hasUsageStorage(tx: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  return (await usageStorageKind(tx)) !== null;
}
export async function usageStorageKind(tx: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  const rows = await tx.$queryRaw<{
    current?: string | null;
    relation: string | null;
  }[]>`SELECT to_regclass('public.tb_monitoramento_instalacao')::text AS current,to_regclass('public.rf017_authorization')::text AS relation`;
  return rows[0]?.current ? 'current' as const : rows[0]?.relation ? 'prototype' as const : null;
}
