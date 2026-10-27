import { z } from 'zod';

export const proactiveStatusSchema = z.enum(['CRIADA', 'EXISTENTE', 'SUPRIMIDA', 'NENHUMA_ACAO']);
export type ProactiveStatus = z.infer<typeof proactiveStatusSchema>;

export const proactiveReasonSchema = z.enum([
  'CONSENTIMENTO_PROATIVIDADE_INATIVO',
  'CONSENTIMENTO_PERSONALIZACAO_INATIVO',
  'FORA_HORARIO_SILENCIOSO',
  'COOLDOWN_ATIVO',
  'SEM_RECOMENDACAO_ELEGIVEL',
  'EVIDENCIA_INSUFICIENTE',
  'RECOMENDACAO_DESCARTADA',
  'CONVERSA_EXISTENTE',
  'EVENTO_DUPLICADO',
  'EVENTO_INVALIDO',
  'ESTRUTURA_INDISPONIVEL',
]);
export type ProactiveReason = z.infer<typeof proactiveReasonSchema>;

export const proactiveCandidateSchema = z.object({
  id: z.number().int().positive(),
  chave: z.string().trim().min(1).max(160),
  tipo: z.string().trim().min(1).max(40),
  titulo: z.string().trim().min(1).max(100),
  texto: z.string().trim().min(1).max(1200),
  evidencias: z.record(z.string(), z.unknown()),
  recomendacaoHistoricoId: z.number().int().positive().nullable(),
  expiraEm: z.date().nullable(),
}).strict();
export type ProactiveCandidate = z.infer<typeof proactiveCandidateSchema>;

export const proactiveFactsSchema = z.object({
  tipo: z.string().trim().min(1).max(40),
  titulo: z.string().trim().min(1).max(100),
  texto: z.string().trim().min(1).max(1200),
  periodo: z.string().trim().max(80).optional(),
  referencias: z.array(z.string().trim().min(1).max(160)).max(30),
  limitacoes: z.array(z.string().trim().min(1).max(240)).max(20),
}).strict();
export type ProactiveFacts = z.infer<typeof proactiveFactsSchema>;

export const proactiveTextSchema = z.object({
  titulo: z.string().trim().min(1).max(100),
  texto: z.string().trim().min(1).max(600),
}).strict();
export type ProactiveText = z.infer<typeof proactiveTextSchema> & {
  fonte: 'IA' | 'DETERMINISTICA' | 'DETERMINISTICA_FALLBACK';
};

export const proactiveResultSchema = z.object({
  estado: proactiveStatusSchema,
  motivo: proactiveReasonSchema.optional(),
  recomendacaoId: z.number().int().positive().nullable(),
  historicoId: z.number().int().positive().nullable(),
  notificacaoId: z.number().int().positive().nullable(),
  fonte: z.enum(['IA', 'DETERMINISTICA', 'DETERMINISTICA_FALLBACK']).nullable(),
}).strict();
export type ProactiveResult = z.infer<typeof proactiveResultSchema>;

