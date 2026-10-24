import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';

export type AutomationExecutionStatus = 'EM_ANDAMENTO' | 'CONCLUIDA' | 'INTERROMPIDA' | 'ERRO';

export type AutomationExecution = {
  id: number;
  key: string;
  status: AutomationExecutionStatus;
  cursorUserId: number | null;
  usersEvaluated: number;
  recommendationsGenerated: number;
  conversationsCreated: number;
  actionsSuppressed: number;
  errors: number;
  timeouts: number;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  reason: string | null;
};

export type AutomationAcquireResult =
  | { acquired: true; record: AutomationExecution }
  | { acquired: false; reason: 'CONCORRENCIA' | 'JA_CONCLUIDA'; record: AutomationExecution };

export type AutomationProgress = Partial<Pick<AutomationExecution,
  'cursorUserId' | 'usersEvaluated' | 'recommendationsGenerated' | 'conversationsCreated'
  | 'actionsSuppressed' | 'errors' | 'timeouts'>>;

export interface AutomationExecutionRepository {
  acquire(key: string, now: Date, leaseMs: number): Promise<AutomationAcquireResult>;
  progress(id: number, progress: AutomationProgress, now: Date): Promise<void>;
  finish(id: number, status: Exclude<AutomationExecutionStatus, 'EM_ANDAMENTO'>, reason: string, now: Date): Promise<void>;
}

const automationSelect = {
  ai_automacao_execucao_id: true,
  ai_automacao_chave: true,
  ai_automacao_status: true,
  ai_automacao_cursor_usuario_id: true,
  ai_automacao_usuarios_avaliados: true,
  ai_automacao_recomendacoes_geradas: true,
  ai_automacao_conversas_criadas: true,
  ai_automacao_acoes_suprimidas: true,
  ai_automacao_erros: true,
  ai_automacao_timeouts: true,
  ai_automacao_data_inicio: true,
  ai_automacao_data_atualizacao: true,
  ai_automacao_data_fim: true,
  ai_automacao_motivo: true,
} as const;

type AutomationRow = {
  ai_automacao_execucao_id: number;
  ai_automacao_chave: string;
  ai_automacao_status: string;
  ai_automacao_cursor_usuario_id: number | null;
  ai_automacao_usuarios_avaliados: number;
  ai_automacao_recomendacoes_geradas: number;
  ai_automacao_conversas_criadas: number;
  ai_automacao_acoes_suprimidas: number;
  ai_automacao_erros: number;
  ai_automacao_timeouts: number;
  ai_automacao_data_inicio: Date;
  ai_automacao_data_atualizacao: Date;
  ai_automacao_data_fim: Date | null;
  ai_automacao_motivo: string | null;
};

function mapRow(row: AutomationRow): AutomationExecution {
  const status = row.ai_automacao_status as AutomationExecutionStatus;
  return {
    id: row.ai_automacao_execucao_id,
    key: row.ai_automacao_chave,
    status,
    cursorUserId: row.ai_automacao_cursor_usuario_id,
    usersEvaluated: row.ai_automacao_usuarios_avaliados,
    recommendationsGenerated: row.ai_automacao_recomendacoes_geradas,
    conversationsCreated: row.ai_automacao_conversas_criadas,
    actionsSuppressed: row.ai_automacao_acoes_suprimidas,
    errors: row.ai_automacao_erros,
    timeouts: row.ai_automacao_timeouts,
    startedAt: row.ai_automacao_data_inicio,
    updatedAt: row.ai_automacao_data_atualizacao,
    finishedAt: row.ai_automacao_data_fim,
    reason: row.ai_automacao_motivo,
  };
}

function isUniqueError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function unavailable() {
  return new AppError('Automação indisponível', 503);
}

type AutomationDatabase = Pick<PrismaClient, 'tb_ai_automacao_execucao'>;

/**
 * Checkpoint persistente do job. A aquisição usa updateMany condicional para
 * que duas instâncias não executem a mesma chave ao mesmo tempo. Não há retry
 * automático após uma falha ambígua de escrita.
 */
export class PrismaAutomationExecutionRepository implements AutomationExecutionRepository {
  private readonly db: AutomationDatabase;

  constructor(db: AutomationDatabase = prisma) {
    this.db = db;
  }

