import { z } from 'zod';

export const createGoalSchema = z.object({
  titulo: z.string().min(2),
  descricao: z.string().max(400),
  valor: z.number().positive(),
  data: z.coerce.date().optional(),
});

export const checkGoalSchema = z.object({
  meta_id: z.number().positive(),
  completado: z.boolean(),
});

export const updateGoalSchema = z.object({
  titulo: z.string().min(2).optional(),
  descricao: z.string().max(400).optional(),
  valor: z.number().positive().optional(),
  data: z.coerce.date().optional(),
});

export type CreateGoalDTO = z.infer<typeof createGoalSchema>;
export type UpdateGoalDTO = z.infer<typeof updateGoalSchema>;
export type CheckGoalDTO = z.infer<typeof checkGoalSchema>;

const goalIdSchema = z.coerce.number().int().positive();
const goalMovementTypeSchema = z.enum(['DEPOSITO', 'RETIRADA']);
const goalOperationIdSchema = z.string().uuid();

/**
 * Valores novos do cofrinho chegam como texto para preservar as duas casas
 * decimais do NUMERIC(10,2) sem conversões intermediárias em float.
 */
const goalMoneyInputSchema = z.string()
  .trim()
  .regex(/^\d{1,8}(?:\.\d{1,2})?$/, 'Use um valor monetário positivo com até duas casas decimais.')
  .refine((value) => Number(value) > 0, 'O valor deve ser maior que zero.');

/** Serialização canônica dos valores monetários retornados pela API. */
const goalMoneyOutputSchema = z.string().regex(/^\d{1,8}\.\d{2}$/, 'Valor monetário serializado inválido.');

export const goalMovementInputSchema = z.object({
  tipo: goalMovementTypeSchema,
  valor: goalMoneyInputSchema,
  operacao_id: goalOperationIdSchema,
}).strict();

export const goalMovementPathSchema = z.object({
  id: goalIdSchema,
}).strict();

export const goalMovementListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // O cursor é opaco para o mobile; sua composição não faz parte do contrato.
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

export const goalMovementSchema = z.object({
  meta_movimentacao_id: z.number().int().positive(),
  meta_id: z.number().int().positive(),
  meta_movimentacao_operacao_id: goalOperationIdSchema,
  meta_movimentacao_tipo: goalMovementTypeSchema,
  meta_movimentacao_valor: goalMoneyOutputSchema,
  meta_movimentacao_data: z.string().datetime({ offset: true }),
}).strict();

export const goalSavingsSummarySchema = z.object({
  meta_id: z.number().int().positive(),
  meta_valor: goalMoneyOutputSchema,
  meta_valor_reservado: goalMoneyOutputSchema,
  progresso_percentual: z.number().finite().nonnegative(),
  valor_restante: goalMoneyOutputSchema,
  ultima_movimentacao: goalMovementSchema.nullable(),
  ultimo_deposito: goalMovementSchema.nullable(),
}).strict();

export const goalMovementCreateResponseSchema = z.object({
  movimentacao: goalMovementSchema,
  meta: goalSavingsSummarySchema,
}).strict();

export const goalMovementListResponseSchema = z.object({
  itens: z.array(goalMovementSchema).max(100),
  nextCursor: z.string().nullable(),
}).strict();

export const goalMovementErrorCodeSchema = z.enum([
  'DADOS_INVALIDOS',
  'META_NAO_ENCONTRADA',
  'SALDO_INSUFICIENTE',
  'SALDO_LIMITE_EXCEDIDO',
  'OPERACAO_REUTILIZADA',
  'ERRO_INTERNO',
]);

export const goalMovementErrorSchema = z.object({
  message: z.string(),
  code: goalMovementErrorCodeSchema,
  errors: z.array(z.object({
    field: z.string().nullable(),
    message: z.string(),
  }).strict()).default([]),
}).strict();

export type GoalMovementInput = z.infer<typeof goalMovementInputSchema>;
export type GoalMovementPath = z.infer<typeof goalMovementPathSchema>;
export type GoalMovementListQuery = z.infer<typeof goalMovementListQuerySchema>;
export type GoalMovement = z.infer<typeof goalMovementSchema>;
export type GoalSavingsSummary = z.infer<typeof goalSavingsSummarySchema>;
export type GoalMovementCreateResponse = z.infer<typeof goalMovementCreateResponseSchema>;
export type GoalMovementListResponse = z.infer<typeof goalMovementListResponseSchema>;
export type GoalMovementError = z.infer<typeof goalMovementErrorSchema>;
