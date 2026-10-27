import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { businessPeriod, cents, parseMonth } from '../compra/financeiro.js';
import { AnaliseComportamentalService } from '../analise/comportamento.service.js';
import { homeResumoSchema } from './home.schemas.js';

const month = (date: Date) => businessPeriod(date);

export class HomeService {
  static async consultar(userId: number, periodo: string, now = new Date()) {
    parseMonth(periodo);
    const current = month(now);
    if (periodo > current) throw new AppError('Periodo futuro nao permitido', 400);
    return prisma.$transaction(async tx => {
      const user = await tx.tb_usuario.findFirst({ where: { usuario_id: userId, usuario_status: true },
        select: { usuario_data_criacao: true } });
      if (!user) throw new AppError('Usuario nao encontrado', 404);
      const first = await tx.tb_compra.findFirst({ where: { usuario_id: userId, compra_ativo: 1,
        compra_status: 'CONFIRMADA', compra_horario: { lt: now } },
        select: { compra_horario: true }, orderBy: [{ compra_horario: 'asc' }, { compra_id: 'asc' }] });
      const created = user.usuario_data_criacao;
      const validCreated = created instanceof Date && Number.isFinite(created.getTime()) && created <= now;
      let minimum = validCreated ? month(created) : current;
      let reason: 'CRIACAO_CONTA' | 'COMPRA_RETROATIVA' | 'DATA_CRIACAO_INDISPONIVEL' = validCreated ? 'CRIACAO_CONTA' : 'DATA_CRIACAO_INDISPONIVEL';
      if (first && month(first.compra_horario) < minimum) { minimum = month(first.compra_horario); reason = 'COMPRA_RETROATIVA'; }
      if (periodo < minimum) throw new AppError('Periodo anterior ao historico disponivel', 400);
      // Both metadata and ANALISE purchases are read from the same consistent snapshot.
      const snapshot = await AnaliseComportamentalService.consultarSnapshot(tx, userId, periodo, now);
      const f = snapshot.analise.indicadores.financeiro;
      const coverage = snapshot.analise.qualidade.cobertura;
      const historical = periodo !== current;
      const budget = historical || f.orcamentoMensal === null ? null : cents(f.orcamentoMensal);
      const known = cents(f.totalConhecido);
      const ratio = budget === null || f.qualidade === 'INSUFICIENTE' ? null : new Prisma.Decimal(known).mul(100).div(budget).toNumber();
      let state: 'VERDE' | 'AMARELO' | 'LARANJA' | 'VERMELHO' | 'NEUTRO' = 'NEUTRO';
      if (ratio !== null) {
        if (known > budget!) state = 'VERMELHO';
        else if (f.qualidade !== 'PARCIAL' && coverage === 'COMPLETA') state = known * 100 < budget! * 50 ? 'VERDE' : known * 100 < budget! * 75 ? 'AMARELO' : 'LARANJA';
      }
      return homeResumoSchema.parse({ versaoContrato: 1, periodo, referenciaTemporal: 'America/Sao_Paulo',
        perspectivas: {
          categorias: { disponibilidade: 'INDISPONIVEL', motivo: 'POLITICA_DE_PRIVACIDADE_NAO_VERIFICAVEL' },
          pagamentos: { disponibilidade: 'INDISPONIVEL', motivo: 'POLITICA_DE_PRIVACIDADE_NAO_VERIFICAVEL' },
          estabelecimentos: { disponibilidade: 'INDISPONIVEL', motivo: 'SEM_IDENTIFICACAO_CONFIAVEL' },
        },
        seletor: { periodoMinimo: minimum, periodoMaximo: current, motivoLimiteInicial: reason },
        financeiro: { comprasConfirmadas: f.comprasConfirmadas, comprasComValor: f.comprasComValor,
          comprasSemValor: f.comprasSemValor, totalConhecidoCentavos: known,
          totalCentavos: f.total === null ? null : cents(f.total), qualidade: f.qualidade, cobertura: coverage },
        orcamento: { disponibilidade: budget === null ? 'INDISPONIVEL' : 'REFERENCIA_ATUAL',
          valorCentavos: budget, percentualConhecido: ratio,
          excessoConhecidoCentavos: ratio === null || budget === null ? null : Math.max(0, known - budget),
          vigencia: historical ? 'NAO_COMPROVADA' : 'ATUAL_SEM_HISTORICO', estadoUtilizacao: state,
          motivo: historical ? 'ORCAMENTO_HISTORICO_NAO_COMPROVADO' : budget === null ? 'ORCAMENTO_AUSENTE_OU_INVALIDO' : f.qualidade === 'INSUFICIENTE' ? 'VALORES_DESCONHECIDOS' : null },
        limitacoes: [...new Set([...snapshot.analise.limitacoes,
          historical ? 'ORCAMENTO_HISTORICO_NAO_COMPROVADO' : 'ORCAMENTO_ATUAL_SEM_HISTORICO_DE_VIGENCIA'])],
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
