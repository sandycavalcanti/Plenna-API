import { z } from "zod";

const emailSchema = z.string().trim().toLowerCase().email();
const passwordSchema = z
  .string()
  .min(6)
  .refine((password) => Buffer.byteLength(password, "utf8") <= 72, { message: "A senha deve ter no máximo 72 bytes" })
  .refine((password) => /[0-9]/.test(password) || /[^A-Za-z0-9\s]/.test(password), {
    message: "A senha deve conter pelo menos um número ou caractere especial",
  });
const resetCodeSchema = z.string().regex(/^(?:\d{6}|[a-f0-9]{64})$/, "Código ou link inválido");

export const registerSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(6),
  nome: z.string().min(2),
  aceitouTermos: z.literal(true, { message: 'É preciso aceitar os termos de uso' }),
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
  confirmarSenha: z.string().optional(),
}).refine((data) => data.confirmarSenha === undefined || data.confirmarSenha === data.novaSenha, {
  message: 'As senhas não coincidem', path: ['confirmarSenha'],
});

export type RegisterDTO = z.infer<typeof registerSchema>;
export type LoginDTO = z.infer<typeof loginSchema>;
export type ForgotPasswordDTO = z.infer<typeof forgotPasswordSchema>;
export type VerifyResetCodeDTO = z.infer<typeof verifyResetCodeSchema>;
export type ResetPasswordDTO = z.infer<typeof resetPasswordSchema>;