  async acquire(key: string, now: Date, leaseMs: number): Promise<AutomationAcquireResult> {
    let current = await this.db.tb_ai_automacao_execucao.findUnique({
      where: { ai_automacao_chave: key },
      select: automationSelect,
    }) as AutomationRow | null;

    if (!current) {
      try {
        current = await this.db.tb_ai_automacao_execucao.create({
          data: { ai_automacao_chave: key, ai_automacao_status: 'EM_ANDAMENTO', ai_automacao_data_atualizacao: now },
          select: automationSelect,
        }) as AutomationRow;
      } catch (error) {
        if (!isUniqueError(error)) throw unavailable();
        current = await this.db.tb_ai_automacao_execucao.findUnique({
          where: { ai_automacao_chave: key },
          select: automationSelect,
        }) as AutomationRow | null;
        if (!current) throw unavailable();
      }
    }

    if (current.ai_automacao_status === 'CONCLUIDA') {
      return { acquired: false, reason: 'JA_CONCLUIDA', record: mapRow(current) };
    }

    const cutoff = new Date(now.getTime() - leaseMs);
    const takeover = await this.db.tb_ai_automacao_execucao.updateMany({
      where: {
        ai_automacao_execucao_id: current.ai_automacao_execucao_id,
        OR: [
          { ai_automacao_status: { in: ['INTERROMPIDA', 'ERRO'] } },
          { ai_automacao_status: 'EM_ANDAMENTO', ai_automacao_data_atualizacao: { lte: cutoff } },
        ],
      },
      data: {
        ai_automacao_status: 'EM_ANDAMENTO',
        ai_automacao_data_atualizacao: now,
        ai_automacao_data_fim: null,
        ai_automacao_motivo: null,
      },
    });

    if (takeover.count !== 1) {
      const latest = await this.db.tb_ai_automacao_execucao.findUnique({
        where: { ai_automacao_chave: key },
        select: automationSelect,
      }) as AutomationRow | null;
      if (!latest) throw unavailable();
      return {
        acquired: false,
        reason: latest.ai_automacao_status === 'CONCLUIDA' ? 'JA_CONCLUIDA' : 'CONCORRENCIA',
        record: mapRow(latest),
      };
    }

    const acquired = await this.db.tb_ai_automacao_execucao.findUnique({
      where: { ai_automacao_chave: key },
      select: automationSelect,
    }) as AutomationRow | null;
    if (!acquired) throw unavailable();
    return { acquired: true, record: mapRow(acquired) };
  }

  async progress(id: number, progress: AutomationProgress, now: Date) {
    const data: Record<string, number | Date | null> = {
      ai_automacao_data_atualizacao: now,
    };
    if (progress.cursorUserId !== undefined) data.ai_automacao_cursor_usuario_id = progress.cursorUserId;
    if (progress.usersEvaluated !== undefined) data.ai_automacao_usuarios_avaliados = progress.usersEvaluated;
    if (progress.recommendationsGenerated !== undefined) data.ai_automacao_recomendacoes_geradas = progress.recommendationsGenerated;
    if (progress.conversationsCreated !== undefined) data.ai_automacao_conversas_criadas = progress.conversationsCreated;
    if (progress.actionsSuppressed !== undefined) data.ai_automacao_acoes_suprimidas = progress.actionsSuppressed;
    if (progress.errors !== undefined) data.ai_automacao_erros = progress.errors;
    if (progress.timeouts !== undefined) data.ai_automacao_timeouts = progress.timeouts;
    try {
      const result = await this.db.tb_ai_automacao_execucao.updateMany({
        where: { ai_automacao_execucao_id: id, ai_automacao_status: 'EM_ANDAMENTO' },
        data,
      });
      if (result.count !== 1) throw unavailable();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  }

  async finish(id: number, status: Exclude<AutomationExecutionStatus, 'EM_ANDAMENTO'>, reason: string, now: Date) {
    try {
      const result = await this.db.tb_ai_automacao_execucao.updateMany({
        where: { ai_automacao_execucao_id: id, ai_automacao_status: 'EM_ANDAMENTO' },
        data: {
          ai_automacao_status: status,
          ai_automacao_motivo: reason,
          ai_automacao_data_atualizacao: now,
          ai_automacao_data_fim: now,
        },
      });
      if (result.count !== 1) throw unavailable();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  }
}
