import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { parseMonth, financialWhere } from '../compra/financeiro.js';
import { analisarPeriodo } from './rf018.engine.js';
import { recomendar } from '../recomendacao/recomendacao.engine.js';

export class RF018Service {
  static async consultar(userId: number, periodo: string, now = new Date()) {
    const { start } = parseMonth(periodo);
    if (now <= start) throw new AppError('Período ainda não observado', 400);
    return prisma.$transaction(async tx => {
      return RF018Service.consultarSnapshot(tx, userId, periodo, now);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  /** Shared read snapshot; caller owns the transaction. No persistence. */
  static async consultarSnapshot(tx: Prisma.TransactionClient, userId: number, periodo: string, now = new Date()) {
      const { start, end } = parseMonth(periodo);
      if (now <= start) throw new AppError('Periodo ainda nao observado', 400);
      const cutoff = new Date(Math.min(now.getTime(), end.getTime()));
      const user = await tx.tb_usuario.findFirst({ where: { usuario_id: userId, usuario_status: true }, select: { usuario_meta_valor_compra: true, usuario_meta_valor_mensal: true } });
      if (!user) throw new AppError('Usuário não encontrado', 404);
      const rows = await tx.tb_compra.findMany({
        where: { ...financialWhere(userId, start), compra_horario: { gte: start, lt: cutoff } },
        select: { compra_id: true, usuario_id: true, compra_ativo: true, compra_status: true, compra_horario: true, compra_valor: true, compra_email: true,
          tb_compra_item: { where: { compra_item_ativo: 1 }, select: { categoria_id: true, tb_categoria: { select: { categoria_id: true, categoria_nome: true } } } } },
        orderBy: { compra_id: 'asc' },
      });
      const categories = new Map<number, string>();
      for (const row of rows) for (const item of row.tb_compra_item) if (item.tb_categoria) categories.set(item.tb_categoria.categoria_id, item.tb_categoria.categoria_nome);
      const analise = analisarPeriodo({
        versaoContrato: 1, usuarioId: userId,
        janela: { periodo, observadoAte: cutoff.toISOString(), cobertura: 'DESCONHECIDA' },
        compras: rows.map(row => ({ id: row.compra_id, usuarioId: row.usuario_id, ativa: row.compra_ativo === 1, status: row.compra_status,
          horario: row.compra_horario?.toISOString() ?? null, precisaoHorario: 'DESCONHECIDO', valorLiquido: row.compra_valor?.toString() ?? null,
          categorias: row.tb_compra_item.flatMap(item => item.categoria_id === null ? [] : [item.categoria_id]),
          origem: row.compra_email ? 'EMAIL' : 'MANUAL', referencias: [`registro-compra:${row.compra_id}`] })),
        limiteIndividual: { valor: user.usuario_meta_valor_compra?.toString() ?? null, vigencia: 'ATUAL_SEM_HISTORICO', referencia: 'perfil:limite-atual' },
        orcamentoMensal: { valor: user.usuario_meta_valor_mensal?.toString() ?? null, vigencia: 'ATUAL_SEM_HISTORICO', referencia: 'perfil:orcamento-atual' },
      });
      return { versaoContrato: 1, analise, recomendacoes: recomendar(analise), categorias: [...categories].sort(([a], [b]) => a - b).map(([id, nome]) => ({ id, nome })) };
  }
}
