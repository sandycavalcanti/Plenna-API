import { z } from 'zod';
const id = z.number().int().positive(),
  centavos = z.number().int().positive().max(9999999999);
const quantidade = z
  .number()
  .positive()
  .max(999999999)
  .refine(
    (v) =>
      Number.isInteger(Math.round(v * 1000)) &&
      Math.abs(v * 1000 - Math.round(v * 1000)) < 0.00001,
    'Use até três casas decimais',
  );
export const motivoExclusao = z.enum([
  'DUPLICADO',
  'INCORRETO',
  'NAO_REALIZADA',
  'OUTRO',
]);
const comum = {
  versaoContrato: z.literal(1),
  operacaoId: z.string().uuid(),
  revisaoEsperada: z.number().int().nonnegative(),
  itemId: id.optional(),
  dataEfetiva: z
    .string()
    .regex(/^[1-9]\d{3}-\d{2}-\d{2}$/)
    .refine(
      (s) =>
        !Number.isNaN(Date.parse(s)) &&
        new Date(s).toISOString().slice(0, 10) === s,
    )
    .nullable(),
  corrigeEventoId: id.optional(),
  anulado: z.boolean().default(false),
};
export const eventoCompraSchema = z.discriminatedUnion('tipo', [
  z
    .object({
      ...comum,
      tipo: z.literal('EXCLUSAO_REGISTRO'),
      motivo: motivoExclusao,
    })
    .strict(),
  z
    .object({
      ...comum,
      tipo: z.literal('CANCELAMENTO'),
      quantidade: quantidade.optional(),
    })
    .strict(),
  z
    .object({
      ...comum,
      tipo: z.literal('DEVOLUCAO'),
      quantidade: quantidade.optional(),
    })
    .strict(),
  z
    .object({ ...comum, tipo: z.literal('REEMBOLSO'), valorCentavos: centavos })
    .strict(),
  z
    .object({ ...comum, tipo: z.literal('OCULTACAO'), oculto: z.boolean() })
    .strict(),
  z
    .object({
      ...comum,
      tipo: z.literal('CLASSIFICACAO'),
      classificacao: z.enum([
        'IMPULSIVA',
        'NAO_IMPULSIVA',
        'PREFIRO_NAO_CLASSIFICAR',
      ]),
    })
    .strict(),
]);
export type EventoCompraDTO = z.infer<typeof eventoCompraSchema>;
