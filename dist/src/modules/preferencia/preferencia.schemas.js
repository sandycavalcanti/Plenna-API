import { z } from 'zod';
export const createPreferenciaCategoriaSchema = z.object({
    categoriaId: z.coerce.number().int().positive(),
    metaMensal: z.coerce.number().positive(),
});
export const createPreferenciasCategoriaBulkSchema = z.object({
    preferencias: z.array(createPreferenciaCategoriaSchema),
});
export const updatePreferenciaCategoriaSchema = z.object({
    categoriaId: z.coerce.number().int().positive().optional(),
    metaMensal: z.coerce.number().positive().optional(),
});
