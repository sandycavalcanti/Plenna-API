import { z } from "zod";

export const createUserSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(6),
  nome: z.string().min(2)
});

export const updateUserSchema = z.object({
  nome: z.string().min(2).optional(),
  telefone: z.string().optional(),
  dataNascimento: z.string().optional(),
  preferenciasLimiteCompra: z.number().optional(),
  preferenciasMetaValor: z.number().optional(),
  preferenciasMetaTempo: z.number().int().optional(),
  gatilhoConsumo: z.string().optional(),
  tempoTela: z.string().optional(),
  incomodoConsumo: z.string().optional()
});

export type CreateUserDTO = z.infer<typeof createUserSchema>;
export type UpdateUserDTO = z.infer<typeof updateUserSchema>;