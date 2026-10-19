import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { AppError } from '../../errors/AppError.js';
import { EmailClassificationEngine, buildClassificationHaystack, extractAmount, hasStrongPurchaseEvidence } from './classification.engine.js';
import { EmailService } from './email.service.js';
import type { GmailMessageDetail, GmailMessageQueryResult } from './gmail.types.js';
import { AIRateLimitError, type AIProvider } from './ai-provider.js';
import { createAIProvider } from './ai-provider.factory.js';
import type { ExtractedPurchase, ExtractedPurchaseItem, NormalizedEmail } from './email-contracts.js';
import { EmailPurchaseExtractor } from './email-purchase.extractor.js';
import { PaymentMethodResolver } from '../forma-pagamento/payment-method.resolver.js';
import { buildPurchaseUpdate, findReconciliationMatch, type ReconciliationPurchase } from './purchase-reconciliation.service.js';
import { buildNestedPurchaseItems, buildPersistedPurchaseItems, isPersistablePurchaseItem, persistPurchaseItems, shouldPersistPurchaseItems } from './purchase-items.persistence.js';
import { buildPurchaseExtractionPrompt, buildPurchaseEvidenceText, isPositivePurchaseComponent, needsAiEnrichment, normalizePositiveComponentPrices, normalizePurchaseItemPrices, reconcilePurchaseTotal, resolveSafeSingleItemPrice } from './email-purchase.enrichment.js';
import { parseFiscalAttachments, mergePurchaseSources, type FiscalSourceResults } from './purchase-source.merge.js';
import { processFiscalLinks } from './fiscal-link.processor.js';
import type { AIPurchaseExtractionProvider, AIExtractedPurchase, AICategoryOption } from './ai-provider.js';
import { MetricasService } from '../compra/metricas.service.js';
import { evaluateConfirmedPurchaseLimits } from '../compra/limite.service.js';
import { dispatchPushAfterCommit, type PushNotificationCandidate } from '../notification/push.service.js';

function createdPushNotifications(evaluation: { alerts?: Array<{ created: boolean; notificationId: number; type: string }> } | undefined): PushNotificationCandidate[] {
  return (evaluation?.alerts ?? [])
    .filter((alert) => alert.created)
    .map((alert) => ({ notificationId: alert.notificationId, type: alert.type }));
}
/**
 * Resultado da tentativa de adquirir o lock lógico da sincronização.
 */
export type SyncAcquireResult =
  | { acquired: true }
  | { acquired: false; reason: 'JA_EM_ANDAMENTO' };

