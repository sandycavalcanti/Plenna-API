import { z } from 'zod';
// A classificação representa o comportamento de consumo, enquanto o status
// representa o ciclo operacional da compra. Os dois conceitos são independentes.
const compraClassificacaoSchema = z.enum(['PENDENTE', 'IMPULSIVA', 'NAO_IMPULSIVA']);
const compraStatusSchema = z.enum(['AGUARDANDO_CONFIRMACAO', 'CONFIRMADA', 'IGNORADA']);
export const compraItemSchema = z.object({
    categoriaId: z.coerce.number().int().positive(),
    nome: z.string().min(1).max(45),
    valor: z.coerce.number().positive(),
});
/**
 * Define os dados compartilhados pelos fluxos de criação e edição de compras.
 *
 * Alguns campos são opcionais porque compras identificadas automaticamente
 * por e-mail podem existir antes que todas as informações sejam conhecidas.
 */
const compraBaseSchema = z.object({
    formaPagamentoId: z.coerce.number().int().positive().optional().nullable(),
    compraHorario: z.coerce.date(),
    compraFonte: z.string().min(1).max(45).optional().nullable(),
    compraEmail: z.boolean().optional(),
    compraClassificacao: compraClassificacaoSchema,
    compraStatus: compraStatusSchema.optional(),
    compraUsuarioConcorda: z.boolean().optional(),
    compraUsuarioAnotacao: z.string().optional(),
    compraValor: z.coerce.number().positive().optional().nullable(),
    items: z.array(compraItemSchema).optional(),
});
export const createCompraSchema = compraBaseSchema;
export const updateCompraSchema = compraBaseSchema.partial().extend({
    compraStatus: z.never().optional(),
    items: z.array(compraItemSchema).optional(),
});
