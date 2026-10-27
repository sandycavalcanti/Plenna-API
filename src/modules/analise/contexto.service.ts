import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import {
  atualizarContextoSchema,
  contextoSaidaSchema,
  respostasContextoSchema,
} from './contexto.schemas.js';
import { selecionarPerguntas } from './perguntas.js';
import { CHAVE_EVENTOS, separarContextoPersistido } from './contexto-eventos.js';

// A ordenação canônica mantém a identidade de reenvios equivalentes e evita revisões duplicadas.
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
const include = { itens: { orderBy: { compra_item_id: 'asc' as const } } };
type Revision = Prisma.contexto_compra_revisaoGetPayload<{
  include: typeof include;
}>;
function output(
  compraId: number,
  row: Revision | null,
  activeIds: Set<number>,
) {
  const stored = separarContextoPersistido(row?.respostas ?? {});
  const result = contextoSaidaSchema.safeParse({
    versaoContrato: 1,
    compraId,
    revisao: row?.revisao ?? 0,
    criadaEm: row?.criada_em.toISOString() ?? null,
    respostas: stored.respostas,
    ...(stored.eventos === undefined
      ? {}
      : { eventosPosteriores: stored.eventos }),
    itens: (row?.itens ?? [])
      .filter((i) => activeIds.has(i.compra_item_id))
      .map((i) => ({ itemId: i.compra_item_id, planejamento: i.planejamento })),
  });
  if (!result.success) throw new Error('ANALISE_CONTEXT_OUTPUT_INVALID');
  return result.data;
}
export class ContextoService {
  static async historico(userId: number, compraId: number, antes?: number) {
    return prisma.$transaction(
      async (tx) => {
        const owned = await tx.tb_compra.findFirst({
          where: { compra_id: compraId, usuario_id: userId },
          select: { compra_id: true },
        });
        if (!owned) throw new AppError('Compra não encontrada', 404);
        const rows = await tx.contexto_compra_revisao.findMany({
          where: {
            compra_id: compraId,
            usuario_id: userId,
            ...(antes ? { revisao: { lt: antes } } : {}),
          },
          orderBy: { revisao: 'desc' },
          take: 51,
          include,
        });
        const revisoes = rows
          .slice(0, 50)
          .map((row) =>
            output(
              compraId,
              row,
              new Set(row.itens.map((i) => i.compra_item_id)),
            ),
          );
        return {
          versaoContrato: 1 as const,
          compraId,
          revisoes,
          proximaAntes:
            rows.length > 50 ? revisoes[revisoes.length - 1]!.revisao : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  static async perguntas(userId: number, compraId: number) {
    return prisma.$transaction(
      async (tx) => {
        const purchase = await tx.tb_compra.findFirst({
          where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
          select: {
            tb_compra_item: {
              where: { compra_item_ativo: 1 },
              select: { compra_item_id: true, compra_item_nome: true },
              orderBy: { compra_item_id: 'asc' },
            },
          },
        });
        if (!purchase) throw new AppError('Compra não encontrada', 404);
        const current = await tx.contexto_compra_revisao.findFirst({
          where: { compra_id: compraId, usuario_id: userId },
          orderBy: { revisao: 'desc' },
          include,
        });
        return selecionarPerguntas(
          output(
            compraId,
            current,
            new Set(purchase.tb_compra_item.map((i) => i.compra_item_id)),
          ),
          purchase.tb_compra_item.map((i) => ({
            itemId: i.compra_item_id,
            nome: i.compra_item_nome,
          })),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  static async consultar(userId: number, compraId: number) {
    return prisma.$transaction(
      async (tx) => {
        const purchase = await tx.tb_compra.findFirst({
          where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
          select: {
            tb_compra_item: {
              where: { compra_item_ativo: 1 },
              select: { compra_item_id: true },
            },
          },
        });
        if (!purchase) throw new AppError('Compra não encontrada', 404);
        const current = await tx.contexto_compra_revisao.findFirst({
          where: { compra_id: compraId, usuario_id: userId },
          orderBy: { revisao: 'desc' },
          include,
        });
        return output(
          compraId,
          current,
          new Set(purchase.tb_compra_item.map((i) => i.compra_item_id)),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  static async atualizar(userId: number, compraId: number, raw: unknown) {
    const data = atualizarContextoSchema.parse(raw);
    const hash = createHash('sha256')
      .update(
        canonical({
          ...data,
          itens: data.itens?.slice().sort((a, b) => a.itemId - b.itemId) ?? [],
        }),
      )
      .digest('hex');
    return prisma.$transaction(
      async (tx) => {
        // Same parent row lock used by purchase UPDATE/DELETE; serializes context writers.
        const purchases = await tx.$queryRaw<
          { compra_id: number }[]
        >`SELECT compra_id FROM public.tb_compra WHERE compra_id = ${compraId} AND usuario_id = ${userId} AND compra_ativo = 1 FOR UPDATE`;
        if (!purchases.length) throw new AppError('Compra não encontrada', 404);
        const active = await tx.tb_compra_item.findMany({
          where: { compra_id: compraId, compra_item_ativo: 1 },
          select: { compra_item_id: true },
        });
        const activeIds = new Set(active.map((i) => i.compra_item_id));
        const previousOperation = await tx.contexto_compra_revisao.findUnique(
          {
            where: {
              compra_id_operacao_id: {
                compra_id: compraId,
                operacao_id: data.operacaoId,
              },
            },
            include,
          },
        );
        if (previousOperation) {
          if (previousOperation.requisicao_hash !== hash)
            throw new AppError('Operação já utilizada com outro conteúdo', 409);
          // Return the original revision, never create another; inactive items remain hidden.
          return output(compraId, previousOperation, activeIds);
        }
        const current = await tx.contexto_compra_revisao.findFirst({
          where: { compra_id: compraId, usuario_id: userId },
          orderBy: { revisao: 'desc' },
          include,
        });
        if ((current?.revisao ?? 0) !== data.revisaoEsperada)
          throw new AppError(
            'Contexto alterado; consulte a revisão vigente',
            409,
          );
        if (data.itens?.some((i) => !activeIds.has(i.itemId)))
          throw new AppError(
            'Item não encontrado nesta compra ou excluído',
            404,
          );
        const stored = separarContextoPersistido(current?.respostas ?? {});
        const respostas = {
          ...respostasContextoSchema.parse(stored.respostas),
        };
        for (const [key, value] of Object.entries(data.respostas ?? {})) {
          if (value === null)
            delete (respostas as Record<string, unknown>)[key];
          else (respostas as Record<string, unknown>)[key] = value;
        }
        const itens = new Map(
          (current?.itens ?? [])
            .filter((i) => activeIds.has(i.compra_item_id))
            .map((i) => [i.compra_item_id, i.planejamento]),
        );
        for (const item of data.itens ?? []) {
          if (item.planejamento === null) itens.delete(item.itemId);
          else itens.set(item.itemId, item.planejamento);
        }
        const created = await tx.contexto_compra_revisao.create({
          data: {
            compra_id: compraId,
            usuario_id: userId,
            revisao: data.revisaoEsperada + 1,
            versao_schema: 1,
            operacao_id: data.operacaoId,
            requisicao_hash: hash,
            respostas: {
              ...respostas,
              ...((data.eventosPosteriores ?? stored.eventos) === undefined
                ? {}
                : {
                    [CHAVE_EVENTOS]: {
                      versao: 1,
                      eventos: data.eventosPosteriores ?? stored.eventos,
                    },
                  }),
            },
            // contexto_id and compra_id are inherited from the composite parent relation.
            itens: {
              create: [...itens]
                .sort(([a], [b]) => a - b)
                .map(
                  ([
                    compra_item_id,
                    planejamento,
                  ]): Prisma.contexto_compra_itemUncheckedCreateWithoutContextoInput => ({
                    compra_item_id,
                    planejamento,
                  }),
                ),
            },
          },
          include,
        });
        return output(compraId, created, activeIds);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}