type SyncUserResult =
  | { status: 'FINALIZADA'; processed: number; created: number; skipped: number }
  | { status: 'JA_EM_ANDAMENTO'; processed: 0; created: 0; skipped: 0 };
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
export function buildGmailQuery(previousCursor: Date | null, startedAt: Date) {
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
/** Carrega IDs reais por execução; IDs não são hardcoded nem inferidos por nome. */
async function loadPropagationCategories(): Promise<AICategoryOption[]> {
  const categories = await prisma.tb_categoria.findMany({
    select: { categoria_id: true, categoria_nome: true },
    orderBy: { categoria_id: 'asc' },
  });
  return categories.map((category) => ({ categoryId: category.categoria_id, categoryName: category.categoria_nome }));
}

/** Validação defensiva: a IA só pode escolher um ID da lista carregada. */
export function validatePropagationCategoryId(categoryId: number | null | undefined, categories: AICategoryOption[]) {
  if (categoryId === null || categoryId === undefined) return null;
  if (!categories.some((category) => category.categoryId === categoryId)) {
    console.warn('[EmailSyncService] categoryId inválido normalizado para null');
    return null;
  }
  return categoryId;
}

/**
 * Converte a data de um message do Gmail para um objeto Date.
 *
 * A sincronização não deve inventar datas quando o Gmail não fornece um valor
 * interpretável, porque isso alteraria o cursor e a janela incremental.
 */
function parseDateFromMessage(message: GmailMessageDetail) {
  if (message.internalDate) {
    const parsed = new Date(Number(message.internalDate));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  if (message.date) {
    const parsed = new Date(message.date);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}
/**
 * Converte erros para uma mensagem curta compatível com o campo de erro
 * da integração, evitando persistir stacks ou objetos completos.
 */
function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : 'Erro desconhecido';
  return message.slice(0, 255);
}

function logSyncErrorDiagnostic(error: unknown) {
  const axiosError = error as {
    name?: string;
    message?: string;
    code?: string;
    response?: { status?: number; data?: unknown };
    config?: { method?: string; url?: string; params?: Record<string, unknown> };
  };
  const responseData = axiosError.response?.data as {
    error?: string | { code?: number; message?: string; status?: string };
    error_description?: string;
  } | undefined;
  const nestedGoogleError = typeof responseData?.error === 'object' && responseData.error !== null
    ? responseData.error
    : undefined;

  console.error('[EmailSyncService] sync error diagnostic', {
    name: axiosError.name,
    message: axiosError.message,
    code: axiosError.code,
    responseStatus: axiosError.response?.status,
    responseData: {
      oauthError: typeof responseData?.error === 'string' ? responseData.error : undefined,
      oauthErrorDescription: responseData?.error_description,
      googleCode: nestedGoogleError?.code,
      googleStatus: nestedGoogleError?.status,
      googleMessage: nestedGoogleError?.message,
    },
    method: axiosError.config?.method,
    url: axiosError.config?.url,
    params: axiosError.config?.params,
  });
}

function truncatePromptText(value: string | null | undefined, limit = 1200) {
  return (value ?? '').slice(0, limit);
}

function buildEvidenceText(message: GmailMessageDetail) {
  return buildClassificationHaystack(message);
}

function normalizeMoneyCandidates(amount: number) {
  const fixed = amount.toFixed(2);
  const ptBr = fixed.replace('.', ',');
  const thousands = amount >= 1000 ? new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) : null;
  return new Set([fixed, ptBr, `R$ ${ptBr}`, `R$ ${fixed}`, thousands ? `R$ ${thousands}` : null].filter((value): value is string => Boolean(value)));
}

function aiAmountIsSupported(message: GmailMessageDetail, amount: number | null | undefined) {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || amount <= 0) return null;
  const evidenceText = buildEvidenceText(message);
  const moneyFromText = extractAmount(evidenceText);
  if (moneyFromText === null) return null;

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

function aiEstablishmentIsSupported(message: GmailMessageDetail, establishment: string | null | undefined) {
  if (!establishment) return null;

  const normalizedEstablishment = normalizeEstablishment(establishment);
  if (!normalizedEstablishment) return null;

  const evidenceText = buildEvidenceText(message);
  const tokens = normalizedEstablishment
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 3);

  if (tokens.length === 0) return null;

  const matches = tokens.filter((token) => evidenceText.includes(token)).length;
  return matches > 0 ? normalizedEstablishment : null;
}

