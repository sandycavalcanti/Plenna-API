/**
 * Classificações finais reconhecidas pelo domínio.
 *
 * Providers de IA podem sugerir uma classificação, mas o restante da
 * aplicação só trabalha com este conjunto fechado de valores.
 */
export type EmailClassificationLabel = 'COMPRA' | 'PROPAGANDA' | 'IGNORAR';

export interface AIEmailClassificationResult {
  classificacao: EmailClassificationLabel;
  categoryName?: string | null;
  purchase?: {
    establishment?: string | null;
    amount?: number | null;
    paymentMethodName?: string | null;
  };
}

export interface AICategorySuggestionResult {
  categoryName?: string | null;
}
/**
 * Erro genérico de rate limit usado pelo fluxo de e-mail.
 *
 * O serviço de sincronização só precisa saber que a IA está temporariamente
 * indisponível e por quanto tempo deve evitar novas tentativas.
 */
export class AIRateLimitError extends Error {
  retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'AIRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}
/**
 * Contrato comum para providers de inteligência artificial.
 *
 * O fluxo de sincronização depende desta interface, e não diretamente do
 * Gemini. Isso permite trocar o serviço de IA sem alterar a regra de negócio.
 */
export interface AIProvider {
  classifyEmail(prompt: string): Promise<AIEmailClassificationResult>;
  suggestCategory(prompt: string): Promise<AICategorySuggestionResult>;
}
