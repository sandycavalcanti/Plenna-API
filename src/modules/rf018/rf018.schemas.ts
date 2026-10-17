import { z } from 'zod';

export const estadosAvaliacao = z.enum(['DADOS_INSUFICIENTES', 'AGUARDANDO_CONTEXTO', 'POSSIVEL_IMPULSIVA', 'SEM_SINAIS_RELEVANTES', 'NAO_AVALIAVEL']);
export const disponibilidade = z.enum(['DISPONIVEL', 'PARCIAL', 'INDISPONIVEL']);
const id = z.number().int().positive();
// Decimal strings preserve money at the boundary; financeiro.ts owns rounding.
const money = z.union([z.number().finite().nonnegative(), z.string().regex(/^\d+(?:\.\d+)?$/)]).nullable();
const instant = z.string().datetime({ offset: true });
const compra = z.object({
  id, usuarioId: id, ativa: z.boolean(),
  status: z.enum(['CONFIRMADA', 'AGUARDANDO_CONFIRMACAO', 'IGNORADA']),
  horario: instant.nullable(), precisaoHorario: z.enum(['INSTANTE', 'APROXIMADO', 'DESCONHECIDO']),
  valorLiquido: money, categorias: z.array(id),
  origem: z.enum(['MANUAL', 'EMAIL', 'RECONCILIADA', 'DESCONHECIDA']),
  referencias: z.array(z.string().min(1)),
}).strict();
const janela = z.object({
  periodo: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/),
  observadoAte: instant,
  cobertura: z.enum(['COMPLETA', 'PARCIAL', 'DESCONHECIDA']),
}).strict();
const limit = z.object({ valor: money, vigencia: z.enum(['DO_PERIODO', 'ATUAL_SEM_HISTORICO']), referencia: z.string().min(1) }).strict();
// Optional extension only: no Android ingestion, permission checks or correlation here.
const rf017 = z.object({
  versaoContrato: z.literal(1), utilizavel: z.literal(false),
  disponibilidade: z.enum(['NAO_FORNECIDA', 'SEM_AUTORIZACAO', 'DESCONHECIDA', 'PARCIAL']),
}).strict();
const common = {
  versaoContrato: z.literal(1), usuarioId: id, janela,
  compras: z.array(compra), limiteIndividual: limit, orcamentoMensal: limit,
  anterior: z.object({ janela, coberturaComparavel: z.boolean(), compras: z.array(compra) }).strict().optional(),
  rf017: rf017.optional(),
};
export const entradaPeriodoSchema = z.object(common).strict();
export const entradaCompraSchema = z.object({ ...common, compraId: id }).strict();
export type EntradaPeriodo = z.infer<typeof entradaPeriodoSchema>;
export type CompraRF018 = z.infer<typeof compra>;

const evidence = z.object({ codigo: z.string(), natureza: z.enum(['OBSERVADO', 'DECLARADO', 'INFERIDO', 'DESCONHECIDO']), referencias: z.array(z.string()) }).strict();
export const saidaPeriodoSchema = z.object({
  versaoContrato: z.literal(1), versaoIndicadores: z.literal('descritivos-1'), escopo: z.literal('PERIODO'),
  periodo: z.string(), timezone: z.literal('UTC'), observadoAte: instant,
  avaliacao: z.object({ estado: estadosAvaliacao, regrasAplicadas: z.array(z.string()).length(0), justificativas: z.array(z.string()) }).strict(),
  qualidade: z.object({ cobertura: janela.shape.cobertura, comprasSemHorario: z.number().int().nonnegative(), horariosImprecisos: z.number().int().nonnegative() }).strict(),
  indicadores: z.object({
    frequencia: z.object({ disponibilidade, compras: z.number().int().nonnegative(), diasObservados: z.number().positive(), comprasPorDia: z.number().nonnegative() }).strict(),
    comparacao: z.object({ disponibilidade, motivo: z.string().nullable(), periodoAnterior: z.string().nullable(), comprasAnterior: z.number().int().nonnegative().nullable(), diferenca: z.number().int().nullable(), variacaoRelativa: z.number().nullable() }).strict(),
    categorias: z.object({ disponibilidade, comprasCategorizadas: z.number().int().nonnegative(), comprasSemCategoria: z.number().int().nonnegative(), grupos: z.array(z.object({ categoriaId: id, compras: z.number().int().positive(), participacao: z.number().min(0).max(1) }).strict()) }).strict(),
    limiteIndividual: z.object({ disponibilidade, limiteCentavos: z.number().nullable(), vigencia: limit.shape.vigencia, comprasSemValor: z.number().int().nonnegative(), desvios: z.array(z.object({ compraId: id, excessoCentavos: z.number().int().nonnegative() }).strict()) }).strict(),
    financeiro: z.object({ totalConhecido: z.number(), total: z.number().nullable(), qualidade: z.enum(['COMPLETO', 'PARCIAL', 'INSUFICIENTE', 'SEM_COMPRAS']), comprasConfirmadas: z.number(), comprasComValor: z.number(), comprasSemValor: z.number(), mediaConhecida: z.number().nullable(), orcamentoMensal: z.number().nullable(), estadoOrcamento: z.enum(['SEM_ORCAMENTO', 'INDETERMINADO', 'EXCEDIDO', 'ATINGIDO', 'DENTRO']) }).strict(),
    orcamento: z.object({ disponibilidade, vigencia: limit.shape.vigencia, estadoNoUniversoObservado: z.string() }).strict(),
  }).strict(), evidencias: z.array(evidence), limitacoes: z.array(z.string()),
}).strict();
export const saidaCompraSchema = z.object({
  versaoContrato: z.literal(1), versaoIndicadores: z.literal('descritivos-1'), escopo: z.literal('COMPRA'), compraId: id,
  elegivel: z.boolean(), origem: compra.shape.origem, precisaoHorario: compra.shape.precisaoHorario,
  disponibilidadeValor: disponibilidade, valorLiquidoCentavos: z.number().nullable(), excessoLimiteCentavos: z.number().nullable(),
  avaliacao: saidaPeriodoSchema.shape.avaliacao, evidencias: z.array(evidence), limitacoes: z.array(z.string()),
}).strict();
