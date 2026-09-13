import { z } from "zod";

const emailSchema = z.string().trim().toLowerCase().email();
const passwordSchema = z
  .string()
  .min(6)
  .refine((password) => /[0-9]/.test(password) || /[^A-Za-z0-9\s]/.test(password), {
    message: "A senha deve conter pelo menos um número ou caractere especial",
  });
const resetCodeSchema = z.string().regex(/^\d{6}$/, "O código deve conter 6 dígitos");

export const registerSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(6),
  nome: z.string().min(2),
});

export const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(6)
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const verifyResetCodeSchema = z.object({
  email: emailSchema,
  codigo: resetCodeSchema,
});

export const resetPasswordSchema = z.object({
  email: emailSchema,
  codigo: resetCodeSchema,
  novaSenha: passwordSchema,
});

export type RegisterDTO = z.infer<typeof registerSchema>;
export type LoginDTO = z.infer<typeof loginSchema>;
export type ForgotPasswordDTO = z.infer<typeof forgotPasswordSchema>;
export type VerifyResetCodeDTO = z.infer<typeof verifyResetCodeSchema>;
export type ResetPasswordDTO = z.infer<typeof resetPasswordSchema>;
