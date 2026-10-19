import { z } from 'zod';
import { parseDateOnly } from './recorrencia.calendar.js';

const dateOnlySchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato YYYY-MM-DD')
  .refine((value) => {
    try {
      parseDateOnly(value);
      return true;
    } catch {
      return false;
    }
  }, 'Data inválida');
const frequencySchema = z.enum(['DIARIA', 'SEMANAL', 'MENSAL', 'ANUAL']);
const recurrenceStatusSchema = z.enum(['ATIVA', 'PAUSADA', 'CANCELADA', 'FINALIZADA']);

export const recurrenceItemSchema = z.object({
  categoriaId: z.coerce.number().int().positive(),
  nome: z.string().min(1).max(45),
  valor: z.coerce.number().positive(),
}).strict();

const recurrenceBaseSchema = z.object({
  formaPagamentoId: z.coerce.number().int().positive(),
  compraFonte: z.string().min(1).max(45).optional().nullable(),
  frequencia: frequencySchema,
  primeiraOcorrencia: dateOnlySchema,
  dataFinal: dateOnlySchema.optional().nullable(),
  items: z.array(recurrenceItemSchema).min(1),
}).strict().superRefine((data, context) => {
  if (data.dataFinal && data.dataFinal < data.primeiraOcorrencia) {
    context.addIssue({
      code: 'custom',
      path: ['dataFinal'],
      message: 'A data final não pode ser anterior à primeira ocorrência',
    });
  }
});

export const createRecurrenceSchema = recurrenceBaseSchema;

export const updateRecurrenceSchema = z.object({
  formaPagamentoId: z.coerce.number().int().positive().optional(),
  compraFonte: z.string().min(1).max(45).optional().nullable(),
  frequencia: frequencySchema.optional(),
  primeiraOcorrencia: dateOnlySchema.optional(),
  dataFinal: dateOnlySchema.optional().nullable(),
  items: z.array(recurrenceItemSchema).min(1).optional(),
}).strict().superRefine((data, context) => {
  if (data.dataFinal && data.primeiraOcorrencia && data.dataFinal < data.primeiraOcorrencia) {
    context.addIssue({
      code: 'custom',
      path: ['dataFinal'],
      message: 'A data final não pode ser anterior à primeira ocorrência',
    });
  }
});

export const recurrenceListQuerySchema = z.object({
  status: recurrenceStatusSchema.optional(),
});

export const recurrenceUpcomingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

export const recurrenceIdSchema = z.coerce.number().int().positive();

export type RecurrenceItemDTO = z.infer<typeof recurrenceItemSchema>;
export type CreateRecurrenceDTO = z.infer<typeof createRecurrenceSchema>;
export type UpdateRecurrenceDTO = z.infer<typeof updateRecurrenceSchema>;
export type RecurrenceStatus = z.infer<typeof recurrenceStatusSchema>;
