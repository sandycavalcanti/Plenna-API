import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { AppError } from '../../errors/AppError.js';
import { EmailClassificationEngine, buildClassificationHaystack, extractAmount, hasStrongPurchaseEvidence } from './classification.engine.js';
import { EmailService } from './email.service.js';
import { GeminiProvider } from './gemini.provider.js';
import { RequestyProvider } from './requesty.provider.js';
import { AIRateLimitError } from './ai-provider.js';
import { EmailPurchaseExtractor } from './email-purchase.extractor.js';
import { PaymentMethodResolver } from '../forma-pagamento/payment-method.resolver.js';
import { buildPurchaseUpdate, findReconciliationMatch } from './purchase-reconciliation.service.js';
import { buildNestedPurchaseItems, buildPersistedPurchaseItems, persistPurchaseItems, shouldPersistPurchaseItems } from './purchase-items.persistence.js';
/**
 * Monta a janela temporal utilizada na consulta ao Gmail.
 *
 * O limite inferior corresponde à última sincronização concluída com sucesso.
 * O limite superior é definido no início da execução e permanece apenas em
 * memória até que toda a janela seja processada corretamente.
 *
 * Se a execução falhar, o marcador salvo no banco não avança e a mesma
 * janela pode ser processada novamente sem perda de mensagens.
 */
export function buildGmailQuery(previousCursor, startedAt) {
    if (!previousCursor) {
        return `before:${Math.floor(startedAt.getTime() / 1000)}`;
    }
    return `after:${Math.floor(previousCursor.getTime() / 1000)} before:${Math.floor(startedAt.getTime() / 1000)}`;
}
/**
 * Resolve uma categoria sugerida contra as categorias já existentes no banco.
 *
 * Nenhuma categoria é criada automaticamente. Quando não há correspondência
 * segura, a propaganda permanece sem categoria.
 */
export async function resolveCategoryId(categoryName) {
    if (!categoryName)
        return null;
    const found = await prisma.tb_categoria.findFirst({
        where: { categoria_nome: { equals: categoryName, mode: 'insensitive' } },
        select: { categoria_id: true },
    });
    return found?.categoria_id ?? null;
}
/**
 * Converte a data de um message do Gmail para um objeto Date.
 *
 * A sincronização não deve inventar datas quando o Gmail não fornece um valor
 * interpretável, porque isso alteraria o cursor e a janela incremental.
 */
function parseDateFromMessage(message) {
    if (message.internalDate) {
        const parsed = new Date(Number(message.internalDate));
        if (!Number.isNaN(parsed.getTime()))
            return parsed;
    }
    if (message.date) {
        const parsed = new Date(message.date);
        if (!Number.isNaN(parsed.getTime()))
            return parsed;
    }
    return null;
}
/**
 * Converte erros para uma mensagem curta compatível com o campo de erro
 * da integração, evitando persistir stacks ou objetos completos.
 */
