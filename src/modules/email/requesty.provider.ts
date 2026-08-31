import axios from 'axios';
import { z } from 'zod';
import { env } from '../../lib/env.js';
import { AIRateLimitError, type AIEmailClassificationResult, type AICategorySuggestionResult, type AIProvider } from './ai-provider.js';
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

  return env.geminiRateLimitCooldownMs;
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

/**
 * Provider de IA ativo para o fluxo de e-mail usando Requesty.
 *
 * O Requesty é consumido através da API compatível com Chat Completions,
 * mantendo o restante da aplicação isolado da implementação concreta.
 */
export class RequestyProvider implements AIProvider {
  private static rateLimitedUntil = 0;

  private ensureAvailability() {
    if (Date.now() < RequestyProvider.rateLimitedUntil) {
      throw new AIRateLimitError(
        'Requesty temporariamente indisponível por rate limit',
        RequestyProvider.rateLimitedUntil - Date.now()
      );
    }
  }

  private async chatCompletion(prompt: string) {
    this.ensureAvailability();

    const response = await axios.post(
      'https://router.requesty.ai/v1/chat/completions',
      {
        model: env.requestyEmailModel,
        messages: [
          { role: 'system', content: 'Responda sempre em JSON estrito e sem texto adicional.' },
          { role: 'user', content: `${buildClassificationInstructions()}\n\n${prompt}` },
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
