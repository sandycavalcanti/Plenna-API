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
    mensagem_atual: z.string().max(4000).optional(),
    memory_automatic_enabled: z.boolean().optional(),
}).strict();
