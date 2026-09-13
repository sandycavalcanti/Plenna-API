import { z } from 'zod';

export const GoogleTokenResponseSchema = z.object({
  access_token: z.string().min(1).max(255),
  refresh_token: z.string().min(1).max(255).optional(),
  expires_in: z.number().int().positive().max(86400),
  token_type: z.string().toLowerCase().pipe(z.literal('bearer')),
  scope: z.string(),
});

export const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const tentativaSchema = z.object({
  tentativa: z.string().uuid(),
  state: stateSchema,
  segredo: stateSchema,
}).strict();
export const finalizarEmailSchema = tentativaSchema.extend({ code: z.string().min(1).max(4096) });
export type FinalizarEmailDTO = z.infer<typeof finalizarEmailSchema>;