function sanitizeAiPurchase(message: GmailMessageDetail, purchase?: { amount?: number | null; establishment?: string | null } | null) {
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

export async function messageAlreadyPersisted(userId: number, messageId: string) {
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

function toNormalizedEmail(message: GmailMessageDetail): NormalizedEmail {
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

function buildExtractedPurchase(message: GmailMessageDetail, supplemental?: { amount?: number | null; establishment?: string | null; paymentMethodName?: string | null } | null): ExtractedPurchase {
  const deterministic = EmailPurchaseExtractor.extract(toNormalizedEmail(message));
  const totalAmount = deterministic.totalAmount ?? supplemental?.amount ?? null;
  const totalAmountSource = deterministic.totalAmount !== null
    ? deterministic.totalAmountSource ?? 'DETERMINISTIC_SEMANTIC'
    : supplemental?.amount !== null && supplemental?.amount !== undefined
      ? 'CLASSIFICATION_FALLBACK'
      : null;
  return {
    ...deterministic,
    establishment: deterministic.establishment ?? supplemental?.establishment ?? null,
    totalAmount,
    totalAmountSource,
    paymentMethod: {
      rawName: deterministic.paymentMethod.rawName ?? supplemental?.paymentMethodName ?? null,
    },
  };
}

/** Normaliza o desconto para a coluna obrigatoria, sem persistir lixo numerico. */
function normalizePurchaseDiscount(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? new Prisma.Decimal(value.toFixed(2))
    : new Prisma.Decimal(0);
}

export function testMarkerFromMessage(message: GmailMessageDetail) {
  const subject = message.subject ?? '';
  const match = subject.match(/^\[PLENNA TEST\s+(?:(HTML-\d+)|(\d{1,3}))\]/i);
  if (!match) return null;

  // O marcador serve somente para observabilidade dos fixtures, sem influenciar
  // qualquer decisão de classificação, extração ou persistência.
  if (match[1]) return match[1].toUpperCase();
  return `HTML-${match[2].padStart(3, '0')}`;
}

function testItemDiagnostic(item: Pick<ExtractedPurchaseItem, 'name' | 'quantity' | 'unitPrice' | 'totalPrice' | 'categoryName'>, source: 'DETERMINISTIC' | 'AI' | 'MERGED') {
  const role = isPositivePurchaseComponent({ ...item, unit: null }) ? 'COMPONENT' : 'MAIN';
  return {
    source,
    role,
    hasName: Boolean(item.name?.trim()),
    hasQuantity: item.quantity !== null && item.quantity !== undefined,
    hasUnitPrice: item.unitPrice !== null && item.unitPrice !== undefined,
    hasTotalPrice: item.totalPrice !== null && item.totalPrice !== undefined,
    persistable: Boolean(item.name?.trim()) && item.unitPrice !== null && Number.isFinite(item.unitPrice) && item.unitPrice > 0,
  };
}

function logTestPurchaseDiagnostics(
  message: GmailMessageDetail,
  deterministic: ExtractedPurchase,
  aiPurchase: AIExtractedPurchase | null,
  extracted: ExtractedPurchase,
  fiscal: FiscalSourceResults,
) {
  const testMarker = testMarkerFromMessage(message);
  if (!testMarker) return;

  console.info('[TestPurchaseTotals]', {
    testMarker,
    deterministicSemanticTotalFound: deterministic.totalAmountSource === 'DETERMINISTIC_SEMANTIC',
    classificationFallbackTotalUsed: deterministic.totalAmountSource === 'CLASSIFICATION_FALLBACK',
    aiTotalFound: aiPurchase?.totalAmount !== null && aiPurchase?.totalAmount !== undefined,
    fiscalTotalFound: fiscal.nfe.some((source) => source.totalAmount !== null && source.totalAmount !== undefined)
      || fiscal.danfe.some((source) => source.totalAmount !== null && source.totalAmount !== undefined),
    finalTotalSource: extracted.totalAmountSource ?? 'NONE',
  });
  console.info('[TestPurchaseItems]', {
    testMarker,
    deterministicItems: deterministic.items.map((item) => testItemDiagnostic(item, 'DETERMINISTIC')),
    aiItems: (aiPurchase?.items ?? []).map((item) => testItemDiagnostic(item, 'AI')),
    mergedItems: extracted.items.map((item) => testItemDiagnostic(item, 'MERGED')),
  });
}

function logTestEmailFlow(message: GmailMessageDetail, values: Record<string, unknown>) {
  const testMarker = testMarkerFromMessage(message);
  if (!testMarker) return;
  console.info('[TestEmailFlow]', { testMarker, ...values });
}

/**
 * Obtém o estabelecimento de uma propaganda sem depender de IA.
 * O display name do remetente é a evidência principal; o domínio só é usado
 * quando oferece um rótulo organizacional claro, evitando expor dados do email.
 */
export function extractPropagandaEstablishment(from: string | null | undefined) {
  if (!from?.trim()) return null;

  const displayMatch = from.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^<]+?))\s*<[^>]+>\s*$/);
  const displayName = displayMatch?.[1] ?? displayMatch?.[2] ?? displayMatch?.[3];
  if (displayName?.trim()) return displayName.trim();

  const emailMatch = from.match(/^\s*[^@\s<>]+@([^\s<>]+)\s*$/);
  const host = emailMatch?.[1]?.toLowerCase().replace(/\.$/, '');
  if (!host || !host.includes('.')) return null;

  const genericSuffixes = new Set(['com', 'net', 'org', 'edu', 'gov', 'com.br', 'net.br', 'org.br', 'edu.br', 'gov.br', 'co.uk']);
  const parts = host.split('.').filter(Boolean);
  const suffixLength = parts.length >= 2 && genericSuffixes.has(parts.slice(-2).join('.')) ? 2 : 1;
  const candidate = parts[parts.length - suffixLength - 1];
  const technicalLabels = new Set(['www', 'mail', 'email', 'smtp', 'noreply', 'no-reply', 'info', 'support', 'notify', 'notifications', 'marketing', 'students']);
  if (!candidate || candidate.length < 2 || technicalLabels.has(candidate)) return null;

  return candidate.toUpperCase();
}

