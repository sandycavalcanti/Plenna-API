import { consultarUsoAplicativos } from './monitoramento.service.js';
import { descobrirCompra } from './descobertas.engine.js';
import { separarContextoPersistido } from './contexto-eventos.js';
import { dataElegivel, VERSAO_POLITICA_TEMPORAL } from './politica-temporal.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { businessDateKey, businessDayStart, businessMonthBounds, businessPeriod, cents, parseMonth } from '../compra/financeiro.js';
import {
  analisarHistorico,
  resumirValoresHistoricos,
} from './historico.engine.js';
import {
  entradaHistoricoSchema,
  historicoQuerySchema,
} from './historico.schemas.js';
import { respostasContextoSchema } from './contexto.schemas.js';
import { interpretarCompra } from './interpretacao.engine.js';
import { createHash } from 'node:crypto';
import { refletirHistorico } from './historico.reflexoes.js';

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

function readAnswers(raw: unknown) {
  const result = respostasContextoSchema.safeParse(
    separarContextoPersistido(raw).respostas,
  );
  if (!result.success) throw Error('ANALISE_HISTORY_CONTEXT_INVALID');
  return result.data;
}

export async function snapshot(
  tx: Prisma.TransactionClient,
  userId: number,
  periodo: string,
  meses: number,
  now: Date,
  cutoffOverride?: Date,
  somenteAutomatico = false,
) {
  const { start, end } = parseMonth(periodo);
  if (now <= start) throw new AppError('Período ainda não observado', 400);
  const cutoff =
    cutoffOverride ?? new Date(Math.min(now.getTime(), end.getTime()));
  const user = await tx.tb_usuario.findFirst({
    where: { usuario_id: userId, usuario_status: true },
    select: {
      usuario_meta_valor_mensal: true,
      usuario_meta_valor_compra: true,
      usuario_data_criacao: true,
    },
  });
  if (!user) throw new AppError('Usuário não encontrado', 404);
  const from = businessMonthBounds(
    start.getUTCFullYear(),
    start.getUTCMonth() - meses,
  ).start;
  const rows = await tx.tb_compra.findMany({
    where: {
      usuario_id: userId,
      compra_ativo: 1,
      compra_status: 'CONFIRMADA',
      compra_horario: { gte: from, lt: cutoff },
    },
    select: {
      compra_id: true,
      usuario_id: true,
      compra_ativo: true,
      compra_status: true,
      compra_horario: true,
      compra_valor: true,
      compra_email: true,
      compra_data_criacao: true,
      compra_recorrencia_id: true,
      tb_compra_item: {
        where: { compra_item_ativo: 1 },
        select: {
          compra_item_id: true,
          categoria_id: true,
          tb_categoria: { select: { categoria_nome: true } },
        },
      },
      contexto_compra_revisao: somenteAutomatico
        ? false
        : {
            orderBy: { revisao: 'desc' },
            take: 1,
            select: {
              revisao: true,
              respostas: true,
              criada_em: true,
              itens: { select: { compra_item_id: true, planejamento: true } },
            },
          },
    },
    orderBy: [{ compra_horario: 'asc' }, { compra_id: 'asc' }],
  });
  const recurring = somenteAutomatico
    ? []
    : await tx.tb_compra_recorrencia.findMany({
        where: { usuario_id: userId },
        select: {
          compra_recorrencia_id: true,
          compra_recorrencia_status: true,
        },
        orderBy: { compra_recorrencia_id: 'asc' },
      });
  const historical = periodo !== businessPeriod(now);
  const parsed = entradaHistoricoSchema.safeParse({
    usuarioId: userId,
    periodo,
    mesesHistorico: meses,
    observadoAte: cutoff.toISOString(),
    referenciaAtual: now.toISOString(),
    cobertura: 'DESCONHECIDA',
    inicioObservacao: user.usuario_data_criacao?.toISOString() ?? null,
    orcamentoAtual: historical
      ? null
      : (user.usuario_meta_valor_mensal?.toString() ?? null),
    compras: rows.map((row) => {
      // Prisma widens the nested payload when the relation selector can be false.
      const context = somenteAutomatico
        ? undefined
        : (row.contexto_compra_revisao[0] as unknown as
            | Prisma.contexto_compra_revisaoGetPayload<{
                select: {
                  revisao: true;
                  respostas: true;
                  criada_em: true;
                  itens: {
                    select: { compra_item_id: true; planejamento: true };
                  };
                };
              }>
            | undefined);
      if (context && !Array.isArray(context.itens))
        throw Error('ANALISE_HISTORY_CONTEXT_ITEMS_INVALID');
      return {
        id: row.compra_id,
        usuarioId: row.usuario_id,
        ativa: row.compra_ativo === 1,
        status: row.compra_status,
        data: row.compra_horario?.toISOString() ?? null,
        // O timestamp legado não comprova a precisão do instante da compra; preservamos apenas o dia.
        precisao: 'DIA',
        registradaEm: row.compra_data_criacao?.toISOString() ?? null,
        referenciaData: row.compra_email ? 'MENSAGEM_EMAIL' : 'DATA_REGISTRADA',
        valorLiquido: row.compra_valor?.toString() ?? null,
        origem: row.compra_email ? 'EMAIL' : 'MANUAL',
        categorias: row.tb_compra_item.flatMap((i) =>
          i.categoria_id === null ? [] : [i.categoria_id],
        ),
        categoriasCompletas:
          row.tb_compra_item.length > 0 &&
          row.tb_compra_item.every((i) => i.categoria_id !== null),
        nomesCategorias: row.tb_compra_item.flatMap((i) =>
          i.categoria_id && i.tb_categoria?.categoria_nome
            ? [{ id: i.categoria_id, nome: i.tb_categoria.categoria_nome }]
            : [],
        ),
        itensAtivos: row.tb_compra_item.map((i) => i.compra_item_id),
        recorrenciaId: row.compra_recorrencia_id,
        contexto: context
          ? {
              eventosPosteriores: separarContextoPersistido(context.respostas)
                .eventos,
              registradaEm: context.criada_em?.toISOString() ?? null,
              revisao: context.revisao,
              respostas: readAnswers(context.respostas),
              itens: context.itens
                .filter((i) =>
                  row.tb_compra_item.some(
                    (active) => active.compra_item_id === i.compra_item_id,
                  ),
                )
                .map((i) => ({
                  itemId: i.compra_item_id,
                  planejamento: i.planejamento,
                })),
            }
          : null,
      };
    }),
    recorrencias: recurring.map((r) => ({
      id: r.compra_recorrencia_id,
      status: r.compra_recorrencia_status,
    })),
  });
  if (!parsed.success) throw Error('ANALISE_HISTORY_SOURCE_INVALID');
  const input = parsed.data;
  return {
    historico: analisarHistorico(input),
    user,
    compras: input.compras.filter(dataElegivel),
    fontes: input,
  };
}

