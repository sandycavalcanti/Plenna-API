import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { snapshot } from './historico.service.js';
import {
  avaliarAutomaticamente,
  type ComplementosAutomaticos,
} from './analise-automatica.engine.js';
import {
  referenciaNaData,
} from '../compra/referencias.service.js';
import { resumirEventos } from '../compra/eventos.engine.js';
import { businessDateKey, businessDayStart, cents } from '../compra/financeiro.js';
import { separarContextoPersistido } from './contexto-eventos.js';
import { respostasContextoSchema } from './contexto.schemas.js';

export class AnaliseAutomaticaService {
  static async periodo(userId: number, periodo: string, now = new Date()) {
    const result = await prisma.$transaction(
      async (tx) => {
        const { fontes } = await snapshot(
          tx,
          userId,
          periodo,
          6,
          now,
          undefined,
          true,
        );
        return avaliarAutomaticamente(fontes);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { ...result, avaliadoEm: now.toISOString() };
  }
  static async compra(userId: number, compraId: number, now = new Date()) {
    const result = await prisma.$transaction(
      async (tx) => {
        const p = await tx.tb_compra.findFirst({
          where: { compra_id: compraId, usuario_id: userId, compra_ativo: 1 },
          include: { tb_compra_item: { where: { compra_item_ativo: 1 } } },
        });
        if (!p) throw new AppError('Compra não encontrada', 404);
        if (p.compra_status !== 'CONFIRMADA' || p.compra_horario > now)
          throw new AppError('Compra não elegível para análise', 409);
        const day = businessDateKey(p.compra_horario);
        const { fontes, user } = await snapshot(
          tx,
          userId,
          day.slice(0, 7),
          6,
          now,
          businessDayStart(p.compra_horario),
          true,
        );
        const refs = await tx.tb_referencia_financeira.findMany({
          where: { usuario_id: userId, tipo: 'LIMITE_COMPRA' },
          orderBy: [{ vigente_desde: 'desc' }, { referencia_id: 'desc' }],
        });
        let historical = referenciaNaData(
          refs,
          'LIMITE_COMPRA',
          p.compra_horario,
        );
        if (
          refs[0] &&
          String(refs[0].valor) !== String(user.usuario_meta_valor_compra)
        )
          historical = null;
        const events = resumirEventos(
          await tx.tb_compra_evento.findMany({
            where: { compra_id: compraId, usuario_id: userId },
            orderBy: { revisao: 'asc' },
          }),
        );
        const complementos: ComplementosAutomaticos = {
          limiteHistoricoCentavos:
            historical?.valor == null
              ? null
              : cents(historical.valor as Prisma.Decimal),
          limiteAtualCentavos:
            user.usuario_meta_valor_compra == null
              ? null
              : cents(user.usuario_meta_valor_compra),
          eventos: {
            disponivel: true,
            reembolsadoCentavos: events.reembolsadoCentavos,
            cancelamentos: events.cancelamentos,
            devolucoes: events.devolucoes,
          },
        };
        const alvo = {
          id: compraId,
          usuarioId: userId,
          ativa: true,
          status: 'CONFIRMADA' as const,
          data: p.compra_horario.toISOString(),
          precisao: 'DIA' as const,
          valorLiquido: p.compra_valor?.toString() ?? null,
          origem: p.compra_email ? ('EMAIL' as const) : ('MANUAL' as const),
          categorias: p.tb_compra_item.flatMap((i) =>
            i.categoria_id ? [i.categoria_id] : [],
          ),
          categoriasCompletas:
            p.tb_compra_item.length > 0 &&
            p.tb_compra_item.every((i) => i.categoria_id !== null),
          itensAtivos: p.tb_compra_item.map((i) => i.compra_item_id),
          recorrenciaId: p.compra_recorrencia_id,
          contexto: null,
        };
        return { fontes, alvo, complementos };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    // As respostas são opcionais: uma falha contextual não deve impedir os fatos automáticos nem regravar avaliações.
    try {
      const row = await prisma.contexto_compra_revisao.findFirst({
        where: { usuario_id: userId, compra_id: compraId },
        orderBy: { revisao: 'desc' },
        select: { revisao: true, respostas: true },
      });
      const respostas = respostasContextoSchema.parse(
        separarContextoPersistido(row?.respostas ?? {}).respostas,
      );
      result.complementos.contexto = {
        disponibilidade: 'DISPONIVEL',
        revisao: row?.revisao ?? 0,
        respostas,
      };
    } catch {
      result.complementos.contexto = {
        disponibilidade: 'INDISPONIVEL',
        revisao: 0,
        respostas: {},
      };
    }
    return {
      ...avaliarAutomaticamente(
        result.fontes,
        result.alvo,
        result.complementos,
      ),
      avaliadoEm: now.toISOString(),
    };
  }
}
