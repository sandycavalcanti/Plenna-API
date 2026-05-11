import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { CreateCompraDTO, UpdateCompraDTO } from './compra.schemas.js';
import { MetricasService, getMonthBounds } from './metricas.service.js';

function toCents(value: Prisma.Decimal | number | string) {
  return Math.round(Number(value) * 100);
}

function fromCents(cents: number) {
  return new Prisma.Decimal((cents / 100).toFixed(2));
}

function normalizeMonthKey(date: Date) {
  return date.toISOString().slice(0, 7);
}

export class CompraService {
  static async create(userId: number, data: CreateCompraDTO) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.tb_usuario.findFirst({
        where: {
          usuario_id: userId,
          usuario_status: true,
        },
        select: {
          usuario_meta_valor_compra: true,
        },
      });

      if (!user) {
        throw new Error('Usuário não encontrado');
      }

      const formaPagamento = await tx.tb_forma_pagamento.findUnique({
        where: { forma_pagamento_id: data.formaPagamentoId },
      });

      if (!formaPagamento) {
        throw new Error('Forma de pagamento não encontrada');
      }

      const categoriaIds = [...new Set(data.items.map((item) => item.categoriaId))];
      const categoriasEncontradas = await tx.tb_categoria.count({
        where: {
          categoria_id: {
            in: categoriaIds,
          },
        },
      });

      if (categoriasEncontradas !== categoriaIds.length) {
        throw new Error('Categoria não encontrada');
      }

      const totalCents = data.items.reduce((sum, item) => sum + toCents(item.valor), 0);
  const purchaseLimitCents = user.usuario_meta_valor_compra ? toCents(user.usuario_meta_valor_compra) : null;
  const compraAcimaLimite = purchaseLimitCents === null ? false : totalCents > purchaseLimitCents;

      const compra = await tx.tb_compra.create({
        data: {
          usuario_id: userId,
          forma_pagamento_id: data.formaPagamentoId,
          compra_valor: fromCents(totalCents),
          compra_horario: data.compraHorario,
          compra_fonte: data.compraFonte ?? '',
          compra_email: data.compraEmail ?? true,
          compra_classificacao: data.compraClassificacao,
          compra_acima_limite: compraAcimaLimite,
          compra_usuario_concorda: data.compraUsuarioConcorda,
          compra_usuario_anotacao: data.compraUsuarioAnotacao,
        },
      });

      await tx.tb_compra_item.createMany({
        data: data.items.map((item) => ({
          compra_id: compra.compra_id,
          categoria_id: item.categoriaId,
          compra_item_nome: item.nome,
          compra_item_valor: fromCents(toCents(item.valor)),
        })),
      });

      const metricas = await MetricasService.recalculateMonthlyMetrics(userId, data.compraHorario, tx);

      const compraComItens = await tx.tb_compra.findFirst({
        where: { compra_id: compra.compra_id },
        include: {
          tb_compra_item: {
            include: {
              tb_categoria: true,
            },
          },
        },
      });

