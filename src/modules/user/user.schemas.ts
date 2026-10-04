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
  limiteCompra: z.number().optional(),
  metaValorMensal: z.number().positive().optional(),
  // Zero é um limite configurado: qualquer compra positiva o ultrapassa.
  metaValorCompra: z.number().nonnegative().optional(),
  metaTempo: z.number().int().optional(),
  gatilhoConsumo: z.string().optional(),
  tempoTela: z.string().optional(),
  incomodoConsumo: z.string().optional()
});

export type CreateUserDTO = z.infer<typeof createUserSchema>;
export type UpdateUserDTO = z.infer<typeof updateUserSchema>;