export class HistoricoService {
  static async consultar(userId: number, raw: unknown, now = new Date()) {
    const query = historicoQuerySchema.parse(raw);
    return prisma.$transaction(
      async (tx) =>
        (await snapshot(tx, userId, query.periodo, query.mesesHistorico, now))
          .historico,
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** Complementa a leitura atual sem regravar avaliações versionadas anteriormente. */
  static async complementarCompra(
    userId: number,
    compraId: number,
    now = new Date(),
  ) {
    const result = await prisma.$transaction(
      async (tx) => {
        const purchase = await tx.tb_compra.findFirst({
          where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
          select: {
            compra_id: true,
            compra_status: true,
            compra_horario: true,
            compra_valor: true,
            compra_email: true,
            compra_recorrencia_id: true,
            tb_compra_item: {
              where: { compra_item_ativo: 1 },
              select: { compra_item_id: true, compra_item_nome: true },
            },
          },
        });
        if (!purchase) throw new AppError('Compra não encontrada', 404);
        if (
          purchase.compra_status !== 'CONFIRMADA' ||
          purchase.compra_horario > now
        )
          throw new AppError('Compra ainda não elegível para histórico', 409);
        // No order within a day can be inferred from legacy timestamps.
        const day = businessDateKey(purchase.compra_horario);
        const { historico, user, compras, fontes } = await snapshot(
          tx,
          userId,
          day.slice(0, 7),
          6,
          now,
          businessDayStart(purchase.compra_horario),
        );
        const reference = resumirValoresHistoricos(compras);
        const context = await tx.contexto_compra_revisao.findFirst({
          where: { compra_id: compraId, usuario_id: userId },
          orderBy: { revisao: 'desc' },
          include: { itens: true },
        });
        const contextual = interpretarCompra({
          compraId,
          ativa: true,
          status: purchase.compra_status,
          valor: purchase.compra_valor?.toString() ?? null,
          limite: user.usuario_meta_valor_compra?.toString() ?? null,
          contextoRevisao: context?.revisao ?? 0,
          respostas: readAnswers(context?.respostas ?? {}),
          itens: purchase.tb_compra_item.map((i) => ({
            itemId: i.compra_item_id,
            ativo: true,
            nome: i.compra_item_nome,
            ...(context?.itens.some(
              (ci) => ci.compra_item_id === i.compra_item_id,
            )
              ? {
                  planejamento: context.itens.find(
                    (ci) => ci.compra_item_id === i.compra_item_id,
                  )!.planejamento,
                }
              : {}),
          })),
        });
        const comparacaoValorCompra = {
          valorLiquidoCentavos:
            purchase.compra_valor === null
              ? null
              : cents(purchase.compra_valor),
          referencia: 'MEDIANA_DAS_COMPRAS_ANTERIORES_A_DATA',
          amostra: reference.amostra,
          medianaHistoricaCentavos: reference.medianaCentavos,
          diferencaCentavos:
            reference.amostra >= 2 && purchase.compra_valor !== null
              ? cents(purchase.compra_valor) - reference.medianaCentavos!
              : null,
          disponibilidade:
            reference.amostra >= 2 && purchase.compra_valor !== null
              ? 'PARCIAL'
              : 'INDISPONIVEL',
        };
        const reflexoesHistoricas = refletirHistorico(historico, compras, {
          ...comparacaoValorCompra,
          compraId,
        });
        const descobertas = descobrirCompra({
          historico,
          compras,
          contextual,
          compra: {
            id: compraId,
            data: purchase.compra_horario.toISOString(),
            email: purchase.compra_email,
            valorCentavos: comparacaoValorCompra.valorLiquidoCentavos,
            limiteAtualCentavos:
              user.usuario_meta_valor_compra === null
                ? null
                : cents(user.usuario_meta_valor_compra),
            recorrenciaId: purchase.compra_recorrencia_id ?? null,
          },
          eventos: separarContextoPersistido(context?.respostas ?? {}).eventos,
        });
        const fontesHash = createHash('sha256')
          .update(
            canonical({
              fontes: {
                ...fontes,
                referenciaAtual: fontes.referenciaAtual?.slice(0, 7),
              },
              contextual,
              comparacaoValorCompra,
              descobertas,
              versaoPoliticaTemporal: VERSAO_POLITICA_TEMPORAL,
              versaoRegras: reflexoesHistoricas.versaoRegras,
            }),
          )
          .digest('hex');
        return {
          versaoContrato: 1,
          versaoComplemento: 'contextual-historico-1',
          compraId,
          contextual,
          historico,
          persistido: false,
          escopoHistorico:
            'ANTERIOR_A_DATA_REGISTRADA_SEM_EVENTOS_DO_MESMO_DIA',
          comparacaoValorCompra,
          reflexoesHistoricas,
          descobertas,
          consultadoEm: now.toISOString(),
          dependenciasHistoricas: {
            fontesHash,
            versaoDescobertas: descobertas.versao,
            versaoPoliticaTemporal: VERSAO_POLITICA_TEMPORAL,
            versaoIndicadores: historico.versaoIndicadores,
            versaoMotorContextual: contextual.versaoMotor,
            versaoRegras: reflexoesHistoricas.versaoRegras,
            contextoRevisao: contextual.contextoRevisao,
            periodo: historico.periodo,
            inicio: historico.janelaHistorico.inicio,
            fimExclusivo: historico.observadoAte,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const monitoramento = await consultarUsoAplicativos(
      userId,
      result.historico.periodo,
      now,
    );
    result.dependenciasHistoricas.fontesHash = createHash('sha256')
      .update(
        canonical({
          fontesHash: result.dependenciasHistoricas.fontesHash,
          monitoramento,
        }),
      )
      .digest('hex');
    return { ...result, monitoramento };
  }
}
