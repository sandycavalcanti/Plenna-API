import { z } from 'zod';
import { resultadoInterpretacaoSchema } from './interpretacao.engine.js';

const referencias = z.array(z.string());
export const explicacaoAvaliacaoSchema = z.object({
  versao: z.literal(1),
  origem: z.literal('RESULTADO_PERSISTIDO'),
  resumo: z.string(),
  naturezaResumo: z.literal('INTERPRETADO'),
  referenciasResumo: referencias,
  reflexao: z.string().nullable(),
  fatores: z.array(z.object({
    codigo: z.string(),
    natureza: z.enum(['REGISTRADO', 'DECLARADO', 'INTERPRETADO']),
    mensagem: z.string(),
    referencias,
    campo: z.string().optional(),
    valor: z.string().optional(),
    itemId: z.number().int().positive().optional(),
  }).strict()),
  totalFatores: z.number().int().nonnegative(),
  fatoresCompletos: z.boolean(),
  regrasAplicadas: z.array(z.object({ codigo: z.string(), versao: z.literal(1), referencias }).strict()),
  limitacoes: z.array(z.string()),
  historicoCompras: z.literal('NAO_REGISTRADO_NESTE_RESULTADO'),
}).strict();

/** Projeção de leitura; não executa regras, consulta fontes atuais ou persiste textos. */
export function explicarAvaliacaoPersistida(raw: unknown, compraId: number, previa = false) {
  const parsed = resultadoInterpretacaoSchema.safeParse(raw);
  if (!parsed.success || parsed.data.compraId !== compraId) return null;
  const r = parsed.data;
  const fatores = [
    ...r.evidencias.filter(e => e.natureza === 'REGISTRADO').map(e => ({
      codigo: 'REGISTRO_UTILIZADO', natureza: 'REGISTRADO',
      mensagem: 'Registro utilizado nesta avaliação.', referencias: [e.referencia],
    })),
    ...r.declaracoes.map(d => ({ ...d, natureza: 'DECLARADO' })),
    ...(r.autopercepcao ? [{ ...r.autopercepcao, natureza: 'DECLARADO' }] : []),
    ...r.observacoes.map(o => ({ ...o, natureza: 'INTERPRETADO' })),
  ];
  return explicacaoAvaliacaoSchema.parse({
    versao: 1,
    origem: 'RESULTADO_PERSISTIDO',
    resumo: r.interpretacao.mensagem,
    naturezaResumo: 'INTERPRETADO',
    referenciasResumo: r.interpretacao.referencias,
    reflexao: r.interpretacao.reflexao,
    fatores: previa ? fatores.slice(0, 3) : fatores,
    totalFatores: fatores.length,
    fatoresCompletos: !previa || fatores.length <= 3,
    regrasAplicadas: r.regrasAplicadas.map(({ codigo, versao, referencias }) => ({ codigo, versao, referencias })),
    limitacoes: r.limitacoes,
    // Estes snapshots não persistem o histórico usado por outros indicadores do produto.
    historicoCompras: 'NAO_REGISTRADO_NESTE_RESULTADO',
  });
}
