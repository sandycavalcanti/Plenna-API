import { eventosPosterioresSchema } from './contexto-eventos.js';
import { z } from 'zod';
import {
  respostasContextoSchema,
  planejamentoSchema,
} from './contexto.schemas.js';

const id = z.number().int().positive();
const count = z.number().int().nonnegative();
const instant = z.string().datetime({ offset: true });
export const historicoQuerySchema = z
  .object({
    periodo: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/),
    mesesHistorico: z.coerce.number().int().min(1).max(12).default(6),
  })
  .strict();
export const entradaHistoricoSchema = z
  .object({
    usuarioId: id,
    periodo: historicoQuerySchema.shape.periodo,
    mesesHistorico: z.number().int().min(1).max(12).default(6),
    observadoAte: instant,
    referenciaAtual: instant.optional(),
    cobertura: z
      .enum(['COMPLETA', 'PARCIAL', 'DESCONHECIDA'])
      .default('DESCONHECIDA'),
    inicioObservacao: instant.nullable().default(null),
    orcamentoAtual: z
      .union([
        z.string().regex(/^\d+(?:\.\d+)?$/),
        z.number().finite().nonnegative(),
      ])
      .nullable(),
    compras: z.array(
      z
        .object({
          id,
          usuarioId: id,
          ativa: z.boolean(),
          status: z.enum(['CONFIRMADA', 'AGUARDANDO_CONFIRMACAO', 'IGNORADA']),
          data: instant.nullable(),
          precisao: z.enum(['INSTANTE', 'DIA', 'APROXIMADA', 'DESCONHECIDA']),
          registradaEm: instant.nullable().optional(),
          referenciaData: z
            .enum([
              'DATA_REGISTRADA',
              'MENSAGEM_EMAIL',
              'TRANSACAO_COMPROVADA',
              'DESCONHECIDA',
            ])
            .optional(),
          valorLiquido: z
            .union([
              z.string().regex(/^\d+(?:\.\d+)?$/),
              z.number().finite().nonnegative(),
            ])
            .nullable(),
          origem: z.enum(['MANUAL', 'EMAIL', 'DESCONHECIDA']),
          categorias: z.array(id),
          itensAtivos: z.array(id).default([]),
          recorrenciaId: id.nullable(),
          nomesCategorias: z
            .array(z.object({ id, nome: z.string().min(1) }).strict())
            .optional(),
          categoriasCompletas: z.boolean().default(false),
          contexto: z
            .object({
              eventosPosteriores: eventosPosterioresSchema.optional(),
              registradaEm: instant.nullable().optional(),
              revisao: count,
              respostas: respostasContextoSchema,
              itens: z.array(
                z
                  .object({ itemId: id, planejamento: planejamentoSchema })
                  .strict(),
              ),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    recorrencias: z
      .array(
        z
          .object({
            id,
            status: z.enum(['ATIVA', 'PAUSADA', 'CANCELADA', 'FINALIZADA']),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    const unique = (ids: number[]) => new Set(ids).size === ids.length;
    if (!unique(input.recorrencias.map((r) => r.id)))
      ctx.addIssue({ code: 'custom', message: 'Recorrências repetidas' });
    for (const row of input.compras) {
      if (
        !unique(row.itensAtivos) ||
        !unique(row.contexto?.itens.map((i) => i.itemId) ?? [])
      )
        ctx.addIssue({ code: 'custom', message: 'Itens repetidos' });
    }
  });
export type EntradaHistorico = z.infer<typeof entradaHistoricoSchema>;
export type CompraHistorico = EntradaHistorico['compras'][number];

export const coberturaRespostaSchema = z
  .object({
    universo: count,
    conhecidas: count,
    ausentes: count,
    recusadas: count,
    naoLembra: count,
    cobertura: z.number().min(0).max(1).nullable(),
    disponibilidade: z.enum(['DISPONIVEL', 'PARCIAL', 'INDISPONIVEL']),
  })
  .strict();
