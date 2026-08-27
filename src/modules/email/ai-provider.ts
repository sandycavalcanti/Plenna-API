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
 * Contrato comum para providers de inteligência artificial.
 *
 * O fluxo de sincronização depende desta interface, e não diretamente do
 * Gemini. Isso permite trocar o serviço de IA sem alterar a regra de negócio.
 */
export interface AIProvider {
  classifyEmail(prompt: string): Promise<AIEmailClassificationResult>;
  suggestCategory(prompt: string): Promise<AICategorySuggestionResult>;
}
