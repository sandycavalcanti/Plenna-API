import { z } from 'zod';
import { canonicalMetaMoney } from './meta.money.js';

const metaMoneyNumberInputSchema = z.number()
  .finite()
  .positive()
  .refine((value) => Number(value.toFixed(2)) === value, 'Use no máximo duas casas decimais.')
  .refine((value) => canonicalMetaMoney(value) !== null, 'Valor monetário fora do limite permitido.');

const metaMoneyStringInputSchema = z.string()
  .trim()
  .regex(/^\d{1,8}(?:\.\d{1,2})?$/, 'Use um valor monetário positivo com até duas casas decimais.')
  .refine((value) => canonicalMetaMoney(value) !== null, 'Valor monetário fora do limite permitido.');

/** Metas aceitam números legados e texto decimal canônico, sempre em reais. */
export const metaMoneyInputSchema = z.union([
  metaMoneyNumberInputSchema,
  metaMoneyStringInputSchema,
]).transform((value) => canonicalMetaMoney(value)!);

export const createMetaSchema = z.object({
  titulo: z.string().min(2),
  descricao: z.string().max(400),
  valor: metaMoneyInputSchema,
  data: z.coerce.date().optional(),
});

export const checkMetaSchema = z.object({
  meta_id: z.number().positive(),
  completado: z.boolean(),
});

export const updateMetaSchema = z.object({
  titulo: z.string().min(2).optional(),
  descricao: z.string().max(400).optional(),
  valor: metaMoneyInputSchema.optional(),
  data: z.coerce.date().optional(),
});

export type CreateMetaDTO = z.infer<typeof createMetaSchema>;
export type UpdateMetaDTO = z.infer<typeof updateMetaSchema>;
export type CheckMetaDTO = z.infer<typeof checkMetaSchema>;

const metaIdSchema = z.coerce.number().int().positive();
const metaMovimentacaoTipoSchema = z.enum(['DEPOSITO', 'RETIRADA']);
const metaOperacaoIdSchema = z.string().uuid();

/**
 * Valores novos do cofrinho chegam como texto para preservar as duas casas
 * decimais do NUMERIC(10,2) sem conversões intermediárias em float.
 */
const metaMovimentacaoMoneyInputSchema = z.string()
  .trim()
  .regex(/^\d{1,8}(?:\.\d{1,2})?$/, 'Use um valor monetário positivo com até duas casas decimais.')
  .refine((value) => Number(value) > 0, 'O valor deve ser maior que zero.');

/** Serialização canônica dos valores monetários retornados pela API. */
const metaMoneyOutputSchema = z.string().regex(/^\d{1,8}\.\d{2}$/, 'Valor monetário serializado inválido.');

export const metaMovimentacaoInputSchema = z.object({
  tipo: metaMovimentacaoTipoSchema,
  valor: metaMovimentacaoMoneyInputSchema,
  operacao_id: metaOperacaoIdSchema,
}).strict();

export const metaMovimentacaoPathSchema = z.object({
  id: metaIdSchema,
}).strict();

export const metaMovimentacaoListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // O cursor é opaco para o mobile; sua composição não faz parte do contrato.
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

export const metaMovimentacaoSchema = z.object({
  meta_movimentacao_id: z.number().int().positive(),
  meta_id: z.number().int().positive(),
  meta_movimentacao_operacao_id: metaOperacaoIdSchema,
  meta_movimentacao_tipo: metaMovimentacaoTipoSchema,
  meta_movimentacao_valor: metaMoneyOutputSchema,
  meta_movimentacao_data: z.string().datetime({ offset: true }),
}).strict();

export const metaCofrinhoResumoSchema = z.object({
  meta_id: z.number().int().positive(),
  meta_valor: metaMoneyOutputSchema,
  meta_valor_reservado: metaMoneyOutputSchema,
  progresso_percentual: z.number().finite().nonnegative(),
  valor_restante: metaMoneyOutputSchema,
  ultima_movimentacao: metaMovimentacaoSchema.nullable(),
  ultimo_deposito: metaMovimentacaoSchema.nullable(),
}).strict();

export const metaMovimentacaoCreateResponseSchema = z.object({
  movimentacao: metaMovimentacaoSchema,
  meta: metaCofrinhoResumoSchema,
}).strict();

export const metaMovimentacaoListResponseSchema = z.object({
  itens: z.array(metaMovimentacaoSchema).max(100),
  nextCursor: z.string().nullable(),
}).strict();

export const metaMovimentacaoErrorCodeSchema = z.enum([
  'DADOS_INVALIDOS',
  'META_NAO_ENCONTRADA',
  'SALDO_INSUFICIENTE',
  'SALDO_LIMITE_EXCEDIDO',
  'OPERACAO_REUTILIZADA',
  'ERRO_INTERNO',
]);

export const metaMovimentacaoErrorSchema = z.object({
  message: z.string(),
  code: metaMovimentacaoErrorCodeSchema,
  errors: z.array(z.object({
    field: z.string().nullable(),
    message: z.string(),
  }).strict()).default([]),
}).strict();

export type MetaMovimentacaoInput = z.infer<typeof metaMovimentacaoInputSchema>;
export type MetaMovimentacaoPath = z.infer<typeof metaMovimentacaoPathSchema>;
export type MetaMovimentacaoListQuery = z.infer<typeof metaMovimentacaoListQuerySchema>;
export type MetaMovimentacao = z.infer<typeof metaMovimentacaoSchema>;
export type MetaCofrinhoResumo = z.infer<typeof metaCofrinhoResumoSchema>;
export type MetaMovimentacaoCreateResponse = z.infer<typeof metaMovimentacaoCreateResponseSchema>;
export type MetaMovimentacaoListResponse = z.infer<typeof metaMovimentacaoListResponseSchema>;
export type MetaMovimentacaoError = z.infer<typeof metaMovimentacaoErrorSchema>;
