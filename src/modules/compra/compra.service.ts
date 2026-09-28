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

type PurchaseItemInput = NonNullable<UpdateCompraDTO['items']>;

function resolveCompraValor(
  explicitValue: Prisma.Decimal | number | null | undefined,
  items: PurchaseItemInput | undefined,
  fallbackValue: Prisma.Decimal | null,
  discountAmount: Prisma.Decimal | number | null | undefined = null,
) {
  if (explicitValue !== null && explicitValue !== undefined) {
    return new Prisma.Decimal(Number(explicitValue).toFixed(2));
  }

  if (items !== undefined) {
    if (items.length === 0) return null;
    const totalCents = items.reduce((sum, item) => sum + toCents(item.valor), 0);
    // Ao recalcular itens, preservamos o desconto da compra sem permitir total
    // negativo. O desconto continua sendo atributo financeiro, nunca item.
    const discountCents = discountAmount == null ? 0 : Math.max(0, toCents(discountAmount));
    return fromCents(Math.max(0, totalCents - discountCents));
  }

  return fallbackValue;
}

function resolveMetricPeriods(previousDate: Date, currentDate: Date) {
  const previousMonth = previousDate.getUTCFullYear() * 100 + previousDate.getUTCMonth();
  const currentMonth = currentDate.getUTCFullYear() * 100 + currentDate.getUTCMonth();
  return previousMonth === currentMonth ? [currentDate] : [previousDate, currentDate];
}

// O helper recebe somente o delegate usado na consulta, permitindo reutilizar
// a mesma regra tanto no PrismaClient quanto no cliente transacional.
async function recalculatePurchaseLimit(tx: Pick<Prisma.TransactionClient, 'tb_usuario'>, userId: number) {
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
    compra_desconto: Prisma.Decimal;
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
  const compraFonte = data.compraFonte !== undefined ? data.compraFonte : existing.compra_fonte;
  const compraUsuarioConcorda = data.compraUsuarioConcorda ?? existing.compra_usuario_concorda;
  const compraUsuarioAnotacao = data.compraUsuarioAnotacao ?? existing.compra_usuario_anotacao;
  const compraValor = resolveCompraValor(data.compraValor, items, existing.compra_valor, existing.compra_desconto);
  const purchaseLimitCents = await recalculatePurchaseLimit(tx, userId);
  const compraAcimaLimite = purchaseLimitCents !== null
    ? compraValor !== null && toCents(compraValor) > purchaseLimitCents
    : null;

  if (items) {
    // Ao substituir os itens durante uma atualização, os registros antigos
    // também seguem soft delete para preservar o histórico da compra.
    await tx.tb_compra_item.updateMany({
      where: { compra_id: compraId, compra_item_ativo: 1 },
      data: { compra_item_ativo: 0, compra_item_excluido_em: new Date() },
    });
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
      compra_classificacao: compraClassificacao,
      compra_acima_limite: compraAcimaLimite,
      compra_usuario_concorda: compraUsuarioConcorda,
      compra_usuario_anotacao: compraUsuarioAnotacao,
    },
  });

  return { compra, compraHorario, compraValor };
}

/**
 * Marca uma compra e seus itens ativos como excluídos logicamente.
 *
 * A função é compartilhada pelo DELETE da compra e pelo caso em que o último
 * item é removido. Assim, ambas as entradas preservam os registros, gravam o
 * mesmo instante de exclusão e recalculam métricas de forma consistente.
 */
