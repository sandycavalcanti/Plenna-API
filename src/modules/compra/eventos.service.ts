import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { eventoCompraSchema } from './eventos.schemas.js';
import {
  eventosVigentes,
  criarResumoEventosDesc,
  resumirEventos,
  validarEventoFinanceiro,
} from './eventos.engine.js';
import { CompraService, softDeleteCompra } from './compra.service.js';
import { cents } from './financeiro.js';
import { AvaliacaoService } from '../analise/avaliacao.service.js';

export async function ledgerDisponivel(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<{ tabela: string | null }[]>`
    SELECT to_regclass('public.tb_compra_evento')::text AS tabela
  `;
  return rows[0]?.tabela !== null && rows[0]?.tabela !== undefined;
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
  static async historico(userId: number, compraId: number, query: { antes?: number; itemId?: number; escopo?: 'COMPRA' | 'ITENS'; finalidade?: 'COMPRA' | 'ANALISE' }) {
    return prisma.$transaction(async tx => {
      const compra = await tx.tb_compra.findFirst({ where: { compra_id: compraId, usuario_id: userId }, select: { compra_id: true } });
      if (!compra) throw new AppError('Compra não encontrada', 404);
      if (query.itemId !== undefined && !await tx.tb_compra_item.findFirst({ where: { compra_id: compraId, compra_item_id: query.itemId }, select: { compra_item_id: true } })) throw new AppError('Item não encontrado',404);
      const rows = await tx.tb_compra_evento.findMany({
        where: { usuario_id: userId, compra_id: compraId,
          ...(query.finalidade ? { tipo: query.finalidade === 'ANALISE' ? { in: ['CLASSIFICACAO', 'RESPOSTA_ANALISE'] } : { notIn: ['CLASSIFICACAO', 'RESPOSTA_ANALISE'] } } : {}),
          ...(query.antes ? { revisao: { lt: query.antes } } : {}),
          ...(query.itemId !== undefined ? { compra_item_id: query.itemId } : query.escopo === 'COMPRA' ? { compra_item_id: null } : query.escopo === 'ITENS' ? { compra_item_id: { not: null } } : {}),
        }, orderBy: { revisao: 'desc' }, take: 51,
        include: { correcoes: { select: { evento_id: true } } },
      });
      const page=rows.slice(0,50);
      return { versaoContrato: 1, compraId, eventos: page.map(row=>({...serializar(row),corrigido:row.correcoes.length>0})), proximaAntes: rows.length>50?page[49]!.revisao:null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  static async consultar(userId: number, compraId: number, compacto = false) {
    return prisma.$transaction(
      async (tx) => {
        const compra = await tx.tb_compra.findFirst({
          where: { compra_id: compraId, usuario_id: userId },
        });
        if (!compra) throw new AppError('Compra não encontrada', 404);
        const eventos: Awaited<ReturnType<typeof tx.tb_compra_evento.findMany>>=[];
        const acumulador=criarResumoEventosDesc();
        if(compacto){
          let antes:number|undefined;
          while(true){
            const page=await tx.tb_compra_evento.findMany({where:{compra_id:compraId,usuario_id:userId,...(antes?{revisao:{lt:antes}}:{})},orderBy:{revisao:'desc'},take:200});
            for(const row of page){acumulador.adicionar(row);if(eventos.length<50)eventos.push(row);}
            if(page.length<200)break;
            antes=page[page.length-1]!.revisao;
          }
          eventos.reverse();
        }else eventos.push(...await tx.tb_compra_evento.findMany({where:{compra_id:compraId,usuario_id:userId},orderBy:{revisao:'asc'}}));
        const resumo=compacto?acumulador.resultado():resumirEventos(eventos);
        return {
          versaoContrato: 1,
          compraId,
          disponivel: true,
          revisao: resumo.revisao,
          eventos: (compacto ? eventos.slice(-50) : eventos).map(serializar),
          resumo: {
            ...resumo,
            valorOriginalCentavos:
              compra.compra_valor === null ? null : cents(compra.compra_valor),
            valorAposReembolsosCentavos:
              compra.compra_valor === null
                ? null
                : cents(compra.compra_valor) -
                  resumo.reembolsadoCentavos,
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
        await tx.$queryRaw`SELECT usuario_id FROM public.tb_usuario WHERE usuario_id=${userId} FOR UPDATE`;
        const owned = await tx.$queryRaw<
          { compra_id: number }[]
        >`SELECT compra_id FROM public.tb_compra WHERE compra_id=${compraId} AND usuario_id=${userId} FOR UPDATE`;
        if (!owned.length) throw new AppError('Compra não encontrada', 404);
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
        if(data.tipo==='RESPOSTA_ANALISE') {
          if(data.itemId||data.corrigeEventoId||data.anulado||data.dataEfetiva!==null)
            throw new AppError('A resposta é da avaliação atual da compra; revisões são novos eventos',400);
          if(data.confirmarImpulsiva&&data.resposta!=='CONCORDO')
            throw new AppError('Somente a concordância explícita pode confirmar como impulsiva',400);
          const situacao=resumirEventos(rows);
          if(situacao.oculto||situacao.itensOcultos.length||situacao.cancelamentos)
            throw new AppError('Análise indisponível para esta compra',409);
          const avaliacao=await AvaliacaoService.consultarNaTransacao(tx,userId,compraId,data.avaliacaoId);
          if(avaliacao.atualidade!=='VIGENTE'||avaliacao.resultado?.versaoMotor!==data.versaoMotor)
            throw new AppError('A avaliação mudou. Atualize antes de responder',409);
          if(!data.interpretacaoId.startsWith(`${data.versaoInterpretacao}:compositor-contextual-1:${data.avaliacaoId}:`))
            throw new AppError('Referência de interpretação inválida',400);
        }
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
        const classificacaoAnterior=compra.compra_classificacao;
        const dadosDecisao=data.tipo==='RESPOSTA_ANALISE'
          ? {...dados,classificacaoAnterior,origemDecisao:data.confirmarImpulsiva?'CONFIRMACAO_ANALISE':'RESPOSTA_ANALISE',...(data.confirmarImpulsiva?{classificacao:'IMPULSIVA'}:{})}
          : data.tipo==='CLASSIFICACAO'?{...dados,classificacaoAnterior,origemDecisao:'CLASSIFICACAO_VOLUNTARIA'}:dados;
        const evento = await tx.tb_compra_evento.create({
          data: {
            compra_id: compraId,
            usuario_id: userId,
            compra_item_id: itemId ?? null,
            revisao: revisaoEsperada + 1,
            operacao_id: operacaoId,
            requisicao_hash: fingerprint,
            tipo,
            dados: dadosDecisao,
            efetiva_em: dataEfetiva
              ? new Date(dataEfetiva + 'T00:00:00Z')
              : null,
            corrige_evento_id: corrigeEventoId ?? null,
            anulado,
          },
        });
        if (data.tipo === 'CLASSIFICACAO' || data.tipo==='RESPOSTA_ANALISE'&&data.confirmarImpulsiva)
          await tx.tb_compra.update({
            where: { compra_id: compraId },
            data: {
              compra_classificacao:
                data.tipo==='RESPOSTA_ANALISE'?'IMPULSIVA':data.classificacao === 'PREFIRO_NAO_CLASSIFICAR'
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
