import { z } from 'zod';
import { env } from '../../lib/env.js';
export const recommendationTextSchema = z.object({
    titulo: z.string().trim().min(1).max(100),
    texto: z.string().trim().min(1).max(600),
}).strict();
function deterministic(draft, fonte = 'DETERMINISTICA') {
    return { ...recommendationTextSchema.parse({ titulo: draft.titulo, texto: draft.mensagem }), fonte };
}
function safeProviderText(raw, draft) {
    const grounded = deterministic(draft);
    try {
        const parsed = recommendationTextSchema.parse(JSON.parse(raw));
        if (parsed.titulo !== grounded.titulo || parsed.texto !== grounded.texto) {
            return deterministic(draft, 'DETERMINISTICA_FALLBACK');
        }
        return { ...parsed, fonte: 'IA' };
    }
    catch {
        return deterministic(draft, 'DETERMINISTICA_FALLBACK');
    }
}
function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('RECOMMENDATION_TEXT_TIMEOUT')), timeoutMs);
        timer.unref?.();
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}
export class RecommendationTextService {
    constructor(provider, settings = {}) {
        this.provider = provider;
        this.settings = settings;
    }
    async generate(draft) {
        if (!(this.settings.enabled ?? env.recommendationAiEnabled) || !this.provider)
            return deterministic(draft);
        const limitedEvidence = [...draft.referencias, ...draft.limitacoes]
            .join(' | ')
            .slice(0, this.settings.maxContextChars ?? env.recommendationMaxContextChars);
        try {
            const raw = await withTimeout(this.provider.chat([
                { role: 'system', content: 'Redija uma recomendação financeira acolhedora, preventiva, prática e curta em português brasileiro. Ajude o usuário a pensar em prioridades, gastos não essenciais e próximas decisões sem julgamentos. Não sugira alterar ou aumentar limites como solução automática. Responda somente JSON com titulo e texto. Não invente valores, tendências, causas ou fatos e preserve as limitações das evidências.' },
                { role: 'user', content: JSON.stringify({ codigo: draft.codigo, tituloBase: draft.titulo, mensagemBase: draft.mensagem, evidencias: limitedEvidence }) },
            ]), this.settings.timeoutMs ?? env.recommendationTimeoutMs);
            return safeProviderText(raw, draft);
        }
        catch {
            return deterministic(draft, 'DETERMINISTICA_FALLBACK');
        }
    }
}