async function resolveExistingPurchase(userId: number, message: GmailMessageDetail, extracted: ExtractedPurchase, paymentMethodId: number | null) {
  const messageDate = parseDateFromMessage(message);
  if (!messageDate || !extracted.establishment || (extracted.orderNumber === null && extracted.totalAmount === null)) return null;

  const candidates = await prisma.tb_compra.findMany({
    // Compras inativas não podem ser reativadas por reconciliação automática.
    // A deduplicação por messageId continua sendo feita separadamente acima.
    where: { usuario_id: userId, compra_ativo: 1 },
    select: {
      compra_id: true,
      usuario_id: true,
      compra_fonte: true,
      compra_pedido_externo_id: true,
      compra_valor: true,
      compra_acima_limite: true,
      compra_status: true,
      compra_desconto: true,
      forma_pagamento_id: true,
      compra_email_mensagem_id: true,
      compra_horario: true,
      tb_compra_item: {
        where: { compra_item_ativo: 1 },
        select: {
          compra_item_nome: true,
          compra_item_quantidade: true,
          compra_item_valor: true,
        },
      },
    },
  });

  const match = findReconciliationMatch(candidates as ReconciliationPurchase[], userId, extracted, messageDate, env.emailPurchaseReconciliationWindowHours);
  if (!match) return null;

  const update = buildPurchaseUpdate(match.purchase, extracted, paymentMethodId);
  const candidateItems = await buildPersistedPurchaseItems(extracted.items, prisma);
  const itemsToPersist = shouldPersistPurchaseItems(match.purchase.tb_compra_item.length, candidateItems)
    ? candidateItems
    : [];
  if (Object.keys(update).length === 0 && itemsToPersist.length === 0 && match.purchase.compra_status !== 'CONFIRMADA') {
    return { reconciled: match.purchase };
  }

  const transactionResult = await prisma.$transaction(async (tx) => {
    const purchase = Object.keys(update).length > 0
      ? await tx.tb_compra.update({ where: { compra_id: match.purchase.compra_id }, data: update })
      : match.purchase;
    if (itemsToPersist.length > 0) {
      await persistPurchaseItems(match.purchase.compra_id, itemsToPersist, tx);
    }
    if (match.purchase.compra_status === 'CONFIRMADA') {
      const limitEvaluation = await evaluateConfirmedPurchaseLimits(match.purchase.compra_id, tx);
      await MetricasService.recalculateMonthlyMetrics(userId, match.purchase.compra_horario, tx);
      return {
        purchase: {
          ...purchase,
          compra_acima_limite: limitEvaluation.eligible ? limitEvaluation.purchaseAboveLimit : null,
        },
        createdNotifications: createdPushNotifications(limitEvaluation),
      };
    }
    return { purchase, createdNotifications: [] as PushNotificationCandidate[] };
  });
  await dispatchPushAfterCommit(userId, transactionResult.createdNotifications);
  return { reconciled: transactionResult.purchase };
}

