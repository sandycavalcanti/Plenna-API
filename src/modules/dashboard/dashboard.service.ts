import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { GastoCategoriaDTO, GastoFormaPagamentoDTO, ImpulsividadeDTO, LimiteComprasDTO, TempoVsGastoDTO } from './dashboard.schemas.js';

function getMonthBounds(referenceDate: Date = new Date()) {
  const start = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + 1, 1));

  return { start, end };
}

function toNumber(value: Prisma.Decimal | number | null | undefined) {
  return Number(value ?? 0);
}

export class DashboardService {
  static async findGastosPorCategoria(userId: number): Promise<GastoCategoriaDTO[]> {
    const { start, end } = getMonthBounds();

    const items = await prisma.tb_compra_item.findMany({
      where: {
        tb_compra: {
          usuario_id: userId,
          compra_horario: {
            gte: start,
            lt: end,
          },
        },
      },
      select: {
        compra_item_valor: true,
        tb_categoria: {
          select: {
            categoria_nome: true,
          },
        },
      },
    });

    const totalsByCategory = new Map<string, number>();

    for (const item of items) {
      const categoriaNome = item.tb_categoria.categoria_nome;
      const totalAtual = totalsByCategory.get(categoriaNome) ?? 0;
      totalsByCategory.set(categoriaNome, totalAtual + toNumber(item.compra_item_valor));
    }

    return [...totalsByCategory.entries()].map(([categoria_nome, total]) => ({ categoria_nome, total })).sort((left, right) => right.total - left.total);
  }

  static async findGastosPorFormaPagamento(userId: number): Promise<GastoFormaPagamentoDTO[]> {
    const { start, end } = getMonthBounds();

    const compras = await prisma.tb_compra.findMany({
      where: {
        usuario_id: userId,
        compra_horario: {
          gte: start,
          lt: end,
        },
      },
      select: {
        compra_valor: true,
        tb_forma_pagamento: {
          select: {
            forma_pagamento_nome: true,
          },
        },
      },
    });

    const totalsByFormaPagamento = new Map<string, number>();

    for (const compra of compras) {
      const formaPagamentoNome = compra.tb_forma_pagamento.forma_pagamento_nome;
      const totalAtual = totalsByFormaPagamento.get(formaPagamentoNome) ?? 0;
      totalsByFormaPagamento.set(formaPagamentoNome, totalAtual + toNumber(compra.compra_valor));
    }

    return [...totalsByFormaPagamento.entries()].map(([forma_pagamento_nome, total]) => ({ forma_pagamento_nome, total })).sort((left, right) => right.total - left.total);
  }

  static async findImpulsividade(userId: number): Promise<ImpulsividadeDTO[]> {
    const { start, end } = getMonthBounds();

    const grupos = await prisma.tb_compra.groupBy({
      where: {
        usuario_id: userId,
        compra_horario: {
          gte: start,
          lt: end,
        },
      },
      by: ['compra_classificacao'],
      _count: {
        _all: true,
      },
      _sum: {
        compra_valor: true,
      },
    });

    return grupos.map((grupo) => ({
      compra_classificacao: grupo.compra_classificacao,
      quantidade: grupo._count._all,
      valor_total: toNumber(grupo._sum.compra_valor),
    }));
  }

  static async findComprasAcimaLimite(userId: number): Promise<LimiteComprasDTO> {
    const { start, end } = getMonthBounds();

    const grupos = await prisma.tb_compra.groupBy({
      where: {
        usuario_id: userId,
        compra_horario: {
          gte: start,
          lt: end,
        },
      },
      by: ['compra_acima_limite'],
      _count: {
        _all: true,
      },
    });

    const resultado: LimiteComprasDTO = {
      acima_limite: 0,
      dentro_limite: 0,
    };

    for (const grupo of grupos) {
      if (grupo.compra_acima_limite) {
        resultado.acima_limite = grupo._count._all;
      } else {
        resultado.dentro_limite = grupo._count._all;
      }
    }

    return resultado;
  }

  static async findTempoVsGasto(userId: number): Promise<TempoVsGastoDTO[]> {
    const { start, end } = getMonthBounds();

    const [temposUso, gastosPorApp] = await Promise.all([
      prisma.tb_tempo_uso.findMany({
        where: {
          usuario_id: userId,
          tempo_uso_data: {
            gte: start,
            lt: end,
          },
        },
        select: {
          tempo_uso_nome: true,
          tempo_uso_minutos: true,
        },
      }),
      prisma.tb_compra.groupBy({
        where: {
          usuario_id: userId,
          compra_horario: {
            gte: start,
            lt: end,
          },
        },
        by: ['compra_fonte'],
        _sum: {
          compra_valor: true,
        },
      }),
    ]);

    const tempoTotalPorApp = new Map<string, number>();

    for (const tempo of temposUso) {
      const totalAtual = tempoTotalPorApp.get(tempo.tempo_uso_nome) ?? 0;
      tempoTotalPorApp.set(tempo.tempo_uso_nome, totalAtual + toNumber(tempo.tempo_uso_minutos));
    }

    const gastoTotalPorApp = new Map<string, number>();

    for (const gasto of gastosPorApp) {
      gastoTotalPorApp.set(gasto.compra_fonte, toNumber(gasto._sum.compra_valor));
    }

    return [...tempoTotalPorApp.entries()]
      .map(([app, tempo_total]) => ({
        app,
        tempo_total,
        gasto_total: gastoTotalPorApp.get(app) ?? 0,
      }))
      .sort((left, right) => right.gasto_total - left.gasto_total);
  }
}
