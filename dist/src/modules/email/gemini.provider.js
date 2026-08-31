import axios from 'axios';
import { z } from 'zod';
import { env } from '../../lib/env.js';
import { AIRateLimitError } from './ai-provider.js';
import { isClassificationLabel } from './classification.engine.js';
export class GeminiRateLimitError extends AIRateLimitError {
}
const aiClassificationSchema = z.object({
    classificacao: z.enum(['COMPRA', 'PROPAGANDA', 'IGNORAR']),
    categoryName: z.string().nullable().optional(),
    purchase: z.object({
        establishment: z.string().nullable().optional(),
        amount: z.number().nullable().optional(),
        paymentMethodName: z.string().nullable().optional(),
    }).optional(),
});
const aiCategorySchema = z.object({
    categoryName: z.string().nullable().optional(),
});
function extractText(data) {
    const steps = data?.steps ?? [];
    return steps
        .flatMap((step) => step.content ?? [])
        .filter((content) => content.type === 'text')
        .map((content) => content.text ?? '')
        .join('\n')
        .trim();
}
function getRetryAfterMs(error) {
    const retryAfterHeader = error?.response?.headers?.['retry-after'];
    if (typeof retryAfterHeader === 'string') {
        const seconds = Number(retryAfterHeader);
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.round(seconds * 1000);
        }
    }
    const retryAfterMessage = String(error?.response?.data?.message ?? '');
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
function isRateLimited(error) {
    return error?.response?.status === 429;
}
/**
 * Converte e valida a resposta textual produzida pelo modelo.
 *
 * A saída da IA é tratada como não confiável até passar pela validação
 * estrutural definida pelo Zod.
 */
function parseJsonPayload(payload, schema) {
    const trimmed = payload
        .replace(/```json\s*/gi, '')
        .replace(/```\s*$/g, '')
        .trim();
    const parsed = JSON.parse(trimmed);
    return schema.parse(parsed);
}
/**
 * Implementação do provider de IA utilizando Gemini.
 *
 * O Gemini é utilizado somente como fallback quando as regras locais não
 * conseguem tomar uma decisão segura. Toda resposta do modelo é validada
 * antes de ser utilizada pelo restante da aplicação.
 */
export class GeminiProvider {
    ensureAvailability() {
        if (Date.now() < GeminiProvider.rateLimitedUntil) {
            throw new GeminiRateLimitError('Gemini temporariamente indisponível por rate limit', GeminiProvider.rateLimitedUntil - Date.now());
        }
    }
    /**
     * Classifica uma mensagem que permaneceu ambígua após as regras locais.
     *
     * Mensagens já classificadas com segurança não passam pelo Gemini,
     * reduzindo custo, latência e dependência do serviço externo.
     */
    async classifyEmail(prompt) {
        if (!env.geminiApiKey) {
            throw new Error('GEMINI_API_KEY ausente');
        }
        this.ensureAvailability();
        try {
            const response = await axios.post('https://generativelanguage.googleapis.com/v1beta/interactions', {
                model: env.geminiModel,
                input: prompt,
            }, {
                timeout: env.geminiTimeoutMs,
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': env.geminiApiKey,
                },
            });
            const text = extractText(response.data);
            const parsed = parseJsonPayload(text, aiClassificationSchema);
            if (!isClassificationLabel(parsed.classificacao)) {
                throw new Error('Classificação de IA inválida');
            }
            return parsed;
        }
        catch (error) {
            if (isRateLimited(error)) {
                GeminiProvider.rateLimitedUntil = Date.now() + getRetryAfterMs(error);
                throw new GeminiRateLimitError('Gemini respondeu 429', getRetryAfterMs(error));
            }
            throw error;
        }
    }
    /**
     * Sugere uma categoria como fallback para propagandas.
     *
     * A sugestão da IA não é persistida diretamente: o nome ainda deve
     * corresponder a uma categoria existente no banco.
     */
    async suggestCategory(prompt) {
        if (!env.geminiApiKey) {
            throw new Error('GEMINI_API_KEY ausente');
        }
        this.ensureAvailability();
        try {
            const response = await axios.post('https://generativelanguage.googleapis.com/v1beta/interactions', {
                model: env.geminiModel,
                input: prompt,
            }, {
                timeout: env.geminiTimeoutMs,
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': env.geminiApiKey,
                },
            });
            const text = extractText(response.data);
            return parseJsonPayload(text, aiCategorySchema);
        }
        catch (error) {
            if (isRateLimited(error)) {
                GeminiProvider.rateLimitedUntil = Date.now() + getRetryAfterMs(error);
                throw new GeminiRateLimitError('Gemini respondeu 429', getRetryAfterMs(error));
            }
            throw error;
        }
    }
}
GeminiProvider.rateLimitedUntil = 0;
