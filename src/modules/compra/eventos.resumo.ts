import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { parseMonth, cents } from './financeiro.js';
import { eventosVigentes, resumirEventos } from './eventos.engine.js';
export class EventosResumoService {
  static async consultar(userId: number, periodo: string) {
    const { start, end } = parseMonth(periodo);
    return prisma.$transaction(
      async (tx) => {
        const rows = await tx.tb_compra_evento.findMany({
          where: {
            usuario_id: userId,
            compra: { compra_ativo: 1, compra_status: 'CONFIRMADA', compra_horario: { lt: new Date() } },
          },
          include: {
            compra: { select: { compra_horario: true, compra_valor: true } },
          },
          orderBy: { revisao: 'asc' },
        });
        const vigente = eventosVigentes(rows);
        const porCompra = new Map<number, typeof rows>();
        for (const row of rows) {
          const items = porCompra.get(row.compra_id);
          if (items) items.push(row);
          else porCompra.set(row.compra_id, [row]);
        }
        let cancelamentos = 0,
          devolucoes = 0,
          reembolsadoCentavos = 0,
          reembolsosSemData = 0,
          classificadasImpulsivas = 0;
        for (const e of vigente) {
          if (e.tipo === 'REEMBOLSO') {
            if (!e.efetiva_em) reembolsosSemData++;
            // DATE representa um dia civil; converter sua meia-noite UTC para
            // São Paulo deslocaria reembolsos do primeiro dia para o mês anterior.
            else if (e.efetiva_em.toISOString().slice(0, 7) === periodo)
              reembolsadoCentavos += Number(
                (e.dados as { valorCentavos: number }).valorCentavos,
              );
          }
        }
        for (const items of porCompra.values()) {
          const purchase = items[0].compra;
          if (purchase.compra_horario < start || purchase.compra_horario >= end)
            continue;
          const current = eventosVigentes(items);
          cancelamentos += current.some((e) => e.tipo === 'CANCELAMENTO')
            ? 1
            : 0;
          devolucoes += current.some((e) => e.tipo === 'DEVOLUCAO') ? 1 : 0;
          const resumo=resumirEventos(items);
          if (!resumo.oculto&&!resumo.itensOcultos.length&&!resumo.cancelamentos&&resumo.classificacao==='IMPULSIVA')
            classificadasImpulsivas++;
        }
        return {
          disponivel: true as const,
          periodo,
          cancelamentos,
          devolucoes,
          reembolsadoCentavos,
          reembolsosSemData,
          classificadasImpulsivas,
          referenciaReembolsos: 'DATA_EFETIVA_DECLARADA',
          referenciaDecisoes: 'MES_DA_COMPRA',
          alteraValorOriginal: false,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
