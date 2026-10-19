import { z } from 'zod';

/**
 * A criacao de um historico nao aceita dados controlados pelo cliente nesta
 * fase. O backend define o nome deterministico "Nova conversa".
 */
export const createHistorySchema = z.object({}).strict();

export const historyIdSchema = z.coerce.number().int().positive();

/**
 * Schema compartilhado pelo futuro endpoint de envio e pelo service testavel.
 * O endpoint ainda nao e exposto na Phase 1.
 */
export const createMessageSchema = z.object({
  texto: z.string().trim().min(1).max(4_000),
}).strict();

export type CreateHistoryDTO = z.infer<typeof createHistorySchema>;
export type CreateMessageDTO = z.infer<typeof createMessageSchema>;
