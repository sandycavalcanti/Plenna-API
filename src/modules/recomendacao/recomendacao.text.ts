import { z } from 'zod';
import { env } from '../../lib/env.js';

export const recommendationTextSchema = z.object({
  titulo: z.string().trim().min(1).max(100),
  texto: z.string().trim().min(1).max(600),
}).strict();

export type RecommendationText = z.infer<typeof recommendationTextSchema> & {
  fonte: 'DETERMINISTICA' | 'IA' | 'DETERMINISTICA_FALLBACK';
};

export type RecommendationDraft = {
  titulo: string;
  mensagem: string;
  codigo: string;
  referencias: string[];
  limitacoes: string[];
};

export type RecommendationTextProvider = {
  chat(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string>;
};

export type RecommendationTextSettings = {
  enabled?: boolean;
  maxContextChars?: number;
  timeoutMs?: number;
};

function deterministic(draft: RecommendationDraft, fonte: RecommendationText['fonte'] = 'DETERMINISTICA'): RecommendationText {
  return { ...recommendationTextSchema.parse({ titulo: draft.titulo, texto: draft.mensagem }), fonte };
}

function safeProviderText(raw: string, draft: RecommendationDraft): RecommendationText {
  const grounded = deterministic(draft);
  try {
    const parsed = recommendationTextSchema.parse(JSON.parse(raw));
    if (parsed.titulo !== grounded.titulo || parsed.texto !== grounded.texto) {
      return deterministic(draft, 'DETERMINISTICA_FALLBACK');
    }
    return { ...parsed, fonte: 'IA' };
  } catch {
    return deterministic(draft, 'DETERMINISTICA_FALLBACK');
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RECOMMENDATION_TEXT_TIMEOUT')), timeoutMs);
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export class RecommendationTextService {
  private readonly provider?: RecommendationTextProvider;
  private readonly settings: RecommendationTextSettings;

  constructor(provider?: RecommendationTextProvider, settings: RecommendationTextSettings = {}) {
    this.provider = provider;
    this.settings = settings;
  }

  async generate(draft: RecommendationDraft): Promise<RecommendationText> {
    if (!(this.settings.enabled ?? env.recommendationAiEnabled) || !this.provider) return deterministic(draft);

    const limitedEvidence = [...draft.referencias, ...draft.limitacoes]
      .join(' | ')
      .slice(0, this.settings.maxContextChars ?? env.recommendationMaxContextChars);
    try {
      const raw = await withTimeout(this.provider.chat([
        { role: 'system', content: 'Redija uma recomendação financeira acolhedora, factual e curta em português brasileiro. Responda somente JSON com titulo e texto. Não invente valores, causas ou fatos.' },
        { role: 'user', content: JSON.stringify({ codigo: draft.codigo, tituloBase: draft.titulo, mensagemBase: draft.mensagem, evidencias: limitedEvidence }) },
      ]), this.settings.timeoutMs ?? env.recommendationTimeoutMs);
      return safeProviderText(raw, draft);
    } catch {
      return deterministic(draft, 'DETERMINISTICA_FALLBACK');
    }
  }
}
