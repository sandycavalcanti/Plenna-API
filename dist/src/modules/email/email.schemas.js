import { z } from 'zod';
/**
 * Schemas de validação dos dados recebidos de serviços externos.
 *
 * Respostas do Google, Gmail e providers externos não devem ser utilizadas
 * diretamente sem validação de estrutura e tipos.
 */
export const googleTokenResponseSchema = z.object({
    access_token: z.string(),
    expires_in: z.number(),
    refresh_token: z.string().optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
});
export const gmailMessageSummarySchema = z.object({
    id: z.string(),
    threadId: z.string().optional(),
    snippet: z.string().optional(),
    internalDate: z.string().optional(),
    labelIds: z.array(z.string()).default([]),
});
export const gmailMessageDetailSchema = gmailMessageSummarySchema.extend({
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    bodyText: z.string().nullable().optional(),
});
