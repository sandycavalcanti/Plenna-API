import axios from 'axios';
import { z } from 'zod';
import { env } from '../../lib/env.js';
import {
  AIRateLimitError,
  type AIEmailClassificationResult,
  type AICategorySuggestionResult,
  type AIProvider,
  type AIPurchaseExtractionProvider,
  type AIExtractedPurchase,
} from './ai-provider.js';
import { isClassificationLabel } from './classification.engine.js';

const requestyPurchaseSchema = z.object({
  establishment: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  paymentMethodName: z.string().nullable().optional(),
});

const requestyClassificationSchema = z.discriminatedUnion('classificacao', [
  z.object({
    classificacao: z.literal('COMPRA'),
    categoryName: z.string().nullable().optional(),
    purchase: requestyPurchaseSchema,
  }),
  z.object({
    classificacao: z.literal('PROPAGANDA'),
    categoryName: z.string().nullable().optional(),
    purchase: requestyPurchaseSchema.nullable().optional(),
  }),
  z.object({
    classificacao: z.literal('IGNORAR'),
    categoryName: z.string().nullable().optional(),
    purchase: requestyPurchaseSchema.nullable().optional(),
  }),
]);

const requestyCategorySchema = z.object({
  categoryName: z.string().nullable().optional(),
});

const MAX_RATE_LIMIT_RETRIES = 2;
const FALLBACK_RETRY_BACKOFF_BASE_MS = 250;

const requestyExtractedPurchaseItemSchema = z.object({
  name: z.string().max(160).nullable().default(null),
  quantity: z.number().finite().positive().nullable().default(null),
  unitPrice: z.number().finite().positive().nullable().default(null),
  totalPrice: z.number().finite().positive().nullable().default(null),
  categoryName: z.string().max(80).nullable().default(null),
}).strict();

export const requestyPurchaseExtractionSchema = z.object({
  establishment: z.string().max(120).nullable().default(null),
  orderNumber: z.string().max(80).nullable().default(null),
  totalAmount: z.number().finite().positive().nullable().default(null),
  paymentMethodName: z.string().max(80).nullable().default(null),
  items: z.array(requestyExtractedPurchaseItemSchema).max(100).default([]),
}).strict();

function extractAssistantContent(data: unknown) {
  const choices = (
    data as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    }
  )?.choices ?? [];

  const content = choices[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === 'text' ? part.text ?? '' : ''))
      .join('\n')
      .trim();
  }

  return '';
}

function getRetryAfterMs(error: any) {
  const retryAfterHeader = error?.response?.headers?.['retry-after'];
  if (typeof retryAfterHeader === 'string') {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.round(seconds * 1000);
    }
  }

  const retryAfterMessage = String(error?.response?.data?.error?.message ?? error?.response?.data?.message ?? '');
  const match = retryAfterMessage.match(/retry in\s+(\d+)\s*(ms|s|seconds)?/i);
  if (match) {
    const value = Number(match[1]);
    const unit = (match[2] ?? 's').toLowerCase();
    if (Number.isFinite(value) && value > 0) {
      return unit === 'ms' ? value : value * 1000;
    }
  }

  return env.requestyRateLimitCooldownMs;
}

function hasExplicitRetryAfter(error: any) {
  const header = error?.response?.headers?.['retry-after'];
  if (typeof header === 'string') {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return true;
  }

  return /retry in\s+\d+\s*(?:ms|s|seconds)?/i.test(
    String(error?.response?.data?.error?.message ?? error?.response?.data?.message ?? ''),
  );
}

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function isRateLimited(error: any) {
  return error?.response?.status === 429;
}

/**
 * Converte e valida o conteúdo textual retornado pelo Requesty.
 *
 * A resposta do modelo continua sendo tratada como não confiável até passar
 * pela validação Zod.
 */
function parseJsonPayload<T>(payload: string, schema: z.ZodType<T>) {
  const trimmed = payload
    .replace(/```json\s*/gi, '')
    .replace(/```\s*$/g, '')
    .trim();
  const parsed = JSON.parse(trimmed);
  return schema.parse(parsed);
}

function buildClassificationInstructions() {
  return [
    'Não invente dados que não estejam explicitamente suportados pelo e-mail.',
    'Classifique como COMPRA somente quando houver evidência textual de transação já concluída.',
    'Emails de status de pedido, envio, entrega, nota fiscal ou pagamento aprovado são COMPRA.',
    'Preço, oferta, desconto ou linguagem promocional isolados não significam COMPRA.',
    'Promoções de consumo como produto, serviço, ecommerce, promoção, desconto, cupom ou oferta comercial devem ser PROPAGANDA.',
    'Conteúdo de vagas, recrutamento, carreira, processo seletivo, newsletter profissional ou comunicação institucional sem estímulo comercial deve ser IGNORAR.',
    'purchase.amount só deve ser preenchido quando o valor estiver sustentado pelo conteúdo da mensagem.',
    'purchase.establishment só deve ser preenchido quando o nome do estabelecimento aparecer de forma razoável no e-mail.',
    'purchase.paymentMethodName só deve ser preenchido quando houver evidência textual explícita.',
    'Quando não houver evidência suficiente, prefira null.',
  ].join(' ');
}

