import { z } from "zod";
export const registerSchema = z.object({
    email: z.string().email(),
    senha: z.string().min(6),
    nome: z.string().min(2),
});
export const loginSchema = z.object({
    email: z.string().email(),
    senha: z.string().min(6)
});
