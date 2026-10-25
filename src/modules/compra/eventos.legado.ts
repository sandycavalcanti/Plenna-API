import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { eventosVigentes } from './eventos.engine.js';
import { AppError } from '../../errors/AppError.js';
export async function validarSaldoAposEdicao(
  tx: Prisma.TransactionClient,
  userId: number,
  compraId: number,
  valorCentavos: number | null,
  itemId?: number,
) {
  if (!tx.tb_compra_evento) return;
  const tables = await tx.$queryRaw<
    { tabela: string | null }[]
  >`SELECT to_regclass('public.tb_compra_evento')::text AS tabela`;
  if (!tables[0]?.tabela) return;
  const rows = eventosVigentes(
    await tx.tb_compra_evento.findMany({
      where: { compra_id: compraId, usuario_id: userId },
    }),
  );
  if (
    itemId &&
    rows.some(
      (e) =>
        e.compra_item_id === itemId &&
        ['REEMBOLSO', 'CANCELAMENTO', 'DEVOLUCAO'].includes(e.tipo),
    )
  )
    throw new AppError(
      'Corrija os eventos deste item antes de excluir seu registro',
      409,
    );
  const refunded = rows
    .filter((e) => e.tipo === 'REEMBOLSO')
    .reduce(
      (n, e) =>
        n + Number((e.dados as { valorCentavos: number }).valorCentavos),
      0,
    );
  if (refunded > 0 && (valorCentavos === null || valorCentavos < refunded))
    throw new AppError(
      'O novo valor não pode ser menor que os reembolsos registrados',
      409,
    );
}
export async function auditarEventoLegado(
  tx: Prisma.TransactionClient,
  userId: number,
  compraId: number,
  tipo: string,
  dados: Prisma.InputJsonObject,
  itemId: number | null = null,
) {
  if (!tx.tb_compra_evento) return;
  const tables = await tx.$queryRaw<
    { tabela: string | null }[]
  >`SELECT to_regclass('public.tb_compra_evento')::text AS tabela`;
  if (!tables[0]?.tabela) return;
  const last = await tx.tb_compra_evento.findFirst({
    where: { compra_id: compraId, usuario_id: userId },
    orderBy: { revisao: 'desc' },
  });
  await tx.tb_compra_evento.create({
    data: {
      compra_id: compraId,
      usuario_id: userId,
      compra_item_id: itemId,
      tipo,
      dados,
      revisao: (last?.revisao ?? 0) + 1,
      operacao_id: randomUUID(),
      requisicao_hash: createHash('sha256')
        .update(JSON.stringify(dados))
        .digest('hex'),
      origem: 'ROTA_LEGADA',
    },
  });
}
