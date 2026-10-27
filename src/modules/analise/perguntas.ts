import { z } from 'zod';
import { contextoSaidaSchema, planejamentoSchema } from './contexto.schemas.js';

const labels: Record<string, string> = {
  SIM: 'Sim',
  NAO: 'Não',
  PARCIALMENTE: 'Parcialmente',
  NAO_LEMBRO: 'Não lembro',
  PREFIRO_NAO_RESPONDER: 'Prefiro não responder',
  ANTECIPADA: 'Antecipei',
  ADIADA: 'Adiei',
  NO_MOMENTO_PREVISTO: 'No momento previsto',
};
const declaracao = ['SIM', 'NAO', 'NAO_LEMBRO', 'PREFIRO_NAO_RESPONDER'];
export const catalogoPerguntas = [
  {
    campo: 'planejamento',
    texto: 'Essa compra já estava nos seus planos?',
    valores: planejamentoSchema.options,
  },
  {
    campo: 'influenciaPromocional',
    texto: 'Alguma promoção influenciou sua decisão?',
    valores: declaracao,
  },
  {
    campo: 'necessidadeInesperada',
    texto: 'Essa compra surgiu de uma necessidade inesperada?',
    valores: declaracao,
  },
  {
    campo: 'momento',
    texto: 'Você mudou o momento em que pretendia comprar?',
    valores: [
      'ANTECIPADA',
      'ADIADA',
      'NO_MOMENTO_PREVISTO',
      'NAO_LEMBRO',
      'PREFIRO_NAO_RESPONDER',
    ],
  },
  {
    campo: 'autopercepcaoImpulsividade',
    texto: 'Na sua percepção, houve impulso nessa decisão?',
    valores: declaracao,
  },
].map((q) => ({
  codigo: q.campo,
  campo: q.campo,
  versao: 1,
  texto: q.texto,
  opcoes: q.valores.map((valor) => ({ valor, texto: labels[valor]! })),
}));
const perguntaSchema = z
  .object({
    codigo: z.string(),
    campo: z.enum([
      'planejamento',
      'influenciaPromocional',
      'necessidadeInesperada',
      'momento',
      'autopercepcaoImpulsividade',
    ]),
    versao: z.literal(1),
    texto: z.string(),
    opcoes: z.array(
      z.object({ valor: z.string(), texto: z.string() }).strict(),
    ),
  })
  .strict();
export const perguntasSaidaSchema = z
  .object({
    versaoContrato: z.literal(1),
    versaoCatalogo: z.literal('contexto-1'),
    compraId: z.number().int().positive(),
    revisao: z.number().int().nonnegative(),
    catalogo: z.array(perguntaSchema),
    perguntas: z.array(
      z
        .object({
          codigo: z.string(),
          motivo: z.string(),
          itemId: z.number().int().positive().optional(),
        })
        .strict(),
    ),
    itens: z.array(
      z
        .object({ itemId: z.number().int().positive(), nome: z.string() })
        .strict(),
    ),
    planejamentoItemOpcoes: z.array(
      z.object({ valor: planejamentoSchema, texto: z.string() }).strict(),
    ),
  })
  .strict();

// Only selects invitations. No money/usage thresholds, diagnosis or inferred answers.
export function selecionarPerguntas(
  raw: unknown,
  itens: { itemId: number; nome: string }[],
) {
  const contexto = contextoSaidaSchema.parse(raw);
  const r = contexto.respostas;
  const perguntas: { codigo: string; motivo: string; itemId?: number }[] = [];
  for (const q of catalogoPerguntas) {
    if (r[q.campo as keyof typeof r] !== undefined) continue; // Includes explicit refusals.
    if (
      q.campo === 'momento' &&
      !['SIM', 'PARCIALMENTE'].includes(r.planejamento ?? '') &&
      r.influenciaPromocional !== 'SIM'
    )
      continue;
    perguntas.push({
      codigo: q.codigo,
      motivo:
        q.campo === 'momento'
          ? 'PLANEJAMENTO_OU_PROMOCAO_DECLARADOS'
          : 'CONTEXTO_NAO_INFORMADO',
    });
  }
  if (r.planejamento === 'PARCIALMENTE')
    for (const item of itens) {
      if (!contexto.itens.some((i) => i.itemId === item.itemId))
        perguntas.push({
          codigo: 'planejamentoItem',
          itemId: item.itemId,
          motivo: 'PLANEJAMENTO_PARCIAL_DECLARADO',
        });
    }
  return perguntasSaidaSchema.parse({
    versaoContrato: 1,
    versaoCatalogo: 'contexto-1',
    compraId: contexto.compraId,
    revisao: contexto.revisao,
    catalogo: catalogoPerguntas,
    perguntas,
    itens,
    planejamentoItemOpcoes: planejamentoSchema.options.map((valor) => ({
      valor,
      texto: labels[valor],
    })),
  });
}