function buildPurchaseExtractionInstructions() {
  return [
    'Voce esta EXTRAINDO informacoes existentes no e-mail; o e-mail ja foi classificado como COMPRA.',
    'Nao classifique o e-mail e nao use conhecimento externo.',
    'Nao invente, nao estime e nao calcule valores ausentes. Quando nao houver evidencia, retorne null.',
    'Para totalAmount, priorize voce pagou, total pago, valor pago, total da compra, total do pedido e valor total.',
    'Nao confunda totalAmount com preco de produto, subtotal, frete, desconto, economia, parcela, cashback ou cupom.',
    'Extraia orderNumber somente com evidencia textual de pedido e nao confunda CNPJ, CPF, rastreio ou chave NF-e.',
    'Retorne somente paymentMethodName textual quando a forma estiver explicitamente presente, sem ID de banco.',
    'Extraia itens somente quando nome, quantidade ou precos estiverem explicitamente presentes.',
    'categoryName deve ser null quando nao houver categoria explicitamente indicada no e-mail.',
    'Responda em JSON estrito com establishment, orderNumber, totalAmount, paymentMethodName e items.',
  ].join(' ');
}

/**
 * Provider de IA ativo para o fluxo de e-mail usando Requesty.
 *
 * O Requesty é consumido através da API compatível com Chat Completions,
 * mantendo o restante da aplicação isolado da implementação concreta.
 */
export class RequestyProvider implements AIProvider, AIPurchaseExtractionProvider {
  private static rateLimitedUntil = 0;

  private ensureAvailability() {
    if (Date.now() < RequestyProvider.rateLimitedUntil) {
      throw new AIRateLimitError(
        'Requesty temporariamente indisponível por rate limit',
        RequestyProvider.rateLimitedUntil - Date.now()
      );
    }
  }

  private async chatCompletion(prompt: string, instructions = buildClassificationInstructions()) {
    this.ensureAvailability();

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      try {
        const response = await axios.post(
          'https://router.requesty.ai/v1/chat/completions',
          {
            model: env.requestyEmailModel,
            messages: [
              { role: 'system', content: 'Responda sempre em JSON estrito e sem texto adicional.' },
              { role: 'user', content: `${instructions}\n\n${prompt}` },
            ],
            temperature: 0,
          },
          {
            timeout: env.requestyTimeoutMs,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env.requestyApiKey}`,
            },
          }
        );

        return extractAssistantContent(response.data);
      } catch (error: any) {
        if (!isRateLimited(error)) throw error;

        const retryAfterMs = getRetryAfterMs(error);
        if (attempt === MAX_RATE_LIMIT_RETRIES) {
          // A mensagem ambigua nao pode ser descartada nem avancar o cursor;
          // apos poucas tentativas, o erro continua sinalizando falha da sync.
          RequestyProvider.rateLimitedUntil = Date.now() + retryAfterMs;
          throw new AIRateLimitError('Requesty respondeu 429', retryAfterMs);
        }

        // Retry-After explicito vem do servidor. Sem ele, usamos backoff curto
        // e limitado para evitar espera longa ou uma sequencia infinita.
        const delayMs = hasExplicitRetryAfter(error)
          ? retryAfterMs
          : Math.min(retryAfterMs, FALLBACK_RETRY_BACKOFF_BASE_MS * 2 ** attempt);
        await waitForRetry(delayMs);
      }
    }

    throw new Error('Fluxo de retry da Requesty terminou sem resultado');
  }

  /**
   * Classifica uma mensagem ambígua usando o Requesty.
   *
   * Mensagens já claras continuam resolvidas pelas regras determinísticas.
   */
  async classifyEmail(prompt: string): Promise<AIEmailClassificationResult> {
    if (!env.requestyApiKey) {
      throw new Error('REQUESTY_API_KEY ausente');
    }

    try {
      const text = await this.chatCompletion(prompt);
      const parsed = parseJsonPayload(text, requestyClassificationSchema);

      if (!isClassificationLabel(parsed.classificacao)) {
        throw new Error('Classificação de IA inválida');
      }

      return parsed;
    } catch (error: any) {
      if (isRateLimited(error)) {
        const retryAfterMs = getRetryAfterMs(error);
        RequestyProvider.rateLimitedUntil = Date.now() + retryAfterMs;
        throw new AIRateLimitError('Requesty respondeu 429', retryAfterMs);
      }

      throw error;
    }
  }

  /** Extrai lacunas de uma compra sem misturar essa responsabilidade com classificacao. */
  async extractPurchase(prompt: string): Promise<AIExtractedPurchase> {
    if (!env.requestyApiKey) {
      throw new Error('REQUESTY_API_KEY ausente');
    }

    try {
      const text = await this.chatCompletion(prompt, buildPurchaseExtractionInstructions());
      return parseJsonPayload(text, requestyPurchaseExtractionSchema);
    } catch (error: any) {
      if (isRateLimited(error)) {
        const retryAfterMs = getRetryAfterMs(error);
        RequestyProvider.rateLimitedUntil = Date.now() + retryAfterMs;
        throw new AIRateLimitError('Requesty respondeu 429', retryAfterMs);
      }

      throw error;
    }
  }

  /**
   * Sugere uma categoria para propagandas já reconhecidas como tais.
   */
  async suggestCategory(prompt: string): Promise<AICategorySuggestionResult> {
    if (!env.requestyApiKey) {
      throw new Error('REQUESTY_API_KEY ausente');
    }

    try {
      const text = await this.chatCompletion(prompt);
      return parseJsonPayload(text, requestyCategorySchema);
    } catch (error: any) {
      if (isRateLimited(error)) {
        const retryAfterMs = getRetryAfterMs(error);
        RequestyProvider.rateLimitedUntil = Date.now() + retryAfterMs;
        throw new AIRateLimitError('Requesty respondeu 429', retryAfterMs);
      }

      throw error;
    }
  }
}