export async function createCompraFromMessage(
  userId: number,
  message: GmailMessageDetail,
  supplemental: { amount?: number | null; establishment?: string | null; paymentMethodName?: string | null } | null = {},
  accessToken?: string,
  aiProvider?: AIProvider | null,
  classificationPath: 'DETERMINISTIC_COMPRA' | 'AI_COMPRA' = 'DETERMINISTIC_COMPRA',
) {
  const normalizedEmail = toNormalizedEmail(message);
  const deterministic = buildExtractedPurchase(message, supplemental);
  let aiPurchase: AIExtractedPurchase | null = null;
  let aiAttempted = false;
  const extractor = aiProvider && 'extractPurchase' in aiProvider
    ? aiProvider as AIProvider & AIPurchaseExtractionProvider
    : null;
  if (extractor && needsAiEnrichment(deterministic)) {
    aiAttempted = true;
    try {
      aiPurchase = await extractor.extractPurchase(buildPurchaseExtractionPrompt(normalizedEmail));
    } catch {
      aiPurchase = null;
    }
  }

  const attachmentFiscal = accessToken
    ? await parseFiscalAttachments(message.attachments ?? [], (metadata) => EmailService.downloadAttachment(accessToken, message.id, metadata))
    : { nfe: [], danfe: [] };
  // Links externos sao enriquecimento opt-in; com a flag desligada nenhum DNS
  // e nenhuma URL do email sao acessados, preservando o fluxo anterior.
  const linkFiscal = env.emailFiscalLinkFetchEnabled
    ? await processFiscalLinks(message.links ?? [])
    : { nfe: [], danfe: [] };
  const fiscal = {
    nfe: [...attachmentFiscal.nfe, ...linkFiscal.nfe],
    danfe: [...attachmentFiscal.danfe, ...linkFiscal.danfe],
  };
  const merged = mergePurchaseSources(deterministic, aiPurchase, fiscal, buildPurchaseEvidenceText(normalizedEmail));
  const beforeSingleItemResolution = {
    // Diagnostico sanitizado: registra somente presenca de campos, nunca dados do email.
    itemHasName: Boolean(merged.items[0]?.name?.trim()),
    itemHasQuantity: merged.items[0]?.quantity !== null && merged.items[0]?.quantity !== undefined,
    itemHasUnitPrice: merged.items[0]?.unitPrice !== null && merged.items[0]?.unitPrice !== undefined,
    itemHasTotalPrice: merged.items[0]?.totalPrice !== null && merged.items[0]?.totalPrice !== undefined,
  };
  // A decisão final usa todas as fontes; o item único só é completado quando
  // o texto sustenta o nome e o total sem sinais de valores compostos.
  const evidenceText = buildPurchaseEvidenceText(normalizedEmail);
  const extracted = resolveSafeSingleItemPrice(
    normalizePositiveComponentPrices(normalizePurchaseItemPrices(merged), evidenceText),
    evidenceText,
  );
  const afterSingleItemResolution = {
    // Permite comparar o item antes e depois da regra segura sem expor conteudo.
    itemHasName: Boolean(extracted.items[0]?.name?.trim()),
    itemHasQuantity: extracted.items[0]?.quantity !== null && extracted.items[0]?.quantity !== undefined,
    itemHasUnitPrice: extracted.items[0]?.unitPrice !== null && extracted.items[0]?.unitPrice !== undefined,
    itemHasTotalPrice: extracted.items[0]?.totalPrice !== null && extracted.items[0]?.totalPrice !== undefined,
  };
  logTestPurchaseDiagnostics(message, deterministic, aiPurchase, extracted, fiscal);
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
  if (existing) {
    // Observabilidade restrita aos fixtures permite distinguir reconciliação de
    // falha sem registrar assunto, corpo, valores ou identificadores pessoais.
    logTestEmailFlow(message, {
      classification: 'COMPRA',
      classificationPath,
      purchaseExtractionAttempted: aiAttempted,
      purchaseExtractionCompleted: aiPurchase !== null || !aiAttempted,
      reconciliationMatched: true,
      purchaseCreated: false,
      purchaseReconciled: true,
      promotionCreated: false,
      ignored: false,
      skippedDuplicate: false,
    });
    return existing;
  }

  const persistedItems = await buildPersistedPurchaseItems(extracted.items, prisma);

  const hasMainPurchaseItem = extracted.items.some((item) =>
    isPersistablePurchaseItem(item) && !isPositivePurchaseComponent(item),
  );
  const financiallyReconciled = reconcilePurchaseTotal(
    amount,
    extracted.items,
    extracted.discountAmount,
  );

  // Somente uma compra completa, com pagamento resolvido e item persistido,
  // item principal e total reconciliado pode ser confirmada automaticamente.
  const purchaseComplete = isCompleteAutomaticPurchase(
    establishment,
    amount,
    paymentMethod?.id ?? null,
    persistedItems.length,
    horario,
    financiallyReconciled,
    hasMainPurchaseItem,
  );
  const purchaseStatus = purchaseComplete ? 'CONFIRMADA' : 'AGUARDANDO_CONFIRMACAO';

  const persistenceDropReasons = {
    missingName: 0,
    missingUnitPrice: 0,
    invalidUnitPrice: 0,
    nonPositiveUnitPrice: 0,
  };
  for (const item of extracted.items) {
    if (!item.name?.trim()) {
      persistenceDropReasons.missingName += 1;
    } else if (item.unitPrice === null || item.unitPrice === undefined) {
      persistenceDropReasons.missingUnitPrice += 1;
    } else if (!Number.isFinite(item.unitPrice)) {
      persistenceDropReasons.invalidUnitPrice += 1;
    } else if (item.unitPrice <= 0) {
      persistenceDropReasons.nonPositiveUnitPrice += 1;
    }
  }

  // Instrumentacao temporaria para o E2E: somente contagens e decisoes,
  // sem corpo do email, produto, valor, URL, token ou dado fiscal.
  console.info('[PurchaseE2E]', {
    classificationPath,
    deterministicItemsCount: deterministic.items.length,
    aiAttempted,
    aiItemsCount: aiPurchase?.items.length ?? 0,
    gmailFiscalDocumentsCount: attachmentFiscal.nfe.length + attachmentFiscal.danfe.length,
    fiscalLinkDocumentsCount: linkFiscal.nfe.length + linkFiscal.danfe.length,
    fiscalParsedItemsCount: fiscal.nfe.reduce((count, source) => count + source.items.length, 0)
      + fiscal.danfe.reduce((count, source) => count + source.items.length, 0),
    mergedItemsCount: extracted.items.length,
    persistenceInputItemsCount: extracted.items.length,
    persistenceAcceptedItemsCount: persistedItems.length,
    beforeSingleItemResolution,
    afterSingleItemResolution,
    persistenceDropReasons,
    freightDetected: extracted.items.some((item) => isPositivePurchaseComponent(item) && item.name?.trim().toLowerCase() === 'frete'),
    feeDetected: extracted.items.some((item) => isPositivePurchaseComponent(item) && item.name?.trim().toLowerCase() !== 'frete'),
    discountDetected: extracted.discountAmount !== null && extracted.discountAmount !== undefined,
    financiallyReconciled,
    unexplainedDifference: !financiallyReconciled,
    hasMainPurchaseItem,
    purchaseComplete,
    autoConfirmed: purchaseComplete,
    missingEstablishment: !Boolean(establishment),
    missingTotalAmount: !(amount !== null && Number.isFinite(amount) && amount > 0),
    missingPaymentMethod: paymentMethod?.id === null || paymentMethod?.id === undefined,
    missingItems: persistedItems.length === 0,
  });

  try {
    const createPurchase = async (db: Prisma.TransactionClient | typeof prisma) => {
      const compra = await db.tb_compra.create({
        data: {
          usuario_id: userId,
          forma_pagamento_id: paymentMethod?.id ?? null,
          compra_valor: amount !== null ? new Prisma.Decimal(amount.toFixed(2)) : null,
          // O desconto e atributo financeiro da compra; nao vira item negativo.
          compra_desconto: normalizePurchaseDiscount(extracted.discountAmount),
          compra_horario: horario,
          compra_fonte: establishment,
          compra_email: true,
          compra_classificacao: 'PENDENTE',
          compra_acima_limite: null,
          compra_email_mensagem_id: message.id,
          compra_pedido_externo_id: extracted.orderNumber,
          compra_status: purchaseStatus,
          ...(persistedItems.length > 0 ? { tb_compra_item: { create: buildNestedPurchaseItems(persistedItems) } } : {}),
        },
      });
      let compraFinal = compra;
      let createdNotifications: PushNotificationCandidate[] = [];
      if (purchaseComplete) {
        const limitEvaluation = await evaluateConfirmedPurchaseLimits(compra.compra_id, db);
        // A métrica usa a mesma transação para não confirmar sem atualizar os indicadores.
        await MetricasService.recalculateMonthlyMetrics(userId, horario, db);
        if (limitEvaluation.eligible) {
          compraFinal = { ...compra, compra_acima_limite: limitEvaluation.purchaseAboveLimit };
        }
        createdNotifications = createdPushNotifications(limitEvaluation);
      }
      return { compra: compraFinal, createdNotifications };
    };
    const transactionResult = purchaseComplete
      ? await prisma.$transaction((tx) => createPurchase(tx))
      : await createPurchase(prisma);
    await dispatchPushAfterCommit(userId, transactionResult.createdNotifications);
    logTestEmailFlow(message, {
      classification: 'COMPRA',
      classificationPath,
      purchaseExtractionAttempted: aiAttempted,
      purchaseExtractionCompleted: aiPurchase !== null || !aiAttempted,
      reconciliationMatched: false,
      purchaseCreated: true,
      purchaseReconciled: purchaseComplete,
      promotionCreated: false,
      ignored: false,
      skippedDuplicate: false,
    });
    return { created: transactionResult.compra };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      logTestEmailFlow(message, {
        classification: 'COMPRA',
        classificationPath,
        purchaseExtractionAttempted: aiAttempted,
        purchaseExtractionCompleted: aiPurchase !== null || !aiAttempted,
        reconciliationMatched: false,
        purchaseCreated: false,
        purchaseReconciled: false,
        promotionCreated: false,
        ignored: false,
        skippedDuplicate: true,
      });
      return { skipped: true as const };
    }
    throw error;
  }
}

