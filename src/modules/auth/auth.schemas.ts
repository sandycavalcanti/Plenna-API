import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(6),
  nome: z.string().min(2),
  preferenciasLimiteCompra: z.number().optional(),
  preferenciasMetaValor: z.number(),
  preferenciasMetaTempo: z.number()
});

export const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(6)
});

export type RegisterDTO = z.infer<typeof registerSchema>;
export type LoginDTO = z.infer<typeof loginSchema>;