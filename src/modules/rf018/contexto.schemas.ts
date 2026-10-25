import { z } from 'zod';
import { eventosPosterioresSchema } from './eventos.schemas.js';

export const planejamentoSchema = z.enum([
  'SIM',
  'PARCIALMENTE',
  'NAO',
  'NAO_LEMBRO',
  'PREFIRO_NAO_RESPONDER',
]);
const declaracao = z.enum([
  'SIM',
  'NAO',
  'NAO_LEMBRO',
  'PREFIRO_NAO_RESPONDER',
]);
export const respostasContextoSchema = z
  .object({
    planejamento: planejamentoSchema.optional(),
    influenciaPromocional: declaracao.optional(),
    necessidadeInesperada: declaracao.optional(),
    momento: z
      .enum([
        'ANTECIPADA',
        'ADIADA',
        'NO_MOMENTO_PREVISTO',
        'NAO_LEMBRO',
        'PREFIRO_NAO_RESPONDER',
      ])
      .optional(),
    autopercepcaoImpulsividade: declaracao.optional(),
  })
  .strict();
const alteracoes = respostasContextoSchema
  .extend({
    planejamento: planejamentoSchema.nullable().optional(),
    influenciaPromocional: declaracao.nullable().optional(),
    necessidadeInesperada: declaracao.nullable().optional(),
    momento: respostasContextoSchema.shape.momento
      .unwrap()
      .nullable()
      .optional(),
    autopercepcaoImpulsividade: declaracao.nullable().optional(),
  })
  .strict();
export const contextoParamsSchema = z
  .object({ compraId: z.coerce.number().int().positive().max(2147483647) })
  .strict();
export const atualizarContextoSchema = z
  .object({
    versaoContrato: z.literal(1),
    revisaoEsperada: z.number().int().nonnegative().max(2147483646),
    operacaoId: z.string().uuid(),
    respostas: alteracoes.optional(),
    eventosPosteriores: eventosPosterioresSchema.optional(),
    itens: z
      .array(
        z
          .object({
            itemId: z.number().int().positive().max(2147483647),
            planejamento: planejamentoSchema.nullable(),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !Object.keys(value.respostas ?? {}).length &&
      !value.itens?.length &&
      value.eventosPosteriores === undefined
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Informe uma alteração de contexto',
      });
    const ids = value.itens?.map((i) => i.itemId) ?? [];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        path: ['itens'],
        message: 'Itens repetidos',
      });
  });
export const contextoSaidaSchema = z
  .object({
    versaoContrato: z.literal(1),
    compraId: z.number().int().positive(),
    revisao: z.number().int().nonnegative(),
    criadaEm: z.string().datetime().nullable(),
    respostas: respostasContextoSchema,
    eventosPosteriores: eventosPosterioresSchema.optional(),
    itens: z.array(
      z
        .object({
          itemId: z.number().int().positive(),
          planejamento: planejamentoSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type AtualizarContexto = z.infer<typeof atualizarContextoSchema>;
