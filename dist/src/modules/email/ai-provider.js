/**
 * Erro genérico de rate limit usado pelo fluxo de e-mail.
 *
 * O serviço de sincronização só precisa saber que a IA está temporariamente
 * indisponível e por quanto tempo deve evitar novas tentativas.
 */
export class AIRateLimitError extends Error {
    constructor(message, retryAfterMs) {
        super(message);
        this.name = 'AIRateLimitError';
        this.retryAfterMs = retryAfterMs;
    }
}
