import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { GastoCategoriaDTO, GastoFormaPagamentoDTO, ImpulsividadeDTO, LimiteComprasDTO, TempoVsGastoDTO } from './dashboard.schemas.js';
/**
 * Calcula o intervalo UTC correspondente ao mês de referência.
 *
 * O intervalo é semiaberto (`>= início` e `< início do próximo mês`),
 * evitando problemas com diferentes quantidades de dias e milissegundos
 * no final do mês.
 */
function getMonthBounds(referenceDate: Date = new Date()) {
  const start = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + 1, 1));

  return { start, end };
}

function toNumber(value: Prisma.Decimal | number) {
  return Number(value);
}

// Somente contagens agregadas; nunca dados de compras ou identidade do usuário.
// Expor cobertura dos indicadores no Mobile exige uma evolução futura do contrato.
function registrarIgnorados(indicador: string, quantidade: number) {
  if (quantidade > 0) {
    console.info('dashboard_dados_insuficientes', { indicador, quantidade });
  }
}
/**
 * Calcula os indicadores financeiros utilizados pelo dashboard.
 *
 * Apenas compras confirmadas participam das métricas de gasto, evitando
 * que compras pendentes ou ignoradas alterem os indicadores do usuário.
 */
export class DashboardService {
  static async findGastosPorCategoria(userId: number): Promise<GastoCategoriaDTO[]> {
    const { start, end } = getMonthBounds();

    const compras = await prisma.tb_compra.findMany({
      where: {
        tb_compra: {
          usuario_id: userId,
          compra_status: 'CONFIRMADA',
          compra_horario: {
            gte: start,
            lt: end,
          },
        },
      },
      select: {
        compra_valor: true,
        tb_compra_item: {
          select: {
            compra_item_valor: true,
            tb_categoria: { select: { categoria_nome: true } },
          },
        },
      },
    });

    const totalsByCategory = new Map<string, number>();
    let ignorados = 0;

    for (const item of items) {
      // Itens sem categoria nao entram nesta visao, pois o contrato do
      // dashboard exige um nome real e nao devemos inventar uma categoria.
      if (!item.tb_categoria) continue;
      const categoriaNome = item.tb_categoria.categoria_nome;
      const totalAtual = totalsByCategory.get(categoriaNome) ?? 0;
      totalsByCategory.set(categoriaNome, totalAtual + toNumber(item.compra_item_valor));
    }
    registrarIgnorados('gastos_categoria', ignorados);

    return [...totalsByCategory.entries()].map(([categoria_nome, total]) => ({ categoria_nome, total })).sort((left, right) => right.total - left.total);
  }

  static async findGastosPorFormaPagamento(userId: number): Promise<GastoFormaPagamentoDTO[]> {
    const { start, end } = getMonthBounds();

    const compras = await prisma.tb_compra.findMany({
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
        tb_forma_pagamento: {
          select: {
            forma_pagamento_nome: true,
          },
        },
      },
    });

    const totalsByFormaPagamento = new Map<string, number>();
    let ignorados = 0;

    for (const compra of compras) {
      const formaPagamentoNome = compra.tb_forma_pagamento?.forma_pagamento_nome ?? 'Sem forma de pagamento';
      const totalAtual = totalsByFormaPagamento.get(formaPagamentoNome) ?? 0;
      totalsByFormaPagamento.set(formaPagamentoNome, totalAtual + toNumber(compra.compra_valor));
    }
    registrarIgnorados('gastos_forma_pagamento', ignorados);

