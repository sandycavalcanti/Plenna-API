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