async function softDeleteCompra(tx: any, userId: number, compraId: number) {
  // A combinação do ID com o usuário e com compra_ativo impede operar sobre
  // compra de terceiro ou sobre compra já excluída, sem revelar sua existência.
  const existing = await tx.tb_compra.findFirst({
    where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
    select: { compra_id: true, compra_horario: true, compra_status: true },
  });

  if (!existing) throw new AppError('Compra não encontrada', 404);

  const excludedAt = new Date();

  // Os itens ativos são inativados antes da compra, mantendo todo o histórico
  // e garantindo que nenhum deles continue aparecendo nas listagens.
  await tx.tb_compra_item.updateMany({
    where: { compra_id: compraId, compra_item_ativo: 1 },
    data: { compra_item_ativo: 0, compra_item_excluido_em: excludedAt },
  });

  // A compra também permanece no banco, mas deixa de ser considerada ativa.
  await tx.tb_compra.update({
    where: { compra_id: compraId },
    data: { compra_ativo: 0, compra_excluido_em: excludedAt },
  });

  // O recálculo ocorre dentro da mesma transaction para que os indicadores
  // parem de considerar a compra somente quando a exclusão for confirmada.
  if (existing.compra_status === 'CONFIRMADA') {
    await MetricasService.recalculateMonthlyMetrics(userId, existing.compra_horario, tx);
  }
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

      const compraValor = resolveCompraValor(data.compraValor, items, null);
      if (compraValor === null) {
        throw new AppError('Compra manual sem valor não pode ser criada', 400);
      }
      const purchaseLimitCents = calculatePurchaseLimitMeta(user.usuario_meta_valor_compra);
      // `null` representa "não foi possível determinar". Isso é diferente de
      // `false`, que significa que a compra foi efetivamente considerada dentro do limite.
      const compraAcimaLimite = compraValor !== null && purchaseLimitCents !== null
        ? toCents(compraValor) > purchaseLimitCents
        : null;
      const compra = await tx.tb_compra.create({
        data: {
          usuario_id: userId,
          forma_pagamento_id: formaPagamentoId,
          compra_valor: compraValor,
          // Compras manuais nao recebem desconto nesta etapa; o default
          // financeiro explicito mantem o contrato uniforme das respostas.
          compra_desconto: new Prisma.Decimal(0),
          compra_horario: data.compraHorario,
          compra_fonte: data.compraFonte ?? null,
          compra_email: false,
          compra_classificacao: data.compraClassificacao,
          compra_acima_limite: compraAcimaLimite,
          compra_usuario_concorda: data.compraUsuarioConcorda,
          compra_usuario_anotacao: data.compraUsuarioAnotacao,
          compra_status: 'CONFIRMADA',
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
      const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 } });
      if (!existing) throw new AppError('Compra não encontrada', 404);
      const result = await applyCompraConfirmation(tx, userId, compraId, data, existing);

      if (existing.compra_status === 'CONFIRMADA' && result.compraValor === null) {
        throw new AppError('Compra confirmada deve possuir valor', 400);
      }

      if (existing.compra_status === 'CONFIRMADA') {
        const metricPeriods = resolveMetricPeriods(existing.compra_horario, result.compraHorario);
        for (const period of metricPeriods) {
          await MetricasService.recalculateMonthlyMetrics(userId, period, tx);
        }
      }

      return { compra: await tx.tb_compra.findFirst({ where: { compra_id: compraId } }) };
    });
  }
  /**
   * Confirma uma compra que aguardava validação do usuário.
   *
   * A operação é idempotente quando a compra já está confirmada. Compras
   * ignoradas são um estado final persistido: continuam no banco para
   * histórico e deduplicação, mas não podem ser reativadas.
   * Antes da confirmação, os dados enviados pelo usuário podem complementar
   * ou corrigir as informações identificadas automaticamente.
   */
  static async confirm(userId: number, compraId: number, data?: UpdateCompraDTO) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 } });
      if (!existing) throw new AppError('Compra não encontrada', 404);
      if (existing.compra_status === 'CONFIRMADA') return { compra: existing };
      if (existing.compra_status === 'IGNORADA') {
        // Ignorada representa uma detecção descartada definitivamente. A
        // consulta acima ainda valida ownership e compra ativa, mas o status
        // final não pode voltar a gerar gastos nem ser recuperado pela UI.
        throw new AppError('Compra ignorada não pode ser confirmada', 409);
      }
      const result = await applyCompraConfirmation(tx, userId, compraId, data ?? {}, existing);
      if (result.compraValor === null) {
        throw new AppError('Compra sem valor não pode ser confirmada', 400);
      }
      const compra = await tx.tb_compra.update({
        where: { compra_id: compraId },
        data: { compra_status: 'CONFIRMADA' },
      });

      await MetricasService.recalculateMonthlyMetrics(userId, result.compraHorario, tx);
      const compraFinal = await tx.tb_compra.findFirst({ where: { compra_id: compraId } });
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
      const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 } });
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
    return prisma.tb_compra.findMany({
      // Ignoradas permanecem persistidas para histórico/deduplicação, mas a
      // listagem principal expõe somente decisões ainda relevantes: pendentes
      // e confirmadas. Isso evita que a UI precise criar uma categoria de
      // recuperação para um estado final.
      where: {
        usuario_id: userId,
        compra_ativo: 1,
        compra_status: { in: ['AGUARDANDO_CONFIRMACAO', 'CONFIRMADA'] },
      },
      include: { tb_compra_item: { where: { compra_item_ativo: 1 }, include: { tb_categoria: true } } },
      orderBy: { compra_horario: 'desc' },
    });
  }

  static async findPendingByUserId(userId: number) {
    return prisma.tb_compra.findMany({
      where: { usuario_id: userId, compra_status: 'AGUARDANDO_CONFIRMACAO', compra_ativo: 1 },
      orderBy: { compra_horario: 'desc' },
    });
  }

  static async findById(userId: number, compraId: number) {
    const compra = await prisma.tb_compra.findFirst({
      where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
      include: { tb_compra_item: { where: { compra_item_ativo: 1 }, include: { tb_categoria: true } } },
    });
    if (!compra) throw new AppError('Compra não encontrada', 404);
    return compra;
  }

  /**
   * Exclui uma compra e seus itens de forma atômica.
   *
   * O schema usa NoAction na relação entre compra e item; por isso a ordem é
   * obrigatória: primeiro removemos os filhos e somente depois o pai.
   * A busca também ocorre dentro da transaction e combina compra_id com
   * usuario_id, impedindo que um usuário opere sobre compra de outra pessoa.
   */
  static async delete(userId: number, compraId: number) {
    return prisma.$transaction(async (tx) => {
      // A compra de outro usuário é tratada como inexistente para não revelar
      // informações sobre recursos pertencentes a terceiros.
      // O helper aplica a exclusão lógica da compra e dos itens dentro desta
      // transaction, preservando o histórico e as métricas consistentes.
      await softDeleteCompra(tx, userId, compraId);
    });
  }

  /**
   * Remove um item e recalcula os dados derivados da compra.
   *
   * Toda a sequência ocorre na mesma transaction: validação da compra e do
   * item, proteção contra remoção do último item, delete, novo total, limite,
   * compra atualizada e métricas. Assim não existe estado parcial persistido.
   */
  static async deleteItem(userId: number, compraId: number, compraItemId: number) {
    return prisma.$transaction(async (tx) => {
      // Combinar compra_id e usuario_id faz com que compras de terceiros sejam
      // tratadas como inexistentes, sem revelar sua existência ao solicitante.
      const existing = await tx.tb_compra.findFirst({
        where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
        select: { compra_id: true, compra_horario: true, compra_status: true, compra_desconto: true },
      });
      if (!existing) throw new AppError('Compra não encontrada', 404);

      // O item precisa estar vinculado à compra informada; isso também evita
      // excluir item pertencente a outra compra do mesmo usuário.
      const item = await tx.tb_compra_item.findFirst({
        // Item inativo se comporta como inexistente para o usuário.
        where: { compra_item_id: compraItemId, compra_id: compraId, compra_item_ativo: 1 },
        select: { compra_item_id: true },
      });
      if (!item) throw new AppError('Item da compra não encontrado', 404);

      // A compra deve manter pelo menos um item após a operação.
      // A regra do último item considera apenas os itens ainda ativos.
      const itemCount = await tx.tb_compra_item.count({ where: { compra_id: compraId, compra_item_ativo: 1 } });
      if (itemCount === 1) {
        // A exclusão do único item representa, para o usuário, a exclusão da
        // compra inteira. O front normalmente usa o DELETE da compra, mas este
        // caminho defensivo mantém a regra correta se a rota de item for chamada diretamente.
        await softDeleteCompra(tx, userId, compraId);

        // Não existe compra atualizada para retornar depois da remoção total.
        return null;
      }

      // O item é inativado, nunca removido fisicamente, para preservar o
      // histórico sem deixá-lo participar das consultas atuais.
      await tx.tb_compra_item.update({
        where: { compra_item_id: compraItemId },
        data: { compra_item_ativo: 0, compra_item_excluido_em: new Date() },
      });

      // Recalculamos o total somente com os itens restantes, usando centavos
      // para manter a mesma precisão monetária das demais operações do service.
      const remainingItems = await tx.tb_compra_item.findMany({
        where: { compra_id: compraId, compra_item_ativo: 1 },
        select: { compra_item_valor: true },
      });
      const totalCents = remainingItems.reduce((sum, remainingItem) => sum + toCents(remainingItem.compra_item_valor), 0);
      // O valor armazenado e o total liquido: itens restantes menos o desconto
      // original, limitado a zero para impedir valores financeiros negativos.
      const descontoCents = Math.max(0, toCents(existing.compra_desconto ?? 0));
      const compraValor = fromCents(Math.max(0, totalCents - descontoCents));

      // O limite é recalculado a partir da configuração atual do usuário para
      // manter compra_acima_limite coerente com o novo valor total.
      const purchaseLimitCents = await recalculatePurchaseLimit(tx, userId);
      const compraAcimaLimite = purchaseLimitCents !== null
        ? toCents(compraValor) > purchaseLimitCents
        : null;

      await tx.tb_compra.update({
        where: { compra_id: compraId },
        data: { compra_valor: compraValor, compra_acima_limite: compraAcimaLimite },
      });

      // Somente compras confirmadas alteram as métricas financeiras mensais.
      if (existing.compra_status === 'CONFIRMADA') {
        await MetricasService.recalculateMonthlyMetrics(userId, existing.compra_horario, tx);
      }

      // Retornamos a compra completa já atualizada para o front não precisar
      // fazer um GET adicional após cada exclusão individual.
      return tx.tb_compra.findFirst({
        where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
        include: { tb_compra_item: { where: { compra_item_ativo: 1 }, include: { tb_categoria: true } } },
      });
    });
  }
}
