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
  } | null;
}

export interface AICategorySuggestionResult {
  categoryName?: string | null;
}

export interface AIExtractedPurchaseItem {
  name: string | null;
  quantity: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
  categoryName: string | null;
}

/** Contrato de extracao da IA, sem IDs ou campos de persistencia. */
export interface AIExtractedPurchase {
  establishment: string | null;
  orderNumber: string | null;
  totalAmount: number | null;
  paymentMethodName: string | null;
  items: AIExtractedPurchaseItem[];
}

/** Capacidade opcional de enriquecimento, separada da classificacao do email. */
export interface AIPurchaseExtractionProvider {
  extractPurchase(prompt: string): Promise<AIExtractedPurchase>;
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
 * um provider específico. Isso preserva a regra de negócio separada da integração.
 */
export interface AIProvider {
  classifyEmail(prompt: string): Promise<AIEmailClassificationResult>;
  suggestCategory(prompt: string): Promise<AICategorySuggestionResult>;
}
