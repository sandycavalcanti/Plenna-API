import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { parseMonth, cents } from './financeiro.js';
import { ledgerDisponivel } from './eventos.service.js';
import { eventosVigentes } from './eventos.engine.js';
export class EventosResumoService {
  static async consultar(userId: number, periodo: string) {
    const { start, end } = parseMonth(periodo);
    return prisma.$transaction(
      async (tx) => {
        if (!(await ledgerDisponivel(tx)))
          return { disponivel: false as const };
        const rows = await tx.tb_compra_evento.findMany({
          where: {
            usuario_id: userId,
            compra: { compra_ativo: 1, compra_status: 'CONFIRMADA' },
          },
          include: {
            compra: { select: { compra_horario: true, compra_valor: true } },
          },
          orderBy: { revisao: 'asc' },
        });
        const vigente = eventosVigentes(rows),
          ids = new Set(rows.map((r) => r.compra_id));
        let cancelamentos = 0,
          devolucoes = 0,
          reembolsadoCentavos = 0,
          reembolsosSemData = 0,
          classificadasImpulsivas = 0;
        for (const e of vigente) {
          if (e.tipo === 'REEMBOLSO') {
            if (!e.efetiva_em) reembolsosSemData++;
            else if (e.efetiva_em >= start && e.efetiva_em < end)
              reembolsadoCentavos += Number(
                (e.dados as { valorCentavos: number }).valorCentavos,
              );
          }
        }
        for (const id of ids) {
          const purchase = rows.find((r) => r.compra_id === id)!.compra;
          if (purchase.compra_horario < start || purchase.compra_horario >= end)
            continue;
          const items = rows.filter((r) => r.compra_id === id),
            current = eventosVigentes(items);
          cancelamentos += current.some((e) => e.tipo === 'CANCELAMENTO')
            ? 1
            : 0;
          devolucoes += current.some((e) => e.tipo === 'DEVOLUCAO') ? 1 : 0;
          const c = current
            .filter((e) => e.tipo === 'CLASSIFICACAO')
            .sort((a, b) => b.revisao - a.revisao)[0];
          if (
            c &&
            (c.dados as { classificacao: string }).classificacao === 'IMPULSIVA'
          )
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
