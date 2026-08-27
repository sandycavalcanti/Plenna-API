import axios from 'axios';
import { z } from 'zod';
import { env } from '../../lib/env.js';
import { isClassificationLabel } from './classification.engine.js';
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
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    return parts.map((part) => part.text ?? '').join('\n').trim();
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
        const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiApiKey}`, {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }, { timeout: env.geminiTimeoutMs });
        const text = extractText(response.data);
        const parsed = parseJsonPayload(text, aiClassificationSchema);
        if (!isClassificationLabel(parsed.classificacao)) {
            throw new Error('ClassificaÃ§Ã£o de IA invÃ¡lida');
        }
        return parsed;
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
        const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiApiKey}`, {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }, { timeout: env.geminiTimeoutMs });
        const text = extractText(response.data);
        return parseJsonPayload(text, aiCategorySchema);
    }
}
