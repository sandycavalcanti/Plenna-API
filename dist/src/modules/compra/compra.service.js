import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { MetricasService } from './metricas.service.js';
import { metricPeriods, parseMonth, businessDayBounds } from './financeiro.js';
import { evaluateConfirmedPurchaseLimits, itemTotalCents } from './limite.service.js';
import { AppError } from '../../errors/AppError.js';
import { dispatchPushAfterCommit } from '../notification/push.service.js';
import { bloquearCompra, registrarClassificacao, registrarEventoInterno, validarSaldoAposEdicao } from './eventos.ledger.js';
const publicPurchaseSelect = {
    compra_id: true,
    usuario_id: true,
    forma_pagamento_id: true,
    tb_forma_pagamento: { select: { forma_pagamento_nome: true } },
    compra_valor: true,
    compra_horario: true,
    compra_fonte: true,
    compra_email: true,
    compra_classificacao: true,
    compra_acima_limite: true,
    compra_usuario_concorda: true,
    compra_usuario_anotacao: true,
    compra_data_criacao: true,
    compra_status: true,
    compra_ativo: true,
    compra_desconto: true,
    tb_compra_item: { where: { compra_item_ativo: 1 }, select: {
            compra_item_id: true, compra_id: true, categoria_id: true, compra_item_nome: true,
            compra_item_valor: true, compra_item_quantidade: true, compra_item_unidade_medida: true,
            compra_item_data_criacao: true,
            tb_categoria: { select: { categoria_id: true, categoria_nome: true, categoria_data_criacao: true } },
        } },
};
function createdPushNotifications(evaluation) {
    return (evaluation?.alerts ?? [])
        .filter((alert) => alert.created)
        .map((alert) => ({ notificationId: alert.notificationId, type: alert.type }));
}
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
function resolveCompraValor(explicitValue, items, fallbackValue, discountAmount = null) {
    if (explicitValue !== null && explicitValue !== undefined) {
        return new Prisma.Decimal(Number(explicitValue).toFixed(2));
    }
    if (items !== undefined) {
        if (items.length === 0)
            return null;
        const totalCents = items.reduce((sum, item) => sum + toCents(item.valor), 0);
        // Ao recalcular itens, preservamos o desconto da compra sem permitir total
        // negativo. O desconto continua sendo atributo financeiro, nunca item.
        const discountCents = discountAmount == null ? 0 : Math.max(0, toCents(discountAmount));
        return fromCents(Math.max(0, totalCents - discountCents));
    }
    return fallbackValue;
}
function resolveMetricPeriods(previousDate, currentDate) { return metricPeriods(previousDate, currentDate); }
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
    let compraValor = resolveCompraValor(data.compraValor, items, existing.compra_valor, existing.compra_desconto);
    if (items) {
        const currentItems = await tx.tb_compra_item.findMany({
            where: { compra_id: compraId, compra_item_ativo: 1 }, orderBy: { compra_item_id: 'asc' },
        });
        // Legacy clients can resend an unchanged list without allocating new identities.
        const unchanged = items.length === currentItems.length && items.every((item, index) => {
            const previous = currentItems[index];
            return (item.itemId === undefined || item.itemId === previous.compra_item_id) && item.nome === previous.compra_item_nome &&
                item.categoriaId === previous.categoria_id && toCents(item.valor) === toCents(previous.compra_item_valor);
        });
        const identified = unchanged ? items.map((item, index) => ({ ...item, itemId: currentItems[index].compra_item_id })) : items;
        const ids = identified.flatMap(item => item.itemId === undefined ? [] : [item.itemId]);
        if (new Set(ids).size !== ids.length)
            throw new AppError('Itens repetidos na correção da compra', 400);
        const byId = new Map(currentItems.map(item => [item.compra_item_id, item]));
        if (ids.some(id => !byId.has(id)))
            throw new AppError('Item da compra não encontrado', 404);
        const retained = new Set(ids);
        const removed = currentItems.filter(item => !retained.has(item.compra_item_id)).map(item => item.compra_item_id);
        const financialChanges = identified.filter(item => item.itemId !== undefined &&
            toCents(item.valor) !== toCents(byId.get(item.itemId).compra_item_valor)).map(item => item.itemId);
        if (removed.length || financialChanges.length) {
            await validarSaldoAposEdicao(tx, userId, compraId, existing.compra_valor === null ? null : toCents(existing.compra_valor), [...removed, ...financialChanges]);
        }
        if (removed.length && await tx.contexto_compra_item.count({ where: { compra_id: compraId, compra_item_id: { in: removed } } })) {
            throw new AppError('Preserve a identidade dos itens vinculados ao contexto ao corrigir a compra', 409);
        }
        if (data.compraValor === null || data.compraValor === undefined) {
            if (unchanged)
                compraValor = existing.compra_valor;
            else {
                const totals = identified.map(item => {
                    const previous = item.itemId === undefined ? undefined : byId.get(item.itemId);
                    if (previous && existing.compra_email && previous.compra_item_quantidade === null)
                        return null;
                    return itemTotalCents(item.valor, previous?.compra_item_quantidade ?? null);
                });
                if (totals.some(total => total === null))
                    throw new AppError('Dados insuficientes para recalcular a compra importada', 409);
                compraValor = totals.length ? fromCents(Math.max(0, totals.reduce((sum, total) => sum + total, 0) - toCents(existing.compra_desconto))) : null;
            }
        }
        for (const item of identified) {
            if (item.itemId === undefined)
                continue;
            const previous = byId.get(item.itemId);
            if (item.nome !== previous.compra_item_nome || item.categoriaId !== previous.categoria_id || toCents(item.valor) !== toCents(previous.compra_item_valor)) {
                await tx.tb_compra_item.update({ where: { compra_item_id: item.itemId }, data: {
                        categoria_id: item.categoriaId, compra_item_nome: item.nome, compra_item_valor: fromCents(toCents(item.valor)),
                    } });
                await registrarEventoInterno(tx, userId, compraId, 'ITEM_EDITADO', {
                    campos: [...(item.nome !== previous.compra_item_nome ? ['nome'] : []),
                        ...(item.categoriaId !== previous.categoria_id ? ['categoria'] : []),
                        ...(toCents(item.valor) !== toCents(previous.compra_item_valor) ? ['valor'] : [])],
                }, item.itemId);
            }
        }
        if (removed.length)
            await tx.tb_compra_item.updateMany({
                where: { compra_id: compraId, compra_item_id: { in: removed }, compra_item_ativo: 1 },
                data: { compra_item_ativo: 0, compra_item_excluido_em: new Date() },
            });
        const added = identified.filter(item => item.itemId === undefined);
        if (added.length > 0) {
            await tx.tb_compra_item.createMany({
                data: added.map((item) => ({
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
            // A avaliação central grava o estado final depois que a compra está persistida.
            compra_acima_limite: null,
            compra_usuario_concorda: compraUsuarioConcorda,
            compra_usuario_anotacao: compraUsuarioAnotacao,
        },
    });
    const campos = [
        ...(Number(compraValor) !== Number(existing.compra_valor) || (compraValor === null) !== (existing.compra_valor === null) ? ['valor'] : []),
        ...(compraHorario.getTime() !== existing.compra_horario.getTime() ? ['data'] : []),
        ...(compraFonte !== existing.compra_fonte ? ['estabelecimento'] : []),
        ...(formaPagamentoId !== existing.forma_pagamento_id ? ['pagamento'] : []),
        ...(compraUsuarioAnotacao !== existing.compra_usuario_anotacao ? ['anotacao'] : []),
    ];
    if (campos.length)
        await registrarEventoInterno(tx, userId, compraId, 'COMPRA_EDITADA', { campos });
    return { compra, compraHorario, compraValor };
}
/**
 * Marca uma compra e seus itens ativos como excluídos logicamente.
 *
 * A função é compartilhada pelo DELETE da compra e pelo caso em que o último
 * item é removido. Assim, ambas as entradas preservam os registros, gravam o
 * mesmo instante de exclusão e recalculam métricas de forma consistente.
 */
export async function softDeleteCompra(tx, userId, compraId, auditar = true) {
    await bloquearCompra(tx, userId, compraId);
    // A combinação do ID com o usuário e com compra_ativo impede operar sobre
    // compra de terceiro ou sobre compra já excluída, sem revelar sua existência.
    const existing = await tx.tb_compra.findFirst({
        where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
        select: { compra_id: true, compra_horario: true, compra_status: true },
    });
    if (!existing)
        throw new AppError('Compra não encontrada', 404);
    const excludedAt = new Date();
    if (auditar)
        await registrarEventoInterno(tx, userId, compraId, 'EXCLUSAO_REGISTRO', { motivo: 'NAO_INFORMADO' });
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
import { validarPeriodoConta } from './periodo-conta.js';
export class CompraService {
    static async historico(userId, query) {
        return prisma.$transaction(async (tx) => {
            const user = await tx.tb_usuario.findFirst({ where: { usuario_id: userId, usuario_status: true }, select: { usuario_data_criacao: true } });
            if (!user)
                throw new AppError('Usuário não encontrado', 404);
            validarPeriodoConta(query, user.usuario_data_criacao);
            let range;
            if (query.mes) {
                const bounds = parseMonth(query.mes);
                range = { gte: bounds.start, lt: bounds.end };
            }
            if (query.inicio && query.fim)
                range = {
                    gte: businessDayBounds(new Date(query.inicio + 'T12:00:00Z')).start,
                    lt: businessDayBounds(new Date(query.fim + 'T12:00:00Z')).end,
                };
            // Current-month queries and all-history reads stop at the same observed instant.
            const now = new Date();
            if (range)
                range.lt = new Date(Math.min(range.lt.getTime(), now.getTime()));
            else
                range = { lt: now };
            const cursor = query.antes === undefined ? null : await tx.tb_compra.findFirst({
                where: { usuario_id: userId, compra_id: query.antes }, select: { compra_horario: true, compra_id: true },
            });
            if (query.antes !== undefined && !cursor)
                throw new AppError('Página não disponível', 404);
            const rows = await tx.tb_compra.findMany({
                where: { usuario_id: userId, compra_ativo: 1,
                    ...(query.busca ? { compra_fonte: { contains: query.busca, mode: 'insensitive' } } : {}),
                    compra_status: query.status ?? { in: ['CONFIRMADA', 'AGUARDANDO_CONFIRMACAO', 'IGNORADA'] },
                    ...(range ? { compra_horario: range } : {}),
                    ...(cursor ? { OR: [{ compra_horario: { lt: cursor.compra_horario } },
                            { compra_horario: cursor.compra_horario, compra_id: { lt: cursor.compra_id } }] } : {}), }, select: publicPurchaseSelect, orderBy: [{ compra_horario: 'desc' }, { compra_id: 'desc' }], take: 51,
            });
            const compras = rows.slice(0, 50);
            return { compras, proximoCursor: rows.length > 50 ? compras[49].compra_id : null };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    }
    /**
     * Cria uma compra cadastrada manualmente pelo usuário.
     *
     * A compra, seus itens e o recálculo das métricas são executados dentro
     * da mesma transação para evitar persistência parcial em caso de erro.
     */
    static async create(userId, data) {
        const transactionResult = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT usuario_id FROM public.tb_usuario WHERE usuario_id=${userId} FOR UPDATE`;
            const user = await tx.tb_usuario.findFirst({
                where: { usuario_id: userId, usuario_status: true },
                select: { usuario_id: true },
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
            const compraValor = resolveCompraValor(data.compraValor, items, null);
            if (compraValor === null) {
                throw new AppError('Compra manual sem valor não pode ser criada', 400);
            }
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
                    // A avaliação central grava o estado final antes do commit.
                    compra_acima_limite: null,
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
            await registrarClassificacao(tx, userId, compra.compra_id, data.compraClassificacao);
            const limitEvaluation = await evaluateConfirmedPurchaseLimits(compra.compra_id, tx);
            const compraFinal = limitEvaluation.eligible
                ? { ...compra, compra_acima_limite: limitEvaluation.purchaseAboveLimit }
                : compra;
            return {
                response: {
                    compra: compraFinal,
                    metricas: await MetricasService.recalculateMonthlyMetrics(userId, data.compraHorario, tx),
                },
                createdNotifications: createdPushNotifications(limitEvaluation),
            };
        });
        await dispatchPushAfterCommit(userId, transactionResult.createdNotifications);
        return transactionResult.response;
    }
    static async update(userId, compraId, data) {
        const transactionResult = await prisma.$transaction(async (tx) => {
            await bloquearCompra(tx, userId, compraId);
            const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 } });
            if (!existing)
                throw new AppError('Compra não encontrada', 404);
            const previousHorario = existing.compra_horario;
            const previousStatus = existing.compra_status;
            const previousClassificacao = existing.compra_classificacao;
            const result = await applyCompraConfirmation(tx, userId, compraId, data, existing);
            await validarSaldoAposEdicao(tx, userId, compraId, result.compraValor === null ? null : toCents(result.compraValor));
            if (data.compraClassificacao !== undefined && data.compraClassificacao !== previousClassificacao)
                await registrarClassificacao(tx, userId, compraId, data.compraClassificacao, true);
            let createdNotifications = [];
            if (previousStatus === 'CONFIRMADA' && result.compraValor === null) {
                throw new AppError('Compra confirmada deve possuir valor', 400);
            }
            if (previousStatus === 'CONFIRMADA') {
                const limitEvaluation = await evaluateConfirmedPurchaseLimits(compraId, tx);
                createdNotifications = createdPushNotifications(limitEvaluation);
                const metricPeriods = resolveMetricPeriods(previousHorario, result.compraHorario);
                for (const period of metricPeriods) {
                    await MetricasService.recalculateMonthlyMetrics(userId, period, tx);
                }
            }
            return {
                response: { compra: await tx.tb_compra.findFirst({ where: { compra_id: compraId } }) },
                createdNotifications,
            };
        });
        await dispatchPushAfterCommit(userId, transactionResult.createdNotifications);
        return transactionResult.response;
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
    static async confirm(userId, compraId, data) {
        const transactionResult = await prisma.$transaction(async (tx) => {
            await bloquearCompra(tx, userId, compraId);
            const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 } });
            if (!existing)
                throw new AppError('Compra não encontrada', 404);
            if (existing.compra_status === 'CONFIRMADA') {
                return { response: { compra: existing }, createdNotifications: [] };
            }
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
            await tx.tb_compra.update({
                where: { compra_id: compraId },
                data: { compra_status: 'CONFIRMADA' },
            });
            if (data?.compraClassificacao !== undefined &&
                data.compraClassificacao !== existing.compra_classificacao) {
                await registrarClassificacao(tx, userId, compraId, data.compraClassificacao, true);
            }
            const limitEvaluation = await evaluateConfirmedPurchaseLimits(compraId, tx);
            await MetricasService.recalculateMonthlyMetrics(userId, result.compraHorario, tx);
            const compraFinal = await tx.tb_compra.findFirst({ where: { compra_id: compraId } });
            return {
                response: { compra: compraFinal },
                createdNotifications: createdPushNotifications(limitEvaluation),
            };
        });
        await dispatchPushAfterCommit(userId, transactionResult.createdNotifications);
        return transactionResult.response;
    }
    /**
     * Marca como ignorada uma compra automática ainda pendente.
     *
     * O registro é preservado para manter a deduplicação baseada no messageId
     * e impedir que o mesmo e-mail volte a gerar uma nova compra.
     */
    static async ignore(userId, compraId) {
        return prisma.$transaction(async (tx) => {
            await bloquearCompra(tx, userId, compraId);
            const existing = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 } });
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
            select: publicPurchaseSelect,
            orderBy: { compra_horario: 'desc' },
        });
    }
    static async findPendingByUserId(userId) {
        return prisma.tb_compra.findMany({
            where: { usuario_id: userId, compra_status: 'AGUARDANDO_CONFIRMACAO', compra_ativo: 1 },
            select: publicPurchaseSelect,
            orderBy: { compra_horario: 'desc' },
        });
    }
    static async findById(userId, compraId) {
        const compra = await prisma.tb_compra.findFirst({
            where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
            select: publicPurchaseSelect,
        });
        if (!compra)
            throw new AppError('Compra não encontrada', 404);
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
    static async delete(userId, compraId) {
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
    static async deleteItem(userId, compraId, compraItemId, db) {
        const execute = async (tx) => {
            await bloquearCompra(tx, userId, compraId);
            // Combinar compra_id e usuario_id faz com que compras de terceiros sejam
            // tratadas como inexistentes, sem revelar sua existência ao solicitante.
            const existing = await tx.tb_compra.findFirst({
                where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
                select: { compra_id: true, compra_horario: true, compra_status: true, compra_desconto: true, compra_valor: true, compra_email: true },
            });
            if (!existing)
                throw new AppError('Compra não encontrada', 404);
            // O item precisa estar vinculado à compra informada; isso também evita
            // excluir item pertencente a outra compra do mesmo usuário.
            const item = await tx.tb_compra_item.findFirst({
                // Item inativo se comporta como inexistente para o usuário.
                where: { compra_item_id: compraItemId, compra_id: compraId, compra_item_ativo: 1 },
                select: { compra_item_id: true },
            });
            if (!item)
                throw new AppError('Item da compra não encontrado', 404);
            // A compra deve manter pelo menos um item após a operação.
            // A regra do último item considera apenas os itens ainda ativos.
            const itemCount = await tx.tb_compra_item.count({ where: { compra_id: compraId, compra_item_ativo: 1 } });
            if (itemCount === 1) {
                await validarSaldoAposEdicao(tx, userId, compraId, existing.compra_valor === null ? null : toCents(existing.compra_valor), compraItemId);
                // A exclusão do único item representa, para o usuário, a exclusão da
                // compra inteira. O front normalmente usa o DELETE da compra, mas este
                // caminho defensivo mantém a regra correta se a rota de item for chamada diretamente.
                await softDeleteCompra(tx, userId, compraId, !db);
                // Não existe compra atualizada para retornar depois da remoção total.
                return { response: null, createdNotifications: [] };
            }
            // Recalculamos o total somente com os itens restantes, usando centavos
            // para manter a mesma precisão monetária das demais operações do service.
            const activeItems = await tx.tb_compra_item.findMany({
                where: { compra_id: compraId, compra_item_ativo: 1 },
                select: { compra_item_id: true, compra_item_valor: true, compra_item_quantidade: true },
            });
            const remainingItems = activeItems.filter(item => item.compra_item_id !== compraItemId);
            if (existing.compra_email && remainingItems.some(item => item.compra_item_quantidade === null)) {
                throw new AppError('Quantidade não informada nos itens importados. Corrija os dados antes de recalcular o total', 409);
            }
            const itemTotals = remainingItems.map(item => itemTotalCents(item.compra_item_valor, item.compra_item_quantidade));
            if (itemTotals.some(total => total === null))
                throw new AppError('Dados insuficientes para recalcular o total dos itens', 409);
            const totalCents = itemTotals.reduce((sum, total) => sum + total, 0);
            // O valor armazenado e o total liquido: itens restantes menos o desconto
            // original, limitado a zero para impedir valores financeiros negativos.
            const descontoCents = Math.max(0, toCents(existing.compra_desconto ?? 0));
            const compraValor = fromCents(Math.max(0, totalCents - descontoCents));
            await validarSaldoAposEdicao(tx, userId, compraId, toCents(compraValor), compraItemId);
            await tx.tb_compra_item.update({
                where: { compra_item_id: compraItemId },
                data: { compra_item_ativo: 0, compra_item_excluido_em: new Date() },
            });
            if (!db)
                await registrarEventoInterno(tx, userId, compraId, 'EXCLUSAO_REGISTRO', { motivo: 'NAO_INFORMADO' }, compraItemId);
            // A avaliação central recalcula compra_acima_limite depois do novo total.
            await tx.tb_compra.update({
                where: { compra_id: compraId },
                data: { compra_valor: compraValor, compra_acima_limite: null },
            });
            // Somente compras confirmadas alteram as métricas financeiras mensais.
            let createdNotifications = [];
            if (existing.compra_status === 'CONFIRMADA') {
                const limitEvaluation = await evaluateConfirmedPurchaseLimits(compraId, tx);
                createdNotifications = createdPushNotifications(limitEvaluation);
                await MetricasService.recalculateMonthlyMetrics(userId, existing.compra_horario, tx);
            }
            // Retornamos a compra completa já atualizada para o front não precisar
            // fazer um GET adicional após cada exclusão individual.
            return {
                response: await tx.tb_compra.findFirst({
                    where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
                    select: publicPurchaseSelect,
                }),
                createdNotifications,
            };
        };
        const transactionResult = db ? await execute(db) : await prisma.$transaction(execute);
        if (!db)
            await dispatchPushAfterCommit(userId, transactionResult.createdNotifications);
        return transactionResult.response;
    }
}
