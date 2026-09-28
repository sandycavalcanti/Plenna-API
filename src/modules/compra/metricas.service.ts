import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';

function getMonthBounds(referenceDate: Date) {
  const start = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + 1, 1));

  return { start, end };
}

function toCents(value: Prisma.Decimal | number | string) {
  return Math.round(Number(value) * 100);
}

function fromCents(cents: number) {
  return new Prisma.Decimal((cents / 100).toFixed(2));
}

export class MetricasService {
  static async recalculateMonthlyMetrics(
    userId: number,
    referenceDate: Date,
    db: Pick<Prisma.TransactionClient, 'tb_usuario' | 'tb_compra' | 'tb_metricas'> = prisma,
  ) {
    const { start, end } = getMonthBounds(referenceDate);

    const [user, purchases, existingMetric] = await Promise.all([
      db.tb_usuario.findFirst({
        where: {
          usuario_id: userId,
          usuario_status: true,
        },
        select: {
          usuario_meta_valor_mensal: true,
        },
      }),
      db.tb_compra.findMany({
        where: {
          usuario_id: userId,
          compra_status: 'CONFIRMADA',
          compra_horario: {
            gte: start,
            lt: end,
          },
        },
        select: {
          compra_valor: true,
        },
      }),
      db.tb_metricas.findFirst({
        where: {
          usuario_id: userId,
          metricas_periodo_referencia: start,
        },
      }),
    ]);

    if (!user) {
      throw new AppError('Usuário não encontrado', 404);
    }

    const knownValues = purchases.flatMap((purchase) => purchase.compra_valor === null ? [] : [purchase.compra_valor]);
    const ignoredCount = purchases.length - knownValues.length;
    if (ignoredCount > 0) {
      console.info('metricas_dados_insuficientes', { quantidade: ignoredCount });
    }
    if (knownValues.length === 0) {
      // Não sobrescreve nem devolve uma métrica antiga como se fosse atual.
      // A validade de métricas antigas precisa de uma evolução posterior do modelo.
      console.info('metricas_nao_recalculadas', { motivo: 'nenhum_valor_conhecido' });
      return null;
    }

    const totalCents = knownValues.reduce((sum, value) => sum + toCents(value), 0);
    const frequency = knownValues.length;
    const averagePurchaseCents = Math.round(totalCents / frequency);
    const monthlyLimitCents = user.usuario_meta_valor_mensal ? toCents(user.usuario_meta_valor_mensal) : null;
    const aboveLimitCountRaw =
      monthlyLimitCents === null
        ? 0
        : knownValues.reduce((count, value) => {
            return count + (toCents(value) > monthlyLimitCents ? 1 : 0);
          }, 0);
    const aboveLimitCountNum = Number(aboveLimitCountRaw);
    const aboveLimitCount = Number.isFinite(aboveLimitCountNum) ? Math.max(0, Math.floor(aboveLimitCountNum)) : 0;

    const frequencyNum = Number(frequency);

    const commonData = {
      metricas_media_gasto: fromCents(totalCents),
      metricas_media_valor_compra: fromCents(averagePurchaseCents),
      metricas_frequencia_compra: Number.isFinite(frequencyNum) ? Math.max(0, Math.floor(frequencyNum)) : 0,
      metricas_media_tempo: existingMetric?.metricas_media_tempo ?? new Prisma.Decimal(0),
      metricas_acima_limite: aboveLimitCount > 0,
      metricas_periodo_referencia: start,
    };

    if (existingMetric) {
      return db.tb_metricas.update({
        where: {
          metricas_id: existingMetric.metricas_id,
        },
        data: commonData,
      });
    }

    return db.tb_metricas.create({
      data: {
        usuario_id: userId,
        ...commonData,
      },
    });
  }
}

export { getMonthBounds };
