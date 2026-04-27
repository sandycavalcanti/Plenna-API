import { z } from "zod";
import { meta } from "zod/v4/core";

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
  completado: z.boolean().optional(),
});

export type CreateGoalDTO = z.infer<typeof createGoalSchema>;
export type UpdateGoalDTO = z.infer<typeof updateGoalSchema>;
export type CheckGoalDTO = z.infer<typeof checkGoalSchema>;
