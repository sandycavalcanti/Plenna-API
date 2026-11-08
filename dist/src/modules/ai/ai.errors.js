const publicMessages = {
    TOOL_REGISTRATION_INVALID: 'Definição de tool inválida.',
    TOOL_ALREADY_REGISTERED: 'Tool já registrada.',
    TOOL_NOT_FOUND: 'Tool desconhecida.',
    TOOL_CONTEXT_INVALID: 'Contexto de execução inválido.',
    TOOL_ARGUMENTS_INVALID: 'Argumentos inválidos para a tool.',
    TOOL_EXECUTION_FAILED: 'A execução da tool falhou.',
    TOOL_RESULT_INVALID: 'Resultado da tool inválido.',
};
export class AIToolError extends Error {
    constructor(code) {
        super(publicMessages[code]);
        this.code = code;
        this.name = 'AIToolError';
    }
}
/** Converte falhas internas em um contrato sem mensagens do provider ou do banco. */
export function toPublicToolError(error) {
    if (error instanceof AIToolError) {
        return { code: error.code, message: error.message };
    }
    return {
        code: 'TOOL_EXECUTION_FAILED',
        message: publicMessages.TOOL_EXECUTION_FAILED,
    };
}
const orchestrationMessages = {
    AI_TOOL_CALL_LIMIT: 'A consulta atingiu o limite de ferramentas permitido.',
    AI_TOOL_ROUND_LIMIT: 'A consulta atingiu o limite de etapas permitido.',
    AI_TOOL_TIMEOUT: 'A consulta excedeu o tempo limite permitido.',
    AI_PROVIDER_TOOLS_UNAVAILABLE: 'O provedor atual não oferece suporte a ferramentas.',
    AI_RESPONSE_INVALID: 'A resposta da IA não pôde ser validada.',
};
export class AIOrchestrationError extends Error {
    constructor(code) {
        super(orchestrationMessages[code]);
        this.code = code;
        this.name = 'AIOrchestrationError';
    }
}