    return [...totalsByFormaPagamento.entries()].map(([forma_pagamento_nome, total]) => ({ forma_pagamento_nome, total })).sort((left, right) => right.total - left.total);
  }

  static async findImpulsividade(userId: number): Promise<ImpulsividadeDTO[]> {
    const { start, end } = getMonthBounds();

    const grupos = await prisma.tb_compra.groupBy({
      where: {
        usuario_id: userId,
        compra_status: 'CONFIRMADA',
        compra_horario: {
          gte: start,
          lt: end,
        },
      },
      by: ['compra_classificacao'],
      _count: {
        _all: true,
        compra_valor: true,
      },
      _sum: {
        compra_valor: true,
      },
    });

    registrarIgnorados('impulsividade', grupos.reduce((total, grupo) => total + grupo._count._all - grupo._count.compra_valor, 0));
    return grupos.flatMap((grupo) => grupo._sum.compra_valor === null ? [] : [{
      compra_classificacao: grupo.compra_classificacao,
      quantidade: grupo._count.compra_valor,
      valor_total: toNumber(grupo._sum.compra_valor),
    }]);
  }

  static async findComprasAcimaLimite(userId: number): Promise<LimiteComprasDTO> {
    const { start, end } = getMonthBounds();

    const grupos = await prisma.tb_compra.groupBy({
      where: {
        usuario_id: userId,
        compra_status: 'CONFIRMADA',
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
      if (grupo.compra_acima_limite === true) {
        resultado.acima_limite = grupo._count._all;
      } else if (grupo.compra_acima_limite === false) {
        resultado.dentro_limite = grupo._count._all;
      } else {
        registrarIgnorados('compras_acima_limite', grupo._count._all);
      }
    }

    return resultado;
  }

  static async findTempoVsGasto(userId: number): Promise<TempoVsGastoDTO[]> {
    const { start, end } = getMonthBounds();

    // As consultas são independentes e executadas em paralelo para reduzir
    // o tempo total necessário para montar o indicador.
    const [temposUso, gastosPorApp] = await Promise.all([
      prisma.tb_tempo_uso.findMany({
        where: {
          usuario_id: userId,
          OR: [
            { tempo_uso_inicio: { gte: start, lt: end } },
            { tempo_uso_inicio: null, tempo_uso_data: { gte: start, lt: end } },
          ],
        },
        select: {
          tempo_uso_nome: true,
          tempo_uso_minutos: true,
          tempo_uso_duracao_segundos: true,
        },
      }),
      prisma.tb_compra.groupBy({
        where: {
        usuario_id: userId,
        compra_status: 'CONFIRMADA',
        compra_horario: {
          gte: start,
          lt: end,
        },
        },
        by: ['compra_fonte'],
        _sum: {
          compra_valor: true,
        },
        _count: { _all: true, compra_valor: true },
      }),
    ]);

    const tempoTotalPorApp = new Map<string, number>();
    let temposIgnorados = 0;

    for (const tempo of temposUso) {
      const totalAtual = tempoTotalPorApp.get(tempo.tempo_uso_nome) ?? 0;
      const minutos = tempo.tempo_uso_duracao_segundos !== null
        ? tempo.tempo_uso_duracao_segundos / 60
        : tempo.tempo_uso_minutos === null ? null : toNumber(tempo.tempo_uso_minutos);
      if (minutos === null) {
        temposIgnorados += 1;
        continue;
      }
      tempoTotalPorApp.set(tempo.tempo_uso_nome, totalAtual + minutos);
    }

    const gastoTotalPorApp = new Map<string, number>();
    let comprasIgnoradas = 0;

    for (const gasto of gastosPorApp) {
      if (!gasto.compra_fonte) continue;
      if (gasto.compra_fonte === null || gasto._sum.compra_valor === null) {
        comprasIgnoradas += gasto._count._all;
        continue;
      }
      comprasIgnoradas += gasto._count._all - gasto._count.compra_valor;
      gastoTotalPorApp.set(gasto.compra_fonte, toNumber(gasto._sum.compra_valor));
    }
    registrarIgnorados('gastos_fonte', comprasIgnoradas);
    registrarIgnorados('tempo_uso', temposIgnorados);
    registrarIgnorados('tempo_sem_gasto_conhecido', [...tempoTotalPorApp.keys()].filter((app) => !gastoTotalPorApp.has(app)).length);

    return [...tempoTotalPorApp.entries()]
      .flatMap(([app, tempo_total]) => {
        const gasto_total = gastoTotalPorApp.get(app);
        return gasto_total === undefined ? [] : [{ app, tempo_total, gasto_total }];
      })
      .sort((left, right) => right.gasto_total - left.gasto_total);
  }
}
