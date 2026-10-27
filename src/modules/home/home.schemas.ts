import { z } from 'zod';

export const homeQuerySchema = z.object({ periodo: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/) }).strict();
const amount = z.number().int().nonnegative().nullable();
export const homeResumoSchema = z.object({
  versaoContrato: z.literal(1), periodo: homeQuerySchema.shape.periodo, referenciaTemporal: z.literal('America/Sao_Paulo'),
  seletor: z.object({ periodoMinimo: homeQuerySchema.shape.periodo, periodoMaximo: homeQuerySchema.shape.periodo,
    motivoLimiteInicial: z.enum(['CRIACAO_CONTA', 'COMPRA_RETROATIVA', 'DATA_CRIACAO_INDISPONIVEL']) }).strict(),
  financeiro: z.object({ comprasConfirmadas: z.number().int().nonnegative(), comprasComValor: z.number().int().nonnegative(),
    comprasSemValor: z.number().int().nonnegative(), totalConhecidoCentavos: amount, totalCentavos: amount,
    qualidade: z.enum(['SEM_COMPRAS', 'COMPLETO', 'PARCIAL', 'INSUFICIENTE']),
    cobertura: z.enum(['COMPLETA', 'PARCIAL', 'DESCONHECIDA']) }).strict(),
  orcamento: z.object({ disponibilidade: z.enum(['REFERENCIA_ATUAL', 'INDISPONIVEL']), valorCentavos: amount,
    percentualConhecido: z.number().finite().nonnegative().nullable(), excessoConhecidoCentavos: amount,
    vigencia: z.enum(['ATUAL_SEM_HISTORICO', 'NAO_COMPROVADA']),
    estadoUtilizacao: z.enum(['VERDE', 'AMARELO', 'LARANJA', 'VERMELHO', 'NEUTRO']),
    motivo: z.string().nullable() }).strict(),
  limitacoes: z.array(z.string()),
  perspectivas: z.object({
    categorias: z.object({ disponibilidade: z.literal('INDISPONIVEL'), motivo: z.literal('POLITICA_DE_PRIVACIDADE_NAO_VERIFICAVEL') }).strict(),
    pagamentos: z.object({ disponibilidade: z.literal('INDISPONIVEL'), motivo: z.literal('POLITICA_DE_PRIVACIDADE_NAO_VERIFICAVEL') }).strict(),
    estabelecimentos: z.object({ disponibilidade: z.literal('INDISPONIVEL'), motivo: z.literal('SEM_IDENTIFICACAO_CONFIAVEL') }).strict(),
  }).strict(),
}).strict();
