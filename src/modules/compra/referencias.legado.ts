import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { referenciasDisponiveis } from './referencias.service.js';
import { AppError } from '../../errors/AppError.js';
/** Observe actual changes from this deployment forward; never create a retrospective baseline. */
export async function capturarReferencias(
  tx: Prisma.TransactionClient,
  userId: number,
  changes: {
    tipo: string;
    categoriaId?: number;
    valor: Prisma.Decimal | number | null;
    aplicacao?: string;
  }[],
) {
  if (!changes.length) return;
  if (!tx.tb_referencia_financeira || !(await referenciasDisponiveis(tx))) {
    if (changes.some((c) => c.aplicacao))
      throw new AppError(
        'O histórico de limites ainda não está disponível neste ambiente',
        503,
      );
    return;
  }
  for (const c of changes) {
    const now = new Date(),
      periodo =
        c.tipo === 'ORCAMENTO_MENSAL' ? now.toISOString().slice(0, 7) : null;
    if (c.aplicacao) {
      const last = await tx.tb_referencia_financeira.findFirst({
        where: {
          usuario_id: userId,
          tipo: c.tipo,
          categoria_id: c.categoriaId ?? null,
        },
        orderBy: [{ vigente_desde: 'desc' }, { referencia_id: 'desc' }],
      });
      if (
        last &&
        last.aplicacao === c.aplicacao &&
        last.periodo === periodo &&
        String(last.valor) === String(c.valor)
      )
        continue;
    }
    await tx.tb_referencia_financeira.create({
      data: {
        usuario_id: userId,
        categoria_id: c.categoriaId ?? null,
        tipo: c.tipo,
        valor: c.valor,
        vigente_desde: now,
        periodo,
        aplicacao:
          c.aplicacao ??
          (c.tipo === 'ORCAMENTO_MENSAL' ? 'REFERENCIA_ATUAL' : 'AGORA'),
        origem: c.aplicacao ? 'DECLARADO' : 'ALTERACAO_LEGADA',
        operacao_id: randomUUID(),
      },
    });
  }
}
