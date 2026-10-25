import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { eventoCompraSchema } from './eventos.schemas.js';
import {
  eventosVigentes,
  resumirEventos,
  validarEventoFinanceiro,
} from './eventos.engine.js';
import { CompraService, softDeleteCompra } from './compra.service.js';
import { cents } from './financeiro.js';

export async function ledgerDisponivel(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<
    { tabela: string | null }[]
  >`SELECT to_regclass('public.tb_compra_evento')::text AS tabela`;
  return !!rows[0]?.tabela;
}
const hash = (v: unknown): string => {
  const canonical = (x: any): string =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? '{' +
        Object.keys(x)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(x[k]))
          .join(',') +
        '}'
      : JSON.stringify(x);
  return createHash('sha256').update(canonical(v)).digest('hex');
};
const serializar = (e: any) => ({
  id: e.evento_id,
  operacaoId: e.operacao_id,
  revisao: e.revisao,
  itemId: e.compra_item_id,
  tipo: e.tipo,
  dados: e.dados,
  dataEfetiva: e.efetiva_em?.toISOString().slice(0, 10) ?? null,
  registradaEm: e.registrada_em.toISOString(),
  origem: e.origem,
  corrigeEventoId: e.corrige_evento_id,
  anulado: e.anulado,
});
export class EventosCompraService {
  static async consultar(userId: number, compraId: number) {
    return prisma.$transaction(
      async (tx) => {
        const compra = await tx.tb_compra.findFirst({
          where: { compra_id: compraId, usuario_id: userId },
        });
        if (!compra) throw new AppError('Compra não encontrada', 404);
        if (!(await ledgerDisponivel(tx)))
          return {
            versaoContrato: 1,
            compraId,
            disponivel: false,
            revisao: 0,
            eventos: [],
            resumo: null,
          };
        const eventos = await tx.tb_compra_evento.findMany({
          where: { compra_id: compraId, usuario_id: userId },
          orderBy: { revisao: 'asc' },
        });
        return {
          versaoContrato: 1,
          compraId,
          disponivel: true,
          revisao: resumirEventos(eventos).revisao,
          eventos: eventos.map(serializar),
          resumo: {
            ...resumirEventos(eventos),
            valorOriginalCentavos:
              compra.compra_valor === null ? null : cents(compra.compra_valor),
            valorAposReembolsosCentavos:
              compra.compra_valor === null
                ? null
                : cents(compra.compra_valor) -
                  resumirEventos(eventos).reembolsadoCentavos,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  static async registrar(
    userId: number,
    compraId: number,
    raw: unknown,
    now = new Date(),
  ) {
    const data = eventoCompraSchema.parse(raw),
      fingerprint = hash(data);
    return prisma.$transaction(
      async (tx) => {
        const owned = await tx.$queryRaw<
          { compra_id: number }[]
        >`SELECT compra_id FROM public.tb_compra WHERE compra_id=${compraId} AND usuario_id=${userId} FOR UPDATE`;
        if (!owned.length) throw new AppError('Compra não encontrada', 404);
        if (!(await ledgerDisponivel(tx)))
          throw new AppError(
            'O histórico de operações ainda não está disponível neste ambiente',
            503,
          );
        const replay = await tx.tb_compra_evento.findUnique({
          where: {
            compra_id_operacao_id: {
              compra_id: compraId,
              operacao_id: data.operacaoId,
            },
          },
        });
        if (replay) {
          if (replay.requisicao_hash !== fingerprint)
            throw new AppError('Operação já utilizada com outro conteúdo', 409);
          return {
            versaoContrato: 1,
            compraId,
            persistido: true,
            evento: serializar(replay),
          };
        }
        const compra = await tx.tb_compra.findFirst({
          where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
          include: { tb_compra_item: { where: { compra_item_ativo: 1 } } },
        });
        if (!compra) throw new AppError('Compra não encontrada', 404);
        if (
          compra.compra_status !== 'CONFIRMADA' &&
          data.tipo !== 'EXCLUSAO_REGISTRO'
        )
          throw new AppError(
            'Confirme a compra antes de registrar esta operação',
            409,
          );
        const rows = await tx.tb_compra_evento.findMany({
          where: { compra_id: compraId, usuario_id: userId },
          orderBy: { revisao: 'asc' },
        });
        if (resumirEventos(rows).revisao !== data.revisaoEsperada)
          throw new AppError(
            'O histórico mudou. Atualize antes de salvar',
            409,
          );
        if (
          data.tipo === 'EXCLUSAO_REGISTRO' &&
          data.itemId &&
          eventosVigentes(rows).some(
            (e) =>
              e.compra_item_id === data.itemId &&
              ['REEMBOLSO', 'DEVOLUCAO', 'CANCELAMENTO'].includes(e.tipo),
          )
        )
          throw new AppError(
            'Corrija ou anule os eventos deste item antes de excluir o registro',
            409,
          );
        validarEventoFinanceiro(
          data,
          rows,
          {
            valorCentavos:
              compra.compra_valor === null ? null : cents(compra.compra_valor),
            itens: compra.tb_compra_item.map((i) => ({
              id: i.compra_item_id,
              quantidade:
                i.compra_item_quantidade === null
                  ? null
                  : Number(i.compra_item_quantidade),
              valorUnitarioCentavos: cents(i.compra_item_valor),
            })),
          },
          now,
        );
        if (data.tipo === 'REEMBOLSO' && data.itemId && !data.anulado) {
          const i = compra.tb_compra_item.find(
            (i) => i.compra_item_id === data.itemId,
          )!;
          if (i.compra_item_quantidade === null)
            throw new AppError(
              'Não é possível confirmar o teto deste item sem sua quantidade',
              422,
            );
          const total =
            eventosVigentes(rows)
              .filter(
                (e) =>
                  e.tipo === 'REEMBOLSO' &&
                  e.compra_item_id === data.itemId &&
                  e.evento_id !== data.corrigeEventoId,
              )
              .reduce(
                (n, e) =>
                  n +
                  Number((e.dados as { valorCentavos: number }).valorCentavos),
                0,
              ) + data.valorCentavos;
          if (
            total >
            cents(
              new Prisma.Decimal(i.compra_item_valor).mul(
                i.compra_item_quantidade,
              ),
            )
          )
            throw new AppError(
              'O reembolso supera o valor registrado do item',
              422,
            );
        }
        const {
          versaoContrato,
          operacaoId,
          revisaoEsperada,
          itemId,
          dataEfetiva,
          corrigeEventoId,
          anulado,
          tipo,
          ...dados
        } = data;
        const evento = await tx.tb_compra_evento.create({
          data: {
            compra_id: compraId,
            usuario_id: userId,
            compra_item_id: itemId ?? null,
            revisao: revisaoEsperada + 1,
            operacao_id: operacaoId,
            requisicao_hash: fingerprint,
            tipo,
            dados,
            efetiva_em: dataEfetiva
              ? new Date(dataEfetiva + 'T00:00:00Z')
              : null,
            corrige_evento_id: corrigeEventoId ?? null,
            anulado,
          },
        });
        if (data.tipo === 'CLASSIFICACAO')
          await tx.tb_compra.update({
            where: { compra_id: compraId },
            data: {
              compra_classificacao:
                data.classificacao === 'PREFIRO_NAO_CLASSIFICAR'
                  ? 'PENDENTE'
                  : data.classificacao,
            },
          });
        if (tipo === 'EXCLUSAO_REGISTRO') {
          if (itemId)
            await CompraService.deleteItem(userId, compraId, itemId, tx);
          else await softDeleteCompra(tx, userId, compraId, false);
        }
        return {
          versaoContrato: 1,
          compraId,
          persistido: true,
          evento: serializar(evento),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}
