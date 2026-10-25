import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import {
  interpretarCompra,
  resultadoInterpretacaoSchema,
  VERSAO_MOTOR,
} from './interpretacao.engine.js';
import { respostasContextoSchema } from './contexto.schemas.js';
import { separarContextoPersistido } from './eventos.schemas.js';

export const calcularAvaliacaoSchema = z
  .object({ revisaoEsperada: z.number().int().nonnegative().optional() })
  .strict();
export const avaliacaoSaidaSchema = z
  .object({
    versaoContrato: z.literal(1),
    compraId: z.number().int().positive(),
    atualidade: z.enum(['SEM_AVALIACAO', 'VIGENTE', 'DESATUALIZADA']),
    motivos: z.array(z.string()),
    avaliacaoId: z.number().int().positive().nullable(),
    criadaEm: z.string().datetime().nullable(),
    resultado: resultadoInterpretacaoSchema.nullable(),
  })
  .strict();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

async function snapshot(
  tx: Prisma.TransactionClient,
  userId: number,
  compraId: number,
) {
  const p = await tx.tb_compra.findFirst({
    where: { compra_id: compraId, usuario_id: userId },
    select: {
      compra_id: true,
      compra_ativo: true,
      compra_status: true,
      compra_valor: true,
      compra_desconto: true,
      compra_horario: true,
      compra_email: true,
      compra_fonte: true,
      tb_usuario: { select: { usuario_meta_valor_compra: true } },
      tb_compra_item: {
        where: { compra_item_ativo: 1 },
        orderBy: { compra_item_id: 'asc' },
        select: {
          compra_item_id: true,
          compra_item_ativo: true,
          compra_item_nome: true,
          compra_item_valor: true,
          compra_item_quantidade: true,
          categoria_id: true,
        },
      },
    },
  });
  if (!p) throw new AppError('Compra não encontrada', 404);
  const c = await tx.tb_rf018_contexto_revisao.findFirst({
    where: { compra_id: compraId, usuario_id: userId },
    orderBy: { revisao: 'desc' },
    include: { itens: { orderBy: { compra_item_id: 'asc' } } },
  });
  const dados = {
    compraId,
    ativa: p.compra_ativo === 1,
    status: p.compra_status,
    valor: p.compra_valor?.toString() ?? null,
    limite: p.tb_usuario.usuario_meta_valor_compra?.toString() ?? null,
    horario: p.compra_horario.toISOString(),
    desconto: p.compra_desconto.toString(),
    email: p.compra_email,
    fonte: p.compra_fonte,
    contextoId: c?.contexto_id ?? null,
    contextoRevisao: c?.revisao ?? 0,
    respostas: respostasContextoSchema.parse(
      separarContextoPersistido(c?.respostas ?? {}).respostas,
    ),
    itens: p.tb_compra_item
      .filter((i) => i.compra_item_ativo === 1)
      .map((i) => ({
        itemId: i.compra_item_id,
        ativo: true,
        nome: i.compra_item_nome,
        valor: i.compra_item_valor.toString(),
        quantidade: i.compra_item_quantidade?.toString() ?? null,
        categoriaId: i.categoria_id,
        planejamento:
          c?.itens.find((ci) => ci.compra_item_id === i.compra_item_id)
            ?.planejamento ?? null,
      })),
  };
  const hash = createHash('sha256').update(canonical(dados)).digest('hex');
  return { dados, hash };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
type Row = Prisma.tb_rf018_avaliacaoGetPayload<object>;
function envelope(s: Snapshot, row: Row | null) {
  const motivos: string[] = [];
  if (row && row.versao_motor !== VERSAO_MOTOR)
    motivos.push('VERSAO_MOTOR_ALTERADA');
  if (row && row.fontes_hash !== s.hash)
    motivos.push('DADOS_UTILIZADOS_ALTERADOS');
  if (!s.dados.ativa) motivos.push('COMPRA_EXCLUIDA');
  const result = avaliacaoSaidaSchema.safeParse({
    versaoContrato: 1,
    compraId: s.dados.compraId,
    atualidade: !row
      ? 'SEM_AVALIACAO'
      : motivos.length
        ? 'DESATUALIZADA'
        : 'VIGENTE',
    motivos,
    avaliacaoId: row?.avaliacao_id ?? null,
    criadaEm: row?.criada_em.toISOString() ?? null,
    resultado: row && s.dados.ativa ? row.resultado : null,
  });
  if (!result.success) throw Error('RF018_ASSESSMENT_OUTPUT_INVALID');
  return result.data;
}
export class AvaliacaoService {
  static async consultar(
    userId: number,
    compraId: number,
    avaliacaoId?: number,
  ) {
    return prisma.$transaction(
      async (tx) => {
        const s = await snapshot(tx, userId, compraId);
        let row: Row | null;
        if (avaliacaoId !== undefined) {
          row = await tx.tb_rf018_avaliacao.findFirst({
            where: {
              avaliacao_id: avaliacaoId,
              compra_id: compraId,
              usuario_id: userId,
            },
          });
          if (!row) throw new AppError('Avaliação não encontrada', 404);
        } else {
          // A previous snapshot can become current again; prefer its deduplicated result.
          row = await tx.tb_rf018_avaliacao.findFirst({
            where: {
              compra_id: compraId,
              usuario_id: userId,
              versao_motor: VERSAO_MOTOR,
              fontes_hash: s.hash,
            },
            orderBy: { avaliacao_id: 'desc' },
          });
          row ??= await tx.tb_rf018_avaliacao.findFirst({
            where: { compra_id: compraId, usuario_id: userId },
            orderBy: { avaliacao_id: 'desc' },
          });
        }
        return envelope(s, row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  static async calcular(userId: number, compraId: number, raw: unknown) {
    const request = calcularAvaliacaoSchema.parse(raw);
    const persist = () =>
      prisma.$transaction(
        async (tx) => {
          const s = await snapshot(tx, userId, compraId),
            d = s.dados;
          if (!d.ativa)
            throw new AppError('Compra excluída não pode ser avaliada', 409);
          if (
            request.revisaoEsperada !== undefined &&
            request.revisaoEsperada !== d.contextoRevisao
          )
            throw new AppError(
              'Contexto alterado; recarregue antes de avaliar',
              409,
            );
          const resultado = interpretarCompra({
            compraId,
            ativa: d.ativa,
            status: d.status,
            valor: d.valor,
            limite: d.limite,
            contextoRevisao: d.contextoRevisao,
            respostas: d.respostas,
            itens: d.itens.map((i) => ({
              itemId: i.itemId,
              ativo: i.ativo,
              nome: i.nome,
              ...(i.planejamento === null
                ? {}
                : { planejamento: i.planejamento }),
            })),
          });
          const row = await tx.tb_rf018_avaliacao.upsert({
            where: {
              compra_id_versao_motor_fontes_hash: {
                compra_id: compraId,
                versao_motor: VERSAO_MOTOR,
                fontes_hash: s.hash,
              },
            },
            update: {},
            create: {
              compra_id: compraId,
              usuario_id: userId,
              contexto_id: d.contextoId,
              contexto_revisao: d.contextoRevisao,
              versao_contrato: 1,
              versao_motor: VERSAO_MOTOR,
              fontes_hash: s.hash,
              dados_utilizados: d,
              resultado,
            },
          });
          return row;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    let persisted;
    try {
      persisted = await persist();
    } catch (error) {
      // Native/emulated upsert or snapshot serialization can race. Retry once in
      // a new transaction; never continue querying an aborted PostgreSQL transaction.
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        !['P2002', 'P2034'].includes(error.code)
      )
        throw error;
      persisted = await persist();
    }
    // Re-read after persistence: a writer may have committed while the pure engine ran.
    // Validity is always relative to this fresh snapshot, not the calculation start.
    return AvaliacaoService.consultar(userId, compraId, persisted.avaliacao_id);
  }
}
