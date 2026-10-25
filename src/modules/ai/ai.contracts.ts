import { z } from 'zod';

export const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

export const toolExecutionContextSchema = z.object({
  usuario_id: z.number().int().positive(),
  requestId: z.string().trim().min(1).max(128).optional(),
  // Calculado pelo backend a partir da mensagem atual; nunca vem do modelo.
  memory_write_intent: z.boolean().optional(),
  // Contexto interno para a ferramenta automática; nunca é aceito nos
  // argumentos devolvidos pelo provider.
  historico_id: z.number().int().positive().optional(),
  mensagem_atual: z.string().max(4_000).optional(),
  memory_automatic_enabled: z.boolean().optional(),
}).strict();

export type ToolExecutionContext = Readonly<z.infer<typeof toolExecutionContextSchema>>;

export type ToolDefinition<
  TArguments extends z.ZodTypeAny = z.ZodTypeAny,
  TResult = unknown,
> = {
  name: string;
  description: string;
  argsSchema: TArguments;
  resultSchema: z.ZodType<TResult>;
  execute: (
    args: z.infer<TArguments>,
    context: ToolExecutionContext,
  ) => TResult | Promise<TResult>;
};

// O registry armazena definições heterogêneas; a tipagem específica continua
// sendo verificada no ponto de registro e no executor.
export type AnyToolDefinition = ToolDefinition<any, any>;

export type ToolCall = {
  name: string;
  arguments: unknown;
};

export type ExecutedToolResult<TResult = unknown> = {
  toolName: string;
  result: TResult;
};

export type ToolMetadata = {
  name: string;
  description: string;
};
