import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { CreateCompraDTO, UpdateCompraDTO } from './compra.schemas.js';
import { MetricasService } from './metricas.service.js';
import { AppError } from '../../errors/AppError.js';
/**
 * Converte valores monetários para centavos antes de realizar somas
 * e comparações, reduzindo problemas de precisão de ponto flutuante.
 */
function toCents(value: Prisma.Decimal | number | string) {
  return Math.round(Number(value) * 100);
}

function fromCents(cents: number) {
  return new Prisma.Decimal((cents / 100).toFixed(2));
}

function calculatePurchaseLimitMeta(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const cents = toCents(value);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

type PurchasePayload = {
  formaPagamentoId: number | null;
  compraValor: Prisma.Decimal | null;
  compraHorario: Date;
  compraFonte: string | null;
  compraEmail: boolean;
  compraClassificacao: CreateCompraDTO['compraClassificacao'];
  compraAcimaLimite: boolean | null;
  compraUsuarioConcorda?: boolean | null;
  compraUsuarioAnotacao?: string | null;
};

type PurchaseUpdatePayload = {
  formaPagamentoId: number | null;
  compraValor: Prisma.Decimal | null;
  compraHorario: Date;
  compraFonte: string | null;
  compraEmail: boolean;
  compraClassificacao: UpdateCompraDTO['compraClassificacao'];
  compraAcimaLimite: boolean | null;
  compraUsuarioConcorda?: boolean | null;
  compraUsuarioAnotacao?: string | null;
};

async function recalculatePurchaseLimit(tx: typeof prisma, userId: number) {
  const user = await tx.tb_usuario.findFirst({
    where: { usuario_id: userId, usuario_status: true },
    select: { usuario_meta_valor_compra: true },
  });

  return calculatePurchaseLimitMeta(user?.usuario_meta_valor_compra ?? null);
}

async function applyCompraConfirmation(
  tx: any,
  userId: number,
  compraId: number,
  data: UpdateCompraDTO,
  existing: {
    compra_horario: Date;
    compra_valor: Prisma.Decimal | null;
    compra_status: string;
    compra_usuario_concorda: boolean | null;
    compra_usuario_anotacao: string | null;
    compra_classificacao: string;
    compra_email: boolean;
    compra_fonte: string | null;
    forma_pagamento_id: number | null;
  },
) {
  const items = data.items ?? undefined;
  if (items && items.length > 0) {
    const categoriaIds = [...new Set(items.map((item) => item.categoriaId))];
    const categoriasEncontradas = await tx.tb_categoria.count({ where: { categoria_id: { in: categoriaIds } } });
    if (categoriasEncontradas !== categoriaIds.length) throw new AppError('Categoria não encontrada', 404);
  }

  const formaPagamentoId = data.formaPagamentoId !== undefined ? data.formaPagamentoId : existing.forma_pagamento_id;
  if (formaPagamentoId !== null) {
    const formaPagamento = await tx.tb_forma_pagamento.findUnique({ where: { forma_pagamento_id: formaPagamentoId } });
    if (!formaPagamento) throw new AppError('Forma de pagamento não encontrada', 404);
  }

  const compraHorario = data.compraHorario ?? existing.compra_horario;
  const compraClassificacao = data.compraClassificacao ?? existing.compra_classificacao;
  const compraEmail = data.compraEmail ?? existing.compra_email;
  const compraFonte = data.compraFonte !== undefined ? data.compraFonte : existing.compra_fonte;
  const compraUsuarioConcorda = data.compraUsuarioConcorda ?? existing.compra_usuario_concorda;
  const compraUsuarioAnotacao = data.compraUsuarioAnotacao ?? existing.compra_usuario_anotacao;
  const explicitValue = data.compraValor ?? null;
  const computedValue = items
    ? (items.length > 0 ? fromCents(items.reduce((sum, item) => sum + toCents(item.valor), 0)) : null)
    : existing.compra_valor;
  const compraValor = explicitValue !== null
    ? new Prisma.Decimal(explicitValue.toFixed(2))
    : computedValue;
  const purchaseLimitCents = await recalculatePurchaseLimit(tx, userId);
  const compraAcimaLimite = compraValor !== null && purchaseLimitCents !== null
    ? toCents(compraValor) > purchaseLimitCents
    : null;

  if (items) {
    await tx.tb_compra_item.deleteMany({ where: { compra_id: compraId } });
    if (items.length > 0) {
      await tx.tb_compra_item.createMany({
        data: items.map((item) => ({
          compra_id: compraId,
          categoria_id: item.categoriaId,
          compra_item_nome: item.nome,
          compra_item_valor: fromCents(toCents(item.valor)),
        })),
      });
    }
  }

  const compra = await tx.tb_compra.update({
    where: { compra_id: compraId },
    data: {
      forma_pagamento_id: formaPagamentoId,
      compra_valor: compraValor,
      compra_horario: compraHorario,
      compra_fonte: compraFonte,
      compra_email: compraEmail,
      compra_classificacao: compraClassificacao,
      compra_acima_limite: compraAcimaLimite,
      compra_usuario_concorda: compraUsuarioConcorda,
      compra_usuario_anotacao: compraUsuarioAnotacao,
    },
  });

  return { compra, compraHorario };
}

export class CompraService {
  /**
   * Cria uma compra cadastrada manualmente pelo usuário.
   *
   * A compra, seus itens e o recálculo das métricas são executados dentro
   * da mesma transação para evitar persistência parcial em caso de erro.
   */
  static async create(userId: number, data: CreateCompraDTO) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.tb_usuario.findFirst({
        where: { usuario_id: userId, usuario_status: true },
        select: { usuario_meta_valor_compra: true },
      });
      if (!user) throw new AppError('Usuário não encontrado', 404);

      const formaPagamentoId = data.formaPagamentoId ?? null;
      if (formaPagamentoId !== null) {
        const formaPagamento = await tx.tb_forma_pagamento.findUnique({ where: { forma_pagamento_id: formaPagamentoId } });
        if (!formaPagamento) throw new AppError('Forma de pagamento não encontrada', 404);
      }

      const items = data.items ?? [];
      if (items.length > 0) {
        const categoriaIds = [...new Set(items.map((item) => item.categoriaId))];
        const categoriasEncontradas = await tx.tb_categoria.count({
          where: { categoria_id: { in: categoriaIds } },
        });
        if (categoriasEncontradas !== categoriaIds.length) throw new AppError('Categoria não encontrada', 404);
      }

      const totalCents = items.reduce((sum, item) => sum + toCents(item.valor), 0);
      const explicitValue = data.compraValor ?? null;
      const compraValor = explicitValue !== null
        ? new Prisma.Decimal(explicitValue.toFixed(2))
        : items.length > 0
          ? fromCents(totalCents)
          : null;
      const purchaseLimitCents = calculatePurchaseLimitMeta(user.usuario_meta_valor_compra);
      // `null` representa "não foi possível determinar". Isso é diferente de
      // `false`, que significa que a compra foi efetivamente considerada dentro do limite.
      const compraAcimaLimite = compraValor !== null && purchaseLimitCents !== null
        ? toCents(compraValor) > purchaseLimitCents
        : null;
      const compraStatus: CreateCompraDTO['compraStatus'] = data.compraStatus ?? 'CONFIRMADA';

      const compra = await tx.tb_compra.create({
        data: {
          usuario_id: userId,
          forma_pagamento_id: formaPagamentoId,
          compra_valor: compraValor,
          compra_horario: data.compraHorario,
          compra_fonte: data.compraFonte ?? null,
          compra_email: data.compraEmail ?? false,
          compra_classificacao: data.compraClassificacao,
          compra_acima_limite: compraAcimaLimite,
          compra_usuario_concorda: data.compraUsuarioConcorda,
          compra_usuario_anotacao: data.compraUsuarioAnotacao,
          compra_status: compraStatus,
          compra_email_mensagem_id: null,
        },
      });

      if (items.length > 0) {
        await tx.tb_compra_item.createMany({
          data: items.map((item) => ({
            compra_id: compra.compra_id,
            categoria_id: item.categoriaId,
            compra_item_nome: item.nome,
            compra_item_valor: fromCents(toCents(item.valor)),
          })),
        });
      }

      return {
        compra,
        metricas: await MetricasService.recalculateMonthlyMetrics(userId, data.compraHorario, tx),
      };
    });
  }

  static async update(userId: number, compraId: number, data: UpdateCompraDTO) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId } });
      if (!existing) throw new AppError('Compra não encontrada', 404);
      await applyCompraConfirmation(tx, userId, compraId, data, existing);

      return { compra: await tx.tb_compra.findFirst({ where: { compra_id: compraId } }) };
    });
  }
  /**
   * Confirma uma compra que aguardava validação do usuário.
   *
   * A operação é idempotente quando a compra já está confirmada e impede
   * que uma compra previamente ignorada retorne ao fluxo normal.
   * Antes da confirmação, os dados enviados pelo usuário podem complementar
   * ou corrigir as informações identificadas automaticamente.
   */
  static async confirm(userId: number, compraId: number, data?: UpdateCompraDTO) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId } });
      if (!existing) throw new AppError('Compra não encontrada', 404);
      if (existing.compra_status === 'IGNORADA') throw new AppError('Compra ignorada não pode ser confirmada', 409);
      if (existing.compra_status === 'CONFIRMADA') return { compra: existing };
      if ((data?.compraValor ?? existing.compra_valor) === null) {
        throw new AppError('Compra sem valor não pode ser confirmada', 400);
      }

      const result = await applyCompraConfirmation(tx, userId, compraId, data ?? {}, existing);
      const compra = await tx.tb_compra.update({
        where: { compra_id: compraId },
        data: { compra_status: 'CONFIRMADA' },
      });

      const compraFinal = await MetricasService.recalculateMonthlyMetrics(userId, result.compraHorario, tx).then(() => compra);
      return { compra: compraFinal };
    });
  }
  /**
   * Marca como ignorada uma compra automática ainda pendente.
   *
   * O registro é preservado para manter a deduplicação baseada no messageId
   * e impedir que o mesmo e-mail volte a gerar uma nova compra.
   */
  static async ignore(userId: number, compraId: number) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId } });
      if (!existing) throw new AppError('Compra não encontrada', 404);
      if (existing.compra_status === 'CONFIRMADA') throw new AppError('Compra confirmada não pode ser ignorada', 409);
      if (existing.compra_status === 'IGNORADA') return existing;
      return tx.tb_compra.update({
        where: { compra_id: compraId },
        data: { compra_status: 'IGNORADA' },
      });
    });
  }

  static async findAllByUserId(userId: number) {
    return prisma.tb_compra.findMany({ where: { usuario_id: userId }, include: { tb_compra_item: { include: { tb_categoria: true } } }, orderBy: { compra_horario: 'desc' } });
  }

  static async findPendingByUserId(userId: number) {
    return prisma.tb_compra.findMany({
      where: { usuario_id: userId, compra_status: 'AGUARDANDO_CONFIRMACAO' },
      orderBy: { compra_horario: 'desc' },
    });
  }

  static async findById(userId: number, compraId: number) {
    const compra = await prisma.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId }, include: { tb_compra_item: { include: { tb_categoria: true } } } });
    if (!compra) throw new AppError('Compra não encontrada', 404);
    return compra;
  }
}
