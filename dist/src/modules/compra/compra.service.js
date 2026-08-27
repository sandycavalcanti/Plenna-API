import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { MetricasService } from './metricas.service.js';
import { AppError } from '../../errors/AppError.js';
/**
 * Converte valores monetários para centavos antes de realizar somas
 * e comparações, reduzindo problemas de precisão de ponto flutuante.
 */
function toCents(value) {
    return Math.round(Number(value) * 100);
}
function fromCents(cents) {
    return new Prisma.Decimal((cents / 100).toFixed(2));
}
function calculatePurchaseLimitMeta(value) {
    if (value === null || value === undefined)
        return null;
    const cents = toCents(value);
    return Number.isFinite(cents) && cents > 0 ? cents : null;
}
function resolveCompraValor(explicitValue, items, fallbackValue) {
    if (explicitValue !== null && explicitValue !== undefined) {
        return new Prisma.Decimal(Number(explicitValue).toFixed(2));
    }
    if (items !== undefined) {
        if (items.length === 0)
            return null;
        const totalCents = items.reduce((sum, item) => sum + toCents(item.valor), 0);
        return fromCents(totalCents);
    }
    return fallbackValue;
}
function resolveMetricPeriods(previousDate, currentDate) {
    const previousMonth = previousDate.getUTCFullYear() * 100 + previousDate.getUTCMonth();
    const currentMonth = currentDate.getUTCFullYear() * 100 + currentDate.getUTCMonth();
    return previousMonth === currentMonth ? [currentDate] : [previousDate, currentDate];
}
async function recalculatePurchaseLimit(tx, userId) {
    const user = await tx.tb_usuario.findFirst({
        where: { usuario_id: userId, usuario_status: true },
        select: { usuario_meta_valor_compra: true },
    });
    return calculatePurchaseLimitMeta(user?.usuario_meta_valor_compra ?? null);
}
async function applyCompraConfirmation(tx, userId, compraId, data, existing) {
    const items = data.items ?? undefined;
    if (items && items.length > 0) {
        const categoriaIds = [...new Set(items.map((item) => item.categoriaId))];
        const categoriasEncontradas = await tx.tb_categoria.count({ where: { categoria_id: { in: categoriaIds } } });
        if (categoriasEncontradas !== categoriaIds.length)
            throw new AppError('Categoria não encontrada', 404);
    }
    const formaPagamentoId = data.formaPagamentoId !== undefined ? data.formaPagamentoId : existing.forma_pagamento_id;
    if (formaPagamentoId !== null) {
        const formaPagamento = await tx.tb_forma_pagamento.findUnique({ where: { forma_pagamento_id: formaPagamentoId } });
        if (!formaPagamento)
            throw new AppError('Forma de pagamento não encontrada', 404);
    }
    const compraHorario = data.compraHorario ?? existing.compra_horario;
    const compraClassificacao = data.compraClassificacao ?? existing.compra_classificacao;
    const compraFonte = data.compraFonte !== undefined ? data.compraFonte : existing.compra_fonte;
    const compraUsuarioConcorda = data.compraUsuarioConcorda ?? existing.compra_usuario_concorda;
    const compraUsuarioAnotacao = data.compraUsuarioAnotacao ?? existing.compra_usuario_anotacao;
    const compraValor = resolveCompraValor(data.compraValor, items, existing.compra_valor);
    const purchaseLimitCents = await recalculatePurchaseLimit(tx, userId);
    const compraAcimaLimite = purchaseLimitCents !== null
        ? compraValor !== null && toCents(compraValor) > purchaseLimitCents
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
            compra_classificacao: compraClassificacao,
            compra_acima_limite: compraAcimaLimite,
            compra_usuario_concorda: compraUsuarioConcorda,
            compra_usuario_anotacao: compraUsuarioAnotacao,
        },
    });
    return { compra, compraHorario, compraValor };
}
export class CompraService {
    /**
     * Cria uma compra cadastrada manualmente pelo usuário.
     *
     * A compra, seus itens e o recálculo das métricas são executados dentro
     * da mesma transação para evitar persistência parcial em caso de erro.
     */
    static async create(userId, data) {
        return prisma.$transaction(async (tx) => {
            const user = await tx.tb_usuario.findFirst({
                where: { usuario_id: userId, usuario_status: true },
                select: { usuario_meta_valor_compra: true },
            });
            if (!user)
                throw new AppError('Usuário não encontrado', 404);
            const formaPagamentoId = data.formaPagamentoId ?? null;
            if (formaPagamentoId !== null) {
                const formaPagamento = await tx.tb_forma_pagamento.findUnique({ where: { forma_pagamento_id: formaPagamentoId } });
                if (!formaPagamento)
                    throw new AppError('Forma de pagamento não encontrada', 404);
            }
            const items = data.items ?? [];
            if (items.length > 0) {
                const categoriaIds = [...new Set(items.map((item) => item.categoriaId))];
                const categoriasEncontradas = await tx.tb_categoria.count({
                    where: { categoria_id: { in: categoriaIds } },
                });
                if (categoriasEncontradas !== categoriaIds.length)
                    throw new AppError('Categoria não encontrada', 404);
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
            const compra = await tx.tb_compra.create({
                data: {
                    usuario_id: userId,
                    forma_pagamento_id: formaPagamentoId,
                    compra_valor: compraValor,
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
    static async update(userId, compraId, data) {
        return prisma.$transaction(async (tx) => {
            const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId } });
            if (!existing)
                throw new AppError('Compra não encontrada', 404);
            const result = await applyCompraConfirmation(tx, userId, compraId, data, existing);
            if (result.compraValor === null) {
                throw new AppError('Compra sem valor não pode ser confirmada', 400);
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
     * A operação é idempotente quando a compra já está confirmada e impede
     * que uma compra previamente ignorada retorne ao fluxo normal.
     * Antes da confirmação, os dados enviados pelo usuário podem complementar
     * ou corrigir as informações identificadas automaticamente.
     */
    static async confirm(userId, compraId, data) {
        return prisma.$transaction(async (tx) => {
            const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId } });
            if (!existing)
                throw new AppError('Compra não encontrada', 404);
            if (existing.compra_status === 'IGNORADA')
                throw new AppError('Compra ignorada não pode ser confirmada', 409);
            if (existing.compra_status === 'CONFIRMADA')
                return { compra: existing };
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
    static async ignore(userId, compraId) {
        return prisma.$transaction(async (tx) => {
            const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId } });
            if (!existing)
                throw new AppError('Compra não encontrada', 404);
            if (existing.compra_status === 'CONFIRMADA')
                throw new AppError('Compra confirmada não pode ser ignorada', 409);
            if (existing.compra_status === 'IGNORADA')
                return existing;
            return tx.tb_compra.update({
                where: { compra_id: compraId },
                data: { compra_status: 'IGNORADA' },
            });
        });
    }
    static async findAllByUserId(userId) {
        return prisma.tb_compra.findMany({ where: { usuario_id: userId }, include: { tb_compra_item: { include: { tb_categoria: true } } }, orderBy: { compra_horario: 'desc' } });
    }
    static async findPendingByUserId(userId) {
        return prisma.tb_compra.findMany({
            where: { usuario_id: userId, compra_status: 'AGUARDANDO_CONFIRMACAO' },
            orderBy: { compra_horario: 'desc' },
        });
    }
    static async findById(userId, compraId) {
        const compra = await prisma.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId }, include: { tb_compra_item: { include: { tb_categoria: true } } } });
        if (!compra)
            throw new AppError('Compra não encontrada', 404);
        return compra;
    }
}
