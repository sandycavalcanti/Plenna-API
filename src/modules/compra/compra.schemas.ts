import { z } from 'zod';

const compraClassificacaoSchema = z.enum(['PENDENTE', 'IMPULSIVA', 'NAO_IMPULSIVA']);

export const compraItemSchema = z.object({
  categoriaId: z.coerce.number().int().positive(),
  nome: z.string().min(1).max(45),
  valor: z.coerce.number().positive(),
});

const compraBaseSchema = z.object({
  formaPagamentoId: z.coerce.number().int().positive(),
  compraHorario: z.coerce.date(),
  compraFonte: z.string().min(1).max(45).optional(),
  compraEmail: z.boolean().optional(),
  compraClassificacao: compraClassificacaoSchema,
  compraUsuarioConcorda: z.boolean().optional(),
  compraUsuarioAnotacao: z.string().optional(),
  items: z.array(compraItemSchema).min(1),
});

export const createCompraSchema = compraBaseSchema;

export const updateCompraSchema = compraBaseSchema.partial().extend({
  items: z.array(compraItemSchema).min(1),
});

export type CompraItemDTO = z.infer<typeof compraItemSchema>;
export type CreateCompraDTO = z.infer<typeof createCompraSchema>;
export type UpdateCompraDTO = z.infer<typeof updateCompraSchema>;