async function createPropagandaFromMessage(userId: number, message: GmailMessageDetail, categoryId: number | null) {
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
        propaganda_estabelecimento: extractPropagandaEstablishment(message.from),
        propaganda_data_recebimento: horario,
      },
    });
    return { created: propaganda };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { skipped: true as const };
    }
    throw error;
  }
}

function buildEmailClassificationPrompt(message: GmailMessageDetail) {
  return [
    'Classifique a mensagem abaixo em JSON estrito.',
    'Campos permitidos: classificacao, categoryId, purchase.',
    'categoryId deve ser null nesta etapa; a categoria de propaganda Ã© escolhida separadamente a partir da lista real do banco.',
    'PROPAGANDA somente quando a finalidade principal for comercial; newsletter, conteudo tecnico, academico, editorial, institucional, operacional, informativo ou alerta de seguranca deve ser IGNORAR.',
    'Empresa ou marca no remetente nao significa PROPAGANDA. Mencao secundaria a produto nao supera a intencao principal.',
    'classificacao aceita COMPRA, PROPAGANDA ou IGNORAR.',
    'Classifique como COMPRA somente quando houver evidência textual de transação já concluída.',
    'Preço, oferta, desconto ou linguagem promocional isolados não significam COMPRA.',
    'Quando não houver evidência suficiente para COMPRA ou PROPAGANDA, classifique como IGNORAR.',
    'Use null apenas nos campos opcionais de purchase.',
    'Se houver dados seguros de compra, inclua purchase.amount, purchase.establishment e purchase.paymentMethodName apenas quando estiverem sustentados pelo conteúdo.',
    `subject: ${message.subject ?? ''}`,
    `from: ${message.from ?? ''}`,
    `snippet: ${message.snippet ?? ''}`,
    `bodyText: ${truncatePromptText(message.bodyText)}`,
  ].join('\n');
}