function safeErrorMessage(error) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido';
    return message.slice(0, 255);
}
function truncatePromptText(value, limit = 1200) {
    return (value ?? '').slice(0, limit);
}
function buildEvidenceText(message) {
    return buildClassificationHaystack(message);
}
function normalizeMoneyCandidates(amount) {
    const fixed = amount.toFixed(2);
    const ptBr = fixed.replace('.', ',');
    const thousands = amount >= 1000 ? new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) : null;
    return new Set([fixed, ptBr, `R$ ${ptBr}`, `R$ ${fixed}`, thousands ? `R$ ${thousands}` : null].filter((value) => Boolean(value)));
}
function aiAmountIsSupported(message, amount) {
    if (amount === null || amount === undefined || !Number.isFinite(amount) || amount <= 0)
        return null;
    const evidenceText = buildEvidenceText(message);
    const moneyFromText = extractAmount(evidenceText);
    if (moneyFromText === null)
        return null;
    const candidates = normalizeMoneyCandidates(amount);
    for (const candidate of candidates) {
        if (evidenceText.includes(candidate.toLowerCase())) {
            return amount;
        }
    }
    const normalizedEvidenceAmount = Number(moneyFromText.toFixed(2));
    if (Number.isFinite(normalizedEvidenceAmount) && Math.abs(normalizedEvidenceAmount - amount) < 0.01) {
        return amount;
    }
    return null;
}
function aiEstablishmentIsSupported(message, establishment) {
    if (!establishment)
        return null;
    const normalizedEstablishment = normalizeEstablishment(establishment);
    if (!normalizedEstablishment)
        return null;
    const evidenceText = buildEvidenceText(message);
    const tokens = normalizedEstablishment
        .split(/\s+/)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length >= 3);
    if (tokens.length === 0)
        return null;
    const matches = tokens.filter((token) => evidenceText.includes(token)).length;
    return matches > 0 ? normalizedEstablishment : null;
}
function sanitizeAiPurchase(message, purchase) {
    const supportedAmount = aiAmountIsSupported(message, purchase?.amount ?? null);
    const supportedEstablishment = aiEstablishmentIsSupported(message, purchase?.establishment ?? null);
    if (supportedAmount === null && supportedEstablishment === null && !hasStrongPurchaseEvidence(message)) {
        return null;
    }
    return {
        amount: supportedAmount,
        establishment: supportedEstablishment,
    };
}
export async function messageAlreadyPersisted(userId, messageId) {
    const [purchase, promotion] = await Promise.all([
        prisma.tb_compra.findFirst({
            where: {
                usuario_id: userId,
                compra_email_mensagem_id: messageId,
            },
            select: { compra_id: true },
        }),
        prisma.tb_propaganda.findFirst({
            where: {
                usuario_id: userId,
                propaganda_email_mensagem_id: messageId,
            },
            select: { propaganda_id: true },
        }),
    ]);
    return Boolean(purchase || promotion);
}
function toNormalizedEmail(message) {
    return {
        id: message.id,
        threadId: message.threadId ?? null,
        subject: message.subject ?? null,
        from: message.from ?? null,
        to: message.to ?? null,
        snippet: message.snippet ?? null,
        internalDate: message.internalDate ?? null,
        labelIds: message.labelIds ?? [],
        textBody: message.textBody ?? message.bodyText ?? null,
        htmlBody: message.htmlBody ?? null,
        links: message.links ?? [],
        attachments: message.attachments ?? [],
    };
}
function buildExtractedPurchase(message, supplemental) {
    const deterministic = EmailPurchaseExtractor.extract(toNormalizedEmail(message));
    return {
        ...deterministic,
        establishment: deterministic.establishment ?? supplemental?.establishment ?? null,
        totalAmount: deterministic.totalAmount ?? supplemental?.amount ?? null,
        paymentMethod: {
            rawName: deterministic.paymentMethod.rawName ?? supplemental?.paymentMethodName ?? null,
        },
    };
}
async function resolveExistingPurchase(userId, message, extracted, paymentMethodId) {
    const messageDate = parseDateFromMessage(message);
    if (!messageDate || !extracted.establishment || (extracted.orderNumber === null && extracted.totalAmount === null))
        return null;
    const candidates = await prisma.tb_compra.findMany({
        where: { usuario_id: userId },
        select: {
            compra_id: true,
            usuario_id: true,
            compra_fonte: true,
            compra_pedido_externo_id: true,
            compra_valor: true,
            forma_pagamento_id: true,
            compra_email_mensagem_id: true,
            compra_horario: true,
            tb_compra_item: {
                select: {
                    compra_item_nome: true,
                    compra_item_quantidade: true,
                    compra_item_valor: true,
                },
            },
        },
    });
    const match = findReconciliationMatch(candidates, userId, extracted, messageDate, env.emailPurchaseReconciliationWindowHours);
    if (!match)
        return null;
    const update = buildPurchaseUpdate(match.purchase, extracted, paymentMethodId);
    const candidateItems = await buildPersistedPurchaseItems(extracted.items, prisma);
    const itemsToPersist = shouldPersistPurchaseItems(match.purchase.tb_compra_item.length, candidateItems)
        ? candidateItems
        : [];
    if (Object.keys(update).length === 0 && itemsToPersist.length === 0)
        return { reconciled: match.purchase };
    const updated = await prisma.$transaction(async (tx) => {
        const purchase = Object.keys(update).length > 0
            ? await tx.tb_compra.update({ where: { compra_id: match.purchase.compra_id }, data: update })
            : match.purchase;
        if (itemsToPersist.length > 0) {
            await persistPurchaseItems(match.purchase.compra_id, itemsToPersist, tx);
        }
        return purchase;
    });
    return { reconciled: updated };
}
async function createCompraFromMessage(userId, message, supplemental = {}) {
    const extracted = buildExtractedPurchase(message, supplemental);
    const horario = parseDateFromMessage(message);
    if (!horario) {
        throw new Error('Data inválida no e-mail');
    }
    const establishment = normalizeEstablishment(extracted.establishment);
    const amount = extracted.totalAmount;
    const paymentMethod = extracted.paymentMethod.rawName
        ? await PaymentMethodResolver.resolve(extracted.paymentMethod.rawName)
        : null;
    const existing = await resolveExistingPurchase(userId, message, extracted, paymentMethod?.id ?? null);
    if (existing)
        return existing;
    const persistedItems = await buildPersistedPurchaseItems(extracted.items, prisma);
    try {
        const compra = await prisma.tb_compra.create({
            data: {
                usuario_id: userId,
                forma_pagamento_id: paymentMethod?.id ?? null,
                compra_valor: amount !== null ? new Prisma.Decimal(amount.toFixed(2)) : null,
                compra_horario: horario,
                compra_fonte: establishment,
                compra_email: true,
                compra_classificacao: 'PENDENTE',
                compra_acima_limite: null,
                compra_email_mensagem_id: message.id,
                compra_pedido_externo_id: extracted.orderNumber,
                compra_status: 'AGUARDANDO_CONFIRMACAO',
                ...(persistedItems.length > 0 ? { tb_compra_item: { create: buildNestedPurchaseItems(persistedItems) } } : {}),
            },
        });
        return { created: compra };
    }
    catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return { skipped: true };
        }
        throw error;
    }
}
async function createPropagandaFromMessage(userId, message, categoryId) {
    const horario = parseDateFromMessage(message);
    if (!horario) {
        throw new Error('Data inválida no e-mail');
    }
    try {
        const propaganda = await prisma.tb_propaganda.create({
            data: {
                usuario_id: userId,
                categoria_id: categoryId,
                propaganda_email_mensagem_id: message.id,
                propaganda_remetente: message.from ?? null,
                propaganda_assunto: message.subject ?? null,
                propaganda_estabelecimento: null,
                propaganda_data_recebimento: horario,
            },
        });
        return { created: propaganda };
    }
    catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return { skipped: true };
        }
        throw error;
    }
}
function buildEmailClassificationPrompt(message) {
    return [
        'Classifique a mensagem abaixo em JSON estrito.',
        'Campos permitidos: classificacao, categoryName, purchase.',
        'classificacao aceita COMPRA, PROPAGANDA ou IGNORAR.',
        'Classifique como COMPRA somente quando houver evidência textual de transação já concluída.',
        'Preço, oferta, desconto ou linguagem promocional isolados não significam COMPRA.',
        'Quando não houver evidência suficiente, prefira null.',
        'Se houver dados seguros de compra, inclua purchase.amount, purchase.establishment e purchase.paymentMethodName apenas quando estiverem sustentados pelo conteúdo.',
        `subject: ${message.subject ?? ''}`,
        `from: ${message.from ?? ''}`,
        `snippet: ${message.snippet ?? ''}`,
        `bodyText: ${truncatePromptText(message.bodyText)}`,
    ].join('\n');
}
function buildCategoryPrompt(message) {
    return [
        'Sugira apenas um nome de categoria existente ou null em JSON estrito.',
        'Use a categoria mais provavel e conservadora.',
        `subject: ${message.subject ?? ''}`,
        `from: ${message.from ?? ''}`,
        `snippet: ${message.snippet ?? ''}`,
        `bodyText: ${truncatePromptText(message.bodyText)}`,
    ].join('\n');
}
async function resolvePropagationCategory(aiProvider, message) {
    if (!aiProvider)
        return null;
    try {
        const aiSuggestion = await aiProvider.suggestCategory(buildCategoryPrompt(message));
        return resolveCategoryId(aiSuggestion.categoryName ?? null);
    }
    catch {
        return null;
    }
}
/**
 * Normaliza o estabelecimento extraído do e-mail para o limite aceito
 * pelo campo compra_fonte no banco.
 */
