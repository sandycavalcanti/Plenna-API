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
