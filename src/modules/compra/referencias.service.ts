import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { businessDayBounds, businessPeriod, cents } from './financeiro.js';
export const referenciaSchema = z
  .object({
    versaoContrato: z.literal(1),
    operacaoId: z.string().uuid(),
    tipo: z.enum(['LIMITE_COMPRA', 'ORCAMENTO_MENSAL', 'CATEGORIA']),
    categoriaId: z.number().int().positive().optional(),
    valorCentavos: z.number().int().positive().max(9999999999),
    aplicacao: z.enum(['AGORA', 'MES_INTEIRO']),
    periodo: z
      .string()
      .regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/)
      .optional(),
  })
  .strict();
/** Records a new financial reference for changes made by profile flows. */
export async function registrarAlteracoesReferencia(
  tx: Prisma.TransactionClient,
  userId: number,
  changes: {
    tipo: string;
    categoriaId?: number;
    valor: Prisma.Decimal | number | null;
    aplicacao?: string;
  }[],
) {
  for (const change of changes) {
    const now = new Date();
    const periodo = change.tipo === 'ORCAMENTO_MENSAL'
      ? businessPeriod(now)
      : null;
    const last = await tx.tb_referencia_financeira.findFirst({
      where: {
        usuario_id: userId,
        tipo: change.tipo,
        categoria_id: change.categoriaId ?? null,
      },
      orderBy: [{ vigente_desde: 'desc' }, { referencia_id: 'desc' }],
    });

    if (
      last &&
      last.aplicacao === (change.aplicacao ?? (change.tipo === 'ORCAMENTO_MENSAL' ? 'REFERENCIA_ATUAL' : 'AGORA')) &&
      last.periodo === periodo &&
      String(last.valor) === String(change.valor)
    ) {
      continue;
    }

    await tx.tb_referencia_financeira.create({
      data: {
        usuario_id: userId,
        categoria_id: change.categoriaId ?? null,
        tipo: change.tipo,
        valor: change.valor,
        vigente_desde: now,
        periodo,
        aplicacao: change.aplicacao ?? (change.tipo === 'ORCAMENTO_MENSAL' ? 'REFERENCIA_ATUAL' : 'AGORA'),
        origem: change.aplicacao ? 'DECLARADO' : 'ALTERACAO_PERFIL',
        operacao_id: randomUUID(),
      },
    });
  }
}
export function referenciaNaData(
  rows: {
    tipo: string;
    categoria_id: number | null;
    valor: unknown;
    vigente_desde: Date;
    aplicacao: string;
    periodo: string | null;
  }[],
  tipo: string,
  data: Date,
  categoriaId: number | null = null,
) {
  const { start, end } = businessDayBounds(data);
  const startTime = start.getTime();
  const endTime = end.getTime();
  const candidates = rows.filter(
    (r) =>
      r.tipo === tipo &&
      r.categoria_id === categoriaId &&
      r.aplicacao === 'AGORA',
  );
  // Legacy purchase timestamps prove a day, not order within that day.
  if (
    candidates.some(
      (r) =>
        r.vigente_desde.getTime() >= startTime && r.vigente_desde.getTime() < endTime,
    )
  )
    return null;
  return (
    candidates
      .filter((r) => r.vigente_desde.getTime() < startTime)
      .sort(
        (a, b) => b.vigente_desde.getTime() - a.vigente_desde.getTime(),
      )[0] ?? null
  );
}
export class ReferenciasService {
  static async registrar(userId: number, raw: unknown, now = new Date()) {
    const data = referenciaSchema.parse(raw);
    if (
      data.tipo === 'ORCAMENTO_MENSAL' &&
      (data.aplicacao !== 'MES_INTEIRO' ||
        data.periodo !== businessPeriod(now))
    )
      throw new AppError(
        'Escolha o mês atual inteiro para esta referência mensal',
        422,
      );
    if (
      data.tipo !== 'ORCAMENTO_MENSAL' &&
      (data.aplicacao !== 'AGORA' || data.periodo !== undefined)
    )
      throw new AppError(
        'Este limite entra em vigor agora, sem aplicação retroativa',
        422,
      );
    if ((data.tipo === 'CATEGORIA') !== !!data.categoriaId)
      throw new AppError('Confira a categoria do limite', 400);
    return prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<
        { usuario_id: number }[]
      >`SELECT usuario_id FROM public.tb_usuario WHERE usuario_id=${userId} AND usuario_status=true FOR UPDATE`;
      if (!users.length) throw new AppError('Usuário não encontrado', 404);
      const existing = await tx.tb_referencia_financeira.findUnique({
        where: {
          usuario_id_operacao_id: {
            usuario_id: userId,
            operacao_id: data.operacaoId,
          },
        },
      });
      if (existing) {
        if (
          existing.tipo !== data.tipo ||
          existing.categoria_id !== (data.categoriaId ?? null) ||
          cents(existing.valor!) !== data.valorCentavos ||
          existing.aplicacao !== data.aplicacao ||
          existing.periodo !== (data.periodo ?? null)
        )
          throw new AppError('Operação já utilizada com outros dados', 409);
        return {
          versaoContrato: 1,
          persistido: true,
          id: existing.referencia_id,
        };
      }
      const valor = new Prisma.Decimal(data.valorCentavos).div(100);
      if (data.tipo === 'CATEGORIA') {
        const category = await tx.tb_categoria.findUnique({
          where: { categoria_id: data.categoriaId! },
        });
        if (!category) throw new AppError('Categoria não encontrada', 404);
        const prefs = await tx.tb_preferencia.findMany({
          where: { usuario_id: userId, categoria_id: data.categoriaId! },
        });
        if (prefs.length > 1)
          throw new AppError(
            'Preferências duplicadas precisam de revisão',
            409,
          );
        if (prefs[0])
          await tx.tb_preferencia.update({
            where: { preferencia_id: prefs[0].preferencia_id },
            data: { preferencia_meta: valor },
          });
        else
          await tx.tb_preferencia.create({
            data: {
              usuario_id: userId,
              categoria_id: data.categoriaId!,
              preferencia_meta: valor,
            },
          });
      } else
        await tx.tb_usuario.update({
          where: { usuario_id: userId },
          data:
            data.tipo === 'LIMITE_COMPRA'
              ? { usuario_meta_valor_compra: valor }
              : { usuario_meta_valor_mensal: valor },
        });
      const ref = await tx.tb_referencia_financeira.create({
        data: {
          usuario_id: userId,
          categoria_id: data.categoriaId ?? null,
          tipo: data.tipo,
          valor,
          vigente_desde: now,
          periodo: data.periodo ?? null,
          aplicacao: data.aplicacao,
          origem: 'DECLARADO',
          operacao_id: data.operacaoId,
        },
      });
      return { versaoContrato: 1, persistido: true, id: ref.referencia_id };
    });
  }
  static async consultar(userId: number, compraId: number) {
    return prisma.$transaction(
      async (tx) => {
        const compra = await tx.tb_compra.findFirst({
          where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
          select: {
            compra_valor: true,
            compra_horario: true,
            tb_usuario: { select: { usuario_meta_valor_compra: true } },
          },
        });
        if (!compra) throw new AppError('Compra não encontrada', 404);
        const rows = await tx.tb_referencia_financeira.findMany({
          where: { usuario_id: userId, tipo: 'LIMITE_COMPRA' },
          orderBy: [{ vigente_desde: 'desc' }, { referencia_id: 'desc' }],
        });
        let historical = referenciaNaData(
          rows,
          'LIMITE_COMPRA',
          compra.compra_horario,
        );
        // A legacy untracked change breaks evidence; never silently extrapolate a stale version.
        if (
          rows[0] &&
          String(rows[0].valor) !==
            String(compra.tb_usuario.usuario_meta_valor_compra)
        )
          historical = null;
        return {
          versaoContrato: 1,
          compraId,
          disponivel: true,
          compraCentavos:
            compra.compra_valor === null ? null : cents(compra.compra_valor),
          limiteAtualCentavos:
            compra.tb_usuario.usuario_meta_valor_compra === null
              ? null
              : cents(compra.tb_usuario.usuario_meta_valor_compra),
          limiteHistoricoCentavos:
            historical?.valor == null
              ? null
              : cents(historical.valor as Prisma.Decimal),
          precisao: 'DIA',
          historicoComprovado: historical !== null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
