import { z } from 'zod';

export const gastoCategoriaSchema = z.object({
  categoria_nome: z.string(),
  total: z.number(),
});

export const gastosCategoriaResponseSchema = z.array(gastoCategoriaSchema);

export const gastoFormaPagamentoSchema = z.object({
  forma_pagamento_nome: z.string(),
  total: z.number(),
});

export const gastosFormaPagamentoResponseSchema = z.array(gastoFormaPagamentoSchema);

export const impulsividadeSchema = z.object({
  compra_classificacao: z.enum(['PENDENTE', 'IMPULSIVA', 'NAO_IMPULSIVA']),
  quantidade: z.number(),
  valor_total: z.number(),
});

export const impulsividadeResponseSchema = z.array(impulsividadeSchema);

export const limiteComprasResponseSchema = z.object({
  acima_limite: z.number(),
  dentro_limite: z.number(),
});

export const tempoVsGastoSchema = z.object({
  app: z.string(),
  tempo_total: z.number(),
  gasto_total: z.number(),
});

export const tempoVsGastoResponseSchema = z.array(tempoVsGastoSchema);

export type GastoCategoriaDTO = z.infer<typeof gastoCategoriaSchema>;
export type GastoFormaPagamentoDTO = z.infer<typeof gastoFormaPagamentoSchema>;
export type ImpulsividadeDTO = z.infer<typeof impulsividadeSchema>;
export type LimiteComprasDTO = z.infer<typeof limiteComprasResponseSchema>;
export type TempoVsGastoDTO = z.infer<typeof tempoVsGastoSchema>;

const analyticsMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use o formato YYYY-MM');

export const analyticsQuerySchema = z.object({
  mode: z.enum(['month', 'evolution', 'compare']),
  month: analyticsMonthSchema.optional(),
  months: z.coerce.number().int().optional(),
  end: analyticsMonthSchema.optional(),
  monthA: analyticsMonthSchema.optional(),
  monthB: analyticsMonthSchema.optional(),
}).superRefine((query, context) => {
  if (query.mode === 'month' && !query.month) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['month'], message: 'month é obrigatório para mode=month' });
  }

  if (query.mode === 'evolution' && query.months !== 6 && query.months !== 12) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['months'], message: 'months deve ser 6 ou 12' });
  }

  if (query.mode === 'compare') {
    if (!query.monthA) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['monthA'], message: 'monthA é obrigatório para mode=compare' });
    }
    if (!query.monthB) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['monthB'], message: 'monthB é obrigatório para mode=compare' });
    }
    if (query.monthA && query.monthB && query.monthA === query.monthB) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['monthB'], message: 'Os meses de comparação devem ser diferentes' });
    }
  }
});

const analyticsCategorySchema = z.object({
  categoria_id: z.number().int().positive(),
  categoria_nome: z.string(),
  total_centavos: z.number().int(),
  total: z.number(),
  quantidade_itens: z.number().int().nonnegative(),
});

const analyticsPaymentSchema = z.object({
  forma_pagamento_nome: z.string(),
  total_centavos: z.number().int(),
  total: z.number(),
  quantidade_compras: z.number().int().nonnegative(),
});

const analyticsLimitSchema = z.object({
  acima_limite: z.number().int().nonnegative(),
  dentro_limite: z.number().int().nonnegative(),
});

const analyticsImpulsivitySchema = z.object({
  compra_classificacao: z.enum(['PENDENTE', 'IMPULSIVA', 'NAO_IMPULSIVA']),
  quantidade: z.number().int().nonnegative(),
  valor_total_centavos: z.number().int().nonnegative(),
  valor_total: z.number().nonnegative(),
});

const analyticsPeriodSchema = z.object({
  periodo: analyticsMonthSchema,
  inicio: z.string().datetime(),
  fim: z.string().datetime(),
  total_centavos: z.number().int().nonnegative(),
  total: z.number().nonnegative(),
  desconto_centavos: z.number().int().nonnegative(),
  desconto: z.number().nonnegative(),
  quantidade_compras: z.number().int().nonnegative(),
  quantidade_compras_com_valor: z.number().int().nonnegative(),
  categorias: z.array(analyticsCategorySchema),
  formas_pagamento: z.array(analyticsPaymentSchema),
  compras_acima_limite: analyticsLimitSchema,
  impulsividade: z.array(analyticsImpulsivitySchema),
});

const analyticsComparisonMetricSchema = z.object({
  base: z.number().int().nonnegative(),
  comparado: z.number().int().nonnegative(),
  diferenca: z.number().int(),
  variacao_percentual: z.number().nullable(),
});

const analyticsCategoryComparisonSchema = z.object({
  categoria_id: z.number().int().positive(),
  categoria_nome: z.string(),
  base_total_centavos: z.number().int().nonnegative(),
  comparado_total_centavos: z.number().int().nonnegative(),
  diferenca_centavos: z.number().int(),
  base_total: z.number().nonnegative(),
  comparado_total: z.number().nonnegative(),
  diferenca: z.number(),
  variacao_percentual: z.number().nullable(),
});

const analyticsComparisonSchema = z.object({
  periodo_base: analyticsMonthSchema,
  periodo_comparado: analyticsMonthSchema,
  total: analyticsComparisonMetricSchema,
  quantidade_compras: analyticsComparisonMetricSchema,
  categorias: z.array(analyticsCategoryComparisonSchema),
});

export const analyticsResponseSchema = z.object({
  mode: z.enum(['month', 'evolution', 'compare']),
  timezone: z.literal('America/Sao_Paulo'),
  periodos: z.array(analyticsPeriodSchema),
  comparacao: analyticsComparisonSchema.nullable(),
});

export type AnalyticsQueryDTO = z.infer<typeof analyticsQuerySchema>;
export type AnalyticsCategoryDTO = z.infer<typeof analyticsCategorySchema>;
export type AnalyticsPaymentDTO = z.infer<typeof analyticsPaymentSchema>;
export type AnalyticsLimitDTO = z.infer<typeof analyticsLimitSchema>;
export type AnalyticsImpulsivityDTO = z.infer<typeof analyticsImpulsivitySchema>;
export type AnalyticsPeriodDTO = z.infer<typeof analyticsPeriodSchema>;
export type AnalyticsResponseDTO = z.infer<typeof analyticsResponseSchema>;