      return {
        compra: compraComItens,
        metricas,
      };
    });
  }

  static async update(userId: number, compraId: number, data: UpdateCompraDTO) {
    return prisma.$transaction(async (tx) => {
      const existingCompra = await tx.tb_compra.findFirst({
        where: {
          compra_id: compraId,
          usuario_id: userId,
        },
        include: {
          tb_compra_item: {
            include: {
              tb_categoria: true,
            },
          },
        },
      });

      if (!existingCompra) {
        throw new Error('Compra não encontrada');
      }

      const user = await tx.tb_usuario.findFirst({
        where: {
          usuario_id: userId,
          usuario_status: true,
        },
        select: {
          usuario_meta_valor_compra: true,
        },
      });

      if (!user) {
        throw new Error('Usuário não encontrado');
      }

      if (data.formaPagamentoId !== undefined) {
        const formaPagamento = await tx.tb_forma_pagamento.findUnique({
          where: { forma_pagamento_id: data.formaPagamentoId },
        });

        if (!formaPagamento) {
          throw new Error('Forma de pagamento não encontrada');
        }
      }

      const categoriaIds = [...new Set(data.items.map((item) => item.categoriaId))];
      const categoriasEncontradas = await tx.tb_categoria.count({
        where: {
          categoria_id: {
            in: categoriaIds,
          },
        },
      });

      if (categoriasEncontradas !== categoriaIds.length) {
        throw new Error('Categoria não encontrada');
      }

      const purchaseDate = data.compraHorario ?? existingCompra.compra_horario;
      const totalCents = data.items.reduce((sum, item) => sum + toCents(item.valor), 0);
      const purchaseLimitCents = user.usuario_meta_valor_compra ? toCents(user.usuario_meta_valor_compra) : null;
      const compraAcimaLimite = purchaseLimitCents === null ? false : totalCents > purchaseLimitCents;

      await tx.tb_compra_item.deleteMany({
        where: {
          compra_id: compraId,
        },
      });

      await tx.tb_compra.update({
        where: {
          compra_id: compraId,
        },
        data: {
          forma_pagamento_id: data.formaPagamentoId ?? existingCompra.forma_pagamento_id,
          compra_valor: fromCents(totalCents),
          compra_horario: purchaseDate,
          compra_fonte: data.compraFonte ?? existingCompra.compra_fonte,
          compra_email: data.compraEmail ?? existingCompra.compra_email,
          compra_classificacao: data.compraClassificacao ?? existingCompra.compra_classificacao,
          compra_acima_limite: compraAcimaLimite,
          compra_usuario_concorda: data.compraUsuarioConcorda ?? existingCompra.compra_usuario_concorda,
          compra_usuario_anotacao: data.compraUsuarioAnotacao ?? existingCompra.compra_usuario_anotacao,
        },
      });

      await tx.tb_compra_item.createMany({
        data: data.items.map((item) => ({
          compra_id: compraId,
          categoria_id: item.categoriaId,
          compra_item_nome: item.nome,
          compra_item_valor: fromCents(toCents(item.valor)),
        })),
      });

      const monthsToRecalculate = new Map<string, Date>();
      monthsToRecalculate.set(normalizeMonthKey(existingCompra.compra_horario), existingCompra.compra_horario);
      monthsToRecalculate.set(normalizeMonthKey(purchaseDate), purchaseDate);

      const metricas = [] as Awaited<ReturnType<typeof MetricasService.recalculateMonthlyMetrics>>[];
      for (const monthDate of monthsToRecalculate.values()) {
        metricas.push(await MetricasService.recalculateMonthlyMetrics(userId, monthDate, tx));
      }

      const compra = await tx.tb_compra.findFirst({
        where: { compra_id: compraId },
        include: {
          tb_compra_item: {
            include: {
              tb_categoria: true,
            },
          },
        },
      });

      return {
        compra,
        metricas,
      };
    });
  }

  static async delete(userId: number, compraId: number) {
    return prisma.$transaction(async (tx) => {
      const existingCompra = await tx.tb_compra.findFirst({
        where: {
          compra_id: compraId,
          usuario_id: userId,
        },
      });

      if (!existingCompra) {
        throw new Error('Compra não encontrada');
      }

      await tx.tb_compra_item.deleteMany({
        where: {
          compra_id: compraId,
        },
      });

      await tx.tb_compra.delete({
        where: {
          compra_id: compraId,
        },
      });

      const metricas = await MetricasService.recalculateMonthlyMetrics(userId, existingCompra.compra_horario, tx);

      return { metricas };
    });
  }

  static async findAllByUserId(userId: number) {
    return prisma.tb_compra.findMany({
      where: { usuario_id: userId },
      include: {
        tb_compra_item: {
          include: {
            tb_categoria: true,
          },
        },
      },
      orderBy: {
        compra_horario: 'desc',
      },
    });
  }

  static async findById(userId: number, compraId: number) {
    const compra = await prisma.tb_compra.findFirst({
      where: {
        compra_id: compraId,
        usuario_id: userId,
      },
      include: {
        tb_compra_item: {
          include: {
            tb_categoria: true,
          },
        },
      },
    });

    if (!compra) {
      throw new Error('Compra não encontrada');
    }

    return compra;
  }
}
