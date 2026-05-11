import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

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
  static async recalculateMonthlyMetrics(userId: number, referenceDate: Date, db: any = prisma) {
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
      throw new Error('Usuário não encontrado');
    }

    const totalCents = purchases.reduce((sum: number, purchase: { compra_valor: Prisma.Decimal | number | string }) => {
      return sum + toCents(purchase.compra_valor);
    }, 0);
    const frequency = purchases.length;
    const averagePurchaseCents = frequency > 0 ? Math.round(totalCents / frequency) : 0;
    const monthlyLimitCents = user.usuario_meta_valor_mensal ? toCents(user.usuario_meta_valor_mensal) : null;
    const aboveLimitCountRaw =
      monthlyLimitCents === null
        ? 0
        : purchases.reduce((count: number, purchase: { compra_valor: Prisma.Decimal | number | string }) => {
            return count + (toCents(purchase.compra_valor) > monthlyLimitCents ? 1 : 0);
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
