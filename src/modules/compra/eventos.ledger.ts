import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { eventosVigentes } from './eventos.engine.js';
import { AppError } from '../../errors/AppError.js';

const classificationEvents = new Set([
  'IMPULSIVA',
  'NAO_IMPULSIVA',
  'PREFIRO_NAO_CLASSIFICAR',
]);

/**
 * Applies ledger rules to a purchase mutation made by an internal flow.
 * The event table is part of the deployed schema; availability checks would
 * only hide an incompatible deployment and create divergent purchase state.
 */
export async function validarSaldoAposEdicao(
  tx: Prisma.TransactionClient,
  userId: number,
  compraId: number,
  valorCentavos: number | null,
  itemId?: number,
) {
  const rows = eventosVigentes(
    await tx.tb_compra_evento.findMany({
      where: { compra_id: compraId, usuario_id: userId },
    }),
  );

  if (
    itemId &&
    rows.some(
      (event) =>
        event.compra_item_id === itemId &&
        ['REEMBOLSO', 'CANCELAMENTO', 'DEVOLUCAO'].includes(event.tipo),
    )
  ) {
    throw new AppError(
      'Corrija os eventos deste item antes de excluir seu registro',
      409,
    );
  }

  const refunded = rows
    .filter((event) => event.tipo === 'REEMBOLSO')
    .reduce(
      (total, event) =>
        total + Number((event.dados as { valorCentavos: number }).valorCentavos),
      0,
    );

  if (refunded > 0 && (valorCentavos === null || valorCentavos < refunded)) {
    throw new AppError(
      'O novo valor não pode ser menor que os reembolsos registrados',
      409,
    );
  }
}

/** Records a system-originated event while holding the purchase lock. */
export async function registrarEventoInterno(
  tx: Prisma.TransactionClient,
  userId: number,
  compraId: number,
  tipo: string,
  dados: Prisma.InputJsonObject,
  itemId: number | null = null,
) {
  await tx.$queryRaw`
    SELECT compra_id
    FROM public.tb_compra
    WHERE compra_id = ${compraId} AND usuario_id = ${userId}
    FOR UPDATE
  `;

  const last = await tx.tb_compra_evento.findFirst({
    where: { compra_id: compraId, usuario_id: userId },
    orderBy: { revisao: 'desc' },
    select: { revisao: true },
  });
  const operationId = randomUUID();

  return tx.tb_compra_evento.create({
    data: {
      compra_id: compraId,
      usuario_id: userId,
      compra_item_id: itemId,
      tipo,
      dados,
      revisao: (last?.revisao ?? 0) + 1,
      operacao_id: operationId,
      requisicao_hash: createHash('sha256')
        .update(JSON.stringify({ operationId, tipo, dados, itemId }))
        .digest('hex'),
      origem: 'SISTEMA',
    },
  });
}

/** Keeps the materialized classification and its audit trail in one flow. */
export async function registrarClassificacao(
  tx: Prisma.TransactionClient,
  userId: number,
  compraId: number,
  classificacao: string | null | undefined,
  permitirPendente = false,
) {
  if (!classificacao || (classificacao === 'PENDENTE' && !permitirPendente)) {
    return;
  }

  const evento = classificacao === 'PENDENTE'
    ? 'PREFIRO_NAO_CLASSIFICAR'
    : classificacao;
  if (!classificationEvents.has(evento)) return;

  await registrarEventoInterno(tx, userId, compraId, 'CLASSIFICACAO', {
    classificacao: evento,
  });
}