function buildCategoryPrompt(message: GmailMessageDetail, categories: AICategoryOption[]) {
  return [
    'Escolha exclusivamente um categoryId da lista fornecida e retorne JSON estrito.',
    'Nao invente categoria, nome ou ID. Retorne null somente quando nenhuma categoria for razoavelmente adequada.',
    `categorias: ${categories.map((category) => `${category.categoryId} - ${category.categoryName}`).join('; ')}`,
    `subject: ${message.subject ?? ''}`,
    `from: ${message.from ?? ''}`,
    `snippet: ${message.snippet ?? ''}`,
    `bodyText: ${truncatePromptText(message.bodyText)}`,
  ].join('\n');
}

async function resolvePropagationCategory(aiProvider: AIProvider | null, message: GmailMessageDetail, categories: AICategoryOption[]) {
  if (!aiProvider) return null;

  try {
    const aiSuggestion = await aiProvider.suggestCategory(buildCategoryPrompt(message, categories), categories);
    return validatePropagationCategoryId(aiSuggestion.categoryId, categories);
  } catch {
    return null;
  }
}

/**
 * Normaliza o estabelecimento extraído do e-mail para o limite aceito
 * pelo campo compra_fonte no banco.
 */
function normalizeEstablishment(value: string | null | undefined) {
  if (!value) return null;

  const normalized = value
    .replace(/<[^>]+>/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  return normalized ? normalized.slice(0, 45) : null;
}

/** Regra única de completude usada para auto-confirmar compras de e-mail. */
export function isCompleteAutomaticPurchase(
  establishment: string | null,
  amount: number | null,
  paymentMethodId: number | null,
  persistedItemsCount: number,
  messageDate: Date | null,
  financiallyReconciled = false,
  hasMainPurchaseItem = false,
) {
  return Boolean(
    establishment
    && amount !== null
    && Number.isFinite(amount)
    && amount > 0
    && paymentMethodId !== null
    && persistedItemsCount > 0
    && hasMainPurchaseItem
    && financiallyReconciled
    && messageDate,
  );
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
  private static async acquireLock(integrationId: number): Promise<SyncAcquireResult> {
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
  static async syncUser(userId: number): Promise<GmailMessageQueryResult | SyncUserResult> {
    console.info('[EmailSyncService] sync started');
    const integration = await EmailService.findIntegrationByUserId(userId);
    if (!integration) {
      throw new AppError('Integração Gmail não encontrada', 404);
    }

    const lock = await this.acquireLock(integration.integracao_id);
    if (!lock.acquired) {
      return { processed: 0, created: 0, skipped: 0, status: 'JA_EM_ANDAMENTO' as const };
    }

    const startedAt = new Date();
    const previousCursor = integration.integracao_ultima_sincronizacao_em;
    const query = buildGmailQuery(previousCursor, startedAt);
    const isBootstrap = previousCursor === null;
    const executionLimit = isBootstrap ? env.emailSyncInitialMessages : env.emailSyncMaxMessagesPerRun;

    try {
      console.info('[EmailSyncService] obtaining Gmail credentials');
      const accessToken = await EmailService.getValidAccessToken(integration);
      console.info('[EmailSyncService] Gmail credentials resolved');
      console.info('[EmailSyncService] listing Gmail messages');
      const messages = await EmailService.listMessages(
        accessToken,
        query,
        env.emailSyncBatchSize,
        isBootstrap ? env.emailSyncInitialMessages : undefined
      );
      console.info(`[EmailSyncService] Gmail messages fetched count=${messages.length} bootstrap=${isBootstrap}`);
      console.info('[EmailSyncService] creating AI provider');
      const aiProvider: AIProvider | null = createAIProvider();
      // Uma única lista por sincronização evita query por propaganda e mantém os IDs do ambiente atual.
      let propagationCategoriesPromise: Promise<AICategoryOption[]> | null = null;
      const getPropagationCategories = () => {
        propagationCategoriesPromise ??= loadPropagationCategories().catch(() => {
          console.warn('[EmailSyncService] categorias de propaganda indisponíveis');
          return [];
        });
        return propagationCategoriesPromise;
      };
      const result: GmailMessageQueryResult = { processed: 0, created: 0, skipped: 0 };
      let shouldFailRun = false;
      let failureReason: string | null = null;

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
        console.info(`[EmailSyncService] fetching Gmail message idPresent=${Boolean(summary.id)}`);
        const detail = await EmailService.getMessage(accessToken, summary.id);
        console.info('[EmailSyncService] Gmail message fetched');
        const classification = EmailClassificationEngine.classify(detail);

        if (classification.outcome === 'COMPRA') {
          const purchaseResult = await createCompraFromMessage(userId, detail, classification.purchase, accessToken, aiProvider);
          if ('created' in purchaseResult) result.created += 1;
          else result.skipped += 1;
          continue;
        }

        if (classification.outcome === 'PROPAGANDA') {
          const categories = await getPropagationCategories();
          const categoryId = await resolvePropagationCategory(aiProvider, detail, categories);

          const promoResult = await createPropagandaFromMessage(userId, detail, categoryId);
          if ('created' in promoResult) result.created += 1;
          else result.skipped += 1;
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

              const purchaseResult = await createCompraFromMessage(userId, detail, sanitizedPurchase, accessToken, aiProvider, 'AI_COMPRA');
              if ('created' in purchaseResult) result.created += 1;
              else result.skipped += 1;
              continue;
            }

            if (aiResult.classificacao === 'PROPAGANDA') {
              const categories = await getPropagationCategories();
              let categoryId = validatePropagationCategoryId(aiResult.categoryId, categories);
              if (categoryId === null) {
                categoryId = await resolvePropagationCategory(aiProvider, detail, categories);
              }
              const promoResult = await createPropagandaFromMessage(userId, detail, categoryId);
              if ('created' in promoResult) result.created += 1;
              else result.skipped += 1;
              continue;
            }

            continue;
          } catch (error) {
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
    } catch (error) {
      console.error('[EmailSyncService.syncUser] Falha na sincronização Gmail:', safeErrorMessage(error));
      logSyncErrorDiagnostic(error);
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

  
  static async syncAllUsers(): Promise<{ processedUsers: number; lockedUsers: number; failedUsers: number }> {
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
        const result = (await this.syncUser(integration.usuario_id)) as SyncUserResult;
        if (result.status === 'JA_EM_ANDAMENTO') {
          lockedUsers += 1;
          continue;
        }
        processedUsers += 1;
      } catch {
        failedUsers += 1;
        continue;
      }
    }

    return { processedUsers, lockedUsers, failedUsers };
  }
}
