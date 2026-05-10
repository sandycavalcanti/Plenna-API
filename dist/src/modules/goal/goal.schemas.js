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
