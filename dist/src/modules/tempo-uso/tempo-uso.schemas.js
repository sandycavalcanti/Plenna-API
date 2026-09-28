import { z } from 'zod';
export const createTempoUsoSchema = z.object({
    nome: z.string().min(1),
    minutos: z.number().positive(),
    data: z.coerce.date(),
});
export const updateTempoUsoSchema = z.object({
    nome: z.string().min(1).optional(),
    minutos: z.number().positive().optional(),
    data: z.coerce.date().optional(),
});
