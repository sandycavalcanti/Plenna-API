export type ToolErrorCode =
  | 'TOOL_REGISTRATION_INVALID'
  | 'TOOL_ALREADY_REGISTERED'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_CONTEXT_INVALID'
  | 'TOOL_ARGUMENTS_INVALID'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_RESULT_INVALID';

const publicMessages: Record<ToolErrorCode, string> = {
  TOOL_REGISTRATION_INVALID: 'Definição de tool inválida.',
  TOOL_ALREADY_REGISTERED: 'Tool já registrada.',
  TOOL_NOT_FOUND: 'Tool desconhecida.',
  TOOL_CONTEXT_INVALID: 'Contexto de execução inválido.',
  TOOL_ARGUMENTS_INVALID: 'Argumentos inválidos para a tool.',
  TOOL_EXECUTION_FAILED: 'A execução da tool falhou.',
  TOOL_RESULT_INVALID: 'Resultado da tool inválido.',
};

export class AIToolError extends Error {
  constructor(public readonly code: ToolErrorCode) {
    super(publicMessages[code]);
    this.name = 'AIToolError';
  }
}

export type PublicToolError = {
  code: ToolErrorCode;
  message: string;
};

/** Converte falhas internas em um contrato sem mensagens do provider ou do banco. */
export function toPublicToolError(error: unknown): PublicToolError {
  if (error instanceof AIToolError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: 'TOOL_EXECUTION_FAILED',
    message: publicMessages.TOOL_EXECUTION_FAILED,
  };
}
export type AIOrchestrationErrorCode =
  | 'AI_TOOL_CALL_LIMIT'
  | 'AI_TOOL_ROUND_LIMIT'
  | 'AI_TOOL_TIMEOUT'
  | 'AI_PROVIDER_TOOLS_UNAVAILABLE'
  | 'AI_RESPONSE_INVALID';

const orchestrationMessages: Record<AIOrchestrationErrorCode, string> = {
  AI_TOOL_CALL_LIMIT: 'A consulta atingiu o limite de ferramentas permitido.',
  AI_TOOL_ROUND_LIMIT: 'A consulta atingiu o limite de etapas permitido.',
  AI_TOOL_TIMEOUT: 'A consulta excedeu o tempo limite permitido.',
  AI_PROVIDER_TOOLS_UNAVAILABLE: 'O provedor atual não oferece suporte a ferramentas.',
  AI_RESPONSE_INVALID: 'A resposta da IA não pôde ser validada.',
};

export class AIOrchestrationError extends Error {
  constructor(public readonly code: AIOrchestrationErrorCode) {
    super(orchestrationMessages[code]);
    this.name = 'AIOrchestrationError';
  }
}