function normalizeEstablishment(value) {
    if (!value)
        return null;
    const normalized = value
        .replace(/<[^>]+>/g, '')
        .replace(/^["']|["']$/g, '')
        .trim();
    return normalized ? normalized.slice(0, 45) : null;
}
export class EmailSyncService {
    /**
     * Tenta adquirir atomicamente o lock lógico da integração.
     *
     * A condição do status é avaliada pelo próprio banco durante o UPDATE.
     * Assim, duas execuções concorrentes não conseguem iniciar a sincronização
     * da mesma integração ao mesmo tempo.
     *
     * A abordagem evita o padrão SELECT -> UPDATE, que permitiria race condition
     * entre sincronizações manuais e automáticas.
     */
    static async acquireLock(integrationId) {
        const acquired = await prisma.tb_integracao.updateMany({
            where: {
                integracao_id: integrationId,
                integracao_sincronizacao_status: { not: 'PROCESSANDO' },
            },
            data: {
                integracao_sincronizacao_status: 'PROCESSANDO',
                integracao_ultimo_erro: null,
            },
        });
        if (acquired.count === 0) {
            return { acquired: false, reason: 'JA_EM_ANDAMENTO' };
        }
        return { acquired: true };
    }
    /**
     * Executa a sincronização Gmail de um único usuário.
     *
     * Fluxo principal:
     * 1. localiza a integração Gmail;
     * 2. adquire o lock lógico;
     * 3. define a janela temporal da execução;
     * 4. obtém um access token válido;
     * 5. busca e classifica as mensagens;
     * 6. persiste compras e propagandas relevantes;
     * 7. avança o marcador temporal somente após sucesso completo da janela.
     *
     * Casos ambíguos dependentes de IA que não puderem ser resolvidos fazem a
     * execução terminar em erro sem avançar o timestamp. A próxima execução relê
     * a janela, enquanto as constraints únicas impedem registros duplicados.
     */
    static async syncUser(userId) {
        const integration = await EmailService.findIntegrationByUserId(userId);
        if (!integration) {
            throw new AppError('Integração Gmail não encontrada', 404);
        }
        const lock = await this.acquireLock(integration.integracao_id);
        if (!lock.acquired) {
            return { processed: 0, created: 0, skipped: 0, status: 'JA_EM_ANDAMENTO' };
        }
        const startedAt = new Date();
        const previousCursor = integration.integracao_ultima_sincronizacao_em;
        const query = buildGmailQuery(previousCursor, startedAt);
        const isBootstrap = previousCursor === null;
        const executionLimit = isBootstrap ? env.emailSyncInitialMessages : env.emailSyncMaxMessagesPerRun;
        try {
            const accessToken = await EmailService.getValidAccessToken(integration);
            const messages = await EmailService.listMessages(accessToken, query, env.emailSyncBatchSize, isBootstrap ? env.emailSyncInitialMessages : undefined);
            const aiProvider = env.requestyApiKey
                ? new RequestyProvider()
                : env.geminiApiKey
                    ? new GeminiProvider()
                    : null;
            const result = { processed: 0, created: 0, skipped: 0 };
            let shouldFailRun = false;
            let failureReason = null;
            for (const summary of messages) {
                if (result.processed >= executionLimit) {
                    shouldFailRun = true;
                    failureReason = `Limite de ${executionLimit} mensagens por execução atingido`;
                    break;
                }
                if (await messageAlreadyPersisted(userId, summary.id)) {
                    result.skipped += 1;
                    continue;
                }
                result.processed += 1;
                const detail = await EmailService.getMessage(accessToken, summary.id);
                const classification = EmailClassificationEngine.classify(detail);
                if (classification.outcome === 'COMPRA') {
                    const purchaseResult = await createCompraFromMessage(userId, detail, classification.purchase);
                    if ('created' in purchaseResult)
                        result.created += 1;
                    else
                        result.skipped += 1;
                    continue;
                }
                if (classification.outcome === 'PROPAGANDA') {
                    let categoryId = await resolveCategoryId(classification.categoryName ?? null);
                    if (categoryId === null && aiProvider) {
                        categoryId = await resolvePropagationCategory(aiProvider, detail);
                    }
                    const promoResult = await createPropagandaFromMessage(userId, detail, categoryId);
                    if ('created' in promoResult)
                        result.created += 1;
                    else
                        result.skipped += 1;
                    continue;
                }
                if (classification.outcome === 'AMBIGUA') {
                    if (!aiProvider) {
                        shouldFailRun = true;
                        failureReason = 'IA indisponível para classificar mensagem ambígua';
                        continue;
                    }
                    try {
                        const aiResult = await aiProvider.classifyEmail(buildEmailClassificationPrompt(detail));
                        if (aiResult.classificacao === 'COMPRA') {
                            const sanitizedPurchase = sanitizeAiPurchase(detail, aiResult.purchase);
                            if (!sanitizedPurchase) {
                                result.skipped += 1;
                                continue;
                            }
                            const purchaseResult = await createCompraFromMessage(userId, detail, sanitizedPurchase);
                            if ('created' in purchaseResult)
                                result.created += 1;
                            else
                                result.skipped += 1;
                            continue;
                        }
                        if (aiResult.classificacao === 'PROPAGANDA') {
                            let categoryId = await resolveCategoryId(aiResult.categoryName ?? null);
                            if (categoryId === null) {
                                categoryId = await resolvePropagationCategory(aiProvider, detail);
                            }
                            const promoResult = await createPropagandaFromMessage(userId, detail, categoryId);
                            if ('created' in promoResult)
                                result.created += 1;
                            else
                                result.skipped += 1;
                            continue;
                        }
                        continue;
                    }
                    catch (error) {
                        if (error instanceof AIRateLimitError) {
                            shouldFailRun = true;
                            failureReason = error.message;
                            break;
                        }
                        shouldFailRun = true;
                        failureReason = safeErrorMessage(error);
                    }
                }
            }
            if (shouldFailRun) {
                throw new AppError(failureReason ?? 'Falha na classificação por IA', 500);
            }
            await prisma.tb_integracao.update({
                where: { integracao_id: integration.integracao_id },
                data: {
                    integracao_ultima_sincronizacao_em: startedAt,
                    integracao_sincronizacao_status: 'FINALIZADA',
                    integracao_ultimo_erro: null,
                },
            });
            return result;
        }
        catch (error) {
            console.error('[EmailSyncService.syncUser] Falha na sincronização Gmail:', safeErrorMessage(error));
            await prisma.tb_integracao.update({
                where: { integracao_id: integration.integracao_id },
                data: {
                    integracao_sincronizacao_status: 'ERRO',
                    integracao_ultimo_erro: safeErrorMessage(error),
                },
            });
            throw error;
        }
    }
    static async syncAllUsers() {
        if (!env.emailSyncEnabled) {
            return { processedUsers: 0, lockedUsers: 0, failedUsers: 0 };
        }
        const integrations = await prisma.tb_integracao.findMany({
            where: { integracao_provedor: 'GMAIL' },
            orderBy: { integracao_data_criacao: 'desc' },
            take: env.emailSyncMaxUsersPerRun,
            distinct: ['usuario_id'],
            select: { usuario_id: true },
        });
        let processedUsers = 0;
        let lockedUsers = 0;
        let failedUsers = 0;
        for (const integration of integrations) {
            try {
                const result = (await this.syncUser(integration.usuario_id));
                if (result.status === 'JA_EM_ANDAMENTO') {
                    lockedUsers += 1;
                    continue;
                }
                processedUsers += 1;
            }
            catch {
                failedUsers += 1;
                continue;
            }
        }
        return { processedUsers, lockedUsers, failedUsers };
    }
}
