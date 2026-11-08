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
  compraClassificacao: compraClassificacaoSchema,
  compraUsuarioConcorda: z.boolean().optional(),
  compraUsuarioAnotacao: z.string().optional(),
  compraValor: z.coerce.number().positive().optional().nullable(),
  items: z.array(compraItemSchema).optional(),
});

export const createCompraSchema = compraBaseSchema.extend({
  compraEmail: z.never().optional(),
  compraStatus: z.never().optional(),
});

export const updateCompraSchema = compraBaseSchema.partial().extend({
  compraStatus: z.never().optional(),
  items: z.array(compraItemSchema.extend({ itemId: z.number().int().positive().optional() })).optional(),
});

export type CompraItemDTO = z.infer<typeof compraItemSchema>;
export type CreateCompraDTO = z.infer<typeof createCompraSchema>;
export type UpdateCompraDTO = z.infer<typeof updateCompraSchema>;

const civilDate = z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/).refine(value => {
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}, 'Data inválida');
export const historicoComprasQuerySchema = z.object({
  mes: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/).optional(),
  inicio: civilDate.optional(), fim: civilDate.optional(),
  status: compraStatusSchema.optional(),
  antes: z.coerce.number().int().positive().max(2147483647).optional(),
  busca: z.string().trim().min(1).max(100).optional(),
}).strict().refine(query => !(query.mes && (query.inicio || query.fim)), 'Escolha mês ou intervalo')
  .refine(query => !!query.inicio === !!query.fim && (!query.inicio || query.inicio <= query.fim!), 'Confira o intervalo');
export type HistoricoComprasQuery = z.infer<typeof historicoComprasQuerySchema>;
