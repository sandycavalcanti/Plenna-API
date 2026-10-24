import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
import { CONSENTIMENTO_CODIGOS, type ConsentimentoCodigo } from '../consentimento/consentimento.constants.js';
import { recommendationService } from '../recomendacao/recomendacao.service.js';
import { proactivityService } from '../proatividade/proatividade.service.js';
import {
  PrismaAutomationExecutionRepository,
  type AutomationExecution,
  type AutomationExecutionRepository,
  type AutomationProgress,
} from './automacao.repository.js';

export type AutomationSettings = {
  enabled: boolean;
  batchSize: number;
  maxUsers: number;
  timeoutMs: number;
  maxErrors: number;
  maxRecommendationCalls: number;
  maxProactivityCalls: number;
  leaseMs: number;
  timezone: string;
};

type ActiveUserSelector = {
  listActive(afterUserId: number | null, limit: number): Promise<number[]>;
};

type ConsentReader = (userId: number, code: ConsentimentoCodigo) => Promise<boolean>;
type RecommendationRunner = (userId: number, periodo: string, now: Date) => Promise<{ itens?: unknown[] }>;
type ProactivityRunner = (userId: number, options: { now: Date; persist: true; timezone: string }) => Promise<{ estado?: string }>;

export type AutomationJobDependencies = {
  repository?: AutomationExecutionRepository;
  users?: ActiveUserSelector;
  consent?: ConsentReader;
  recommendations?: RecommendationRunner;
  proactivity?: ProactivityRunner;
  settings?: Partial<AutomationSettings>;
};

export type AutomationJobResult = {
  status: 'DESABILITADA' | 'CONCORRENCIA' | 'JA_CONCLUIDA' | 'CONCLUIDA' | 'INTERROMPIDA';
  reason: string;
  executionId: number | null;
  usersEvaluated: number;
  recommendationsGenerated: number;
  conversationsCreated: number;
  actionsSuppressed: number;
  errors: number;
  timeouts: number;
  recommendationCalls: number;
  proactivityCalls: number;
};

type AutomationDatabase = Pick<PrismaClient, 'tb_usuario'>;

export class PrismaActiveUserSelector implements ActiveUserSelector {
  private readonly db: AutomationDatabase;

  constructor(db: AutomationDatabase = prisma) {
    this.db = db;
  }

  async listActive(afterUserId: number | null, limit: number) {
    const rows = await this.db.tb_usuario.findMany({
      where: { usuario_status: true, ...(afterUserId === null ? {} : { usuario_id: { gt: afterUserId } }) },
      orderBy: { usuario_id: 'asc' },
      take: limit,
      select: { usuario_id: true },
    });
    return rows.map((row) => row.usuario_id);
  }
}

function defaultSettings(): AutomationSettings {
  return {
    enabled: env.aiAutomationEnabled,
    batchSize: env.aiAutomationBatchSize,
    maxUsers: env.aiAutomationMaxUsers,
    timeoutMs: env.aiAutomationTimeoutMs,
    maxErrors: env.aiAutomationMaxErrors,
    maxRecommendationCalls: env.aiAutomationMaxRecommendationCalls,
    maxProactivityCalls: env.aiAutomationMaxProactivityCalls,
    leaseMs: env.aiAutomationLeaseMs,
    timezone: env.aiAutomationTimezone,
  };
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return {
    year: parts.find((part) => part.type === 'year')?.value ?? '0000',
    month: parts.find((part) => part.type === 'month')?.value ?? '01',
    day: parts.find((part) => part.type === 'day')?.value ?? '01',
  };
}

function periodFor(date: Date, timezone: string) {
  const parts = zonedParts(date, timezone);
  return `${parts.year}-${parts.month}`;
}

function dayKeyFor(date: Date, timezone: string) {
  const parts = zonedParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

class AutomationTimeout extends Error {
  constructor() {
    super('automation timeout');
    this.name = 'AutomationTimeout';
  }
}

function isAutomationTimeout(error: unknown): error is AutomationTimeout {
  return error instanceof AutomationTimeout;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new AutomationTimeout()), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeErrorCode(error: unknown) {
  return error instanceof Error && error.name ? error.name.slice(0, 40) : 'ERRO_DESCONHECIDO';
}

function resultFromRecord(
  status: AutomationJobResult['status'],
  reason: string,
  executionId: number | null,
  record: Pick<AutomationExecution, 'usersEvaluated' | 'recommendationsGenerated' | 'conversationsCreated' | 'actionsSuppressed' | 'errors' | 'timeouts'>,
  recommendationCalls = 0,
  proactivityCalls = 0,
): AutomationJobResult {
  return {
    status,
    reason,
    executionId,
    usersEvaluated: record.usersEvaluated,
    recommendationsGenerated: record.recommendationsGenerated,
    conversationsCreated: record.conversationsCreated,
    actionsSuppressed: record.actionsSuppressed,
    errors: record.errors,
    timeouts: record.timeouts,
    recommendationCalls,
    proactivityCalls,
  };
}

export class AutomationJobService {
  private readonly repository: AutomationExecutionRepository;
  private readonly users: ActiveUserSelector;
  private readonly consent: ConsentReader;
  private readonly recommendations: RecommendationRunner;
  private readonly proactivity: ProactivityRunner;
  private readonly settings: AutomationSettings;

  constructor(dependencies: AutomationJobDependencies = {}) {
    this.repository = dependencies.repository ?? new PrismaAutomationExecutionRepository();
    this.users = dependencies.users ?? new PrismaActiveUserSelector();
    this.consent = dependencies.consent ?? ((userId, code) => ConsentimentoService.temConsentimentoAtivo(userId, code));
    this.recommendations = dependencies.recommendations
      ?? ((userId, periodo, now) => recommendationService.generateForUser(userId, periodo, now, undefined, { persist: true }));
    this.proactivity = dependencies.proactivity ?? ((userId, options) => proactivityService.processUser(userId, options));
    this.settings = { ...defaultSettings(), ...dependencies.settings };
  }

  async run(options: { now?: Date; periodo?: string } = {}): Promise<AutomationJobResult> {
    const now = options.now ?? new Date();
    if (!this.settings.enabled) {
      return resultFromRecord('DESABILITADA', 'FLAG_DESABILITADA', null, {
        usersEvaluated: 0, recommendationsGenerated: 0, conversationsCreated: 0,
        actionsSuppressed: 0, errors: 0, timeouts: 0,
      });
    }

    const timezone = this.settings.timezone;
    const key = `rf026-rf027:${dayKeyFor(now, timezone)}`;
    const periodo = options.periodo ?? periodFor(now, timezone);
    const acquired = await this.repository.acquire(key, now, this.settings.leaseMs);
    if (!acquired.acquired) {
      const status = acquired.reason === 'JA_CONCLUIDA' ? 'JA_CONCLUIDA' : 'CONCORRENCIA';
      return resultFromRecord(status, acquired.reason, acquired.record.id, acquired.record);
    }

    const state = { ...acquired.record };
    let recommendationCalls = 0;
    let proactivityCalls = 0;
    let errorsThisRun = 0;
    let finalStatus: 'CONCLUIDA' | 'INTERROMPIDA' = 'CONCLUIDA';
    let finalReason = 'SEM_USUARIOS_PENDENTES';
    const startedAt = Date.now();
    const deadline = startedAt + this.settings.timeoutMs;
    let usersThisRun = 0;

    console.info('ai_automation_inicio', { executionId: state.id });

    try {
      let stopAfterUser = false;
      while (!stopAfterUser) {
        const remainingUsers = this.settings.maxUsers - usersThisRun;
        if (remainingUsers <= 0) {
          finalStatus = 'INTERROMPIDA';
          finalReason = 'LIMITE_USUARIOS';
          break;
        }
        const remainingTime = deadline - Date.now();
        if (remainingTime <= 0) {
          finalStatus = 'INTERROMPIDA';
          finalReason = 'TIMEOUT_EXECUCAO';
          break;
        }

        const take = Math.min(this.settings.batchSize, remainingUsers);
        const userIds = await withTimeout(this.users.listActive(state.cursorUserId, take), remainingTime);
        if (userIds.length === 0) break;

        for (const userId of userIds) {
          if (Date.now() >= deadline) {
            finalStatus = 'INTERROMPIDA';
            finalReason = 'TIMEOUT_EXECUCAO';
            stopAfterUser = true;
            break;
          }

          let timedOut = false;
          try {
            if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('invalid selected user');
            const userTimeout = Math.max(1, deadline - Date.now());
            const personalized = await withTimeout(
              this.consent(userId, CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO),
              userTimeout,
            );
            if (personalized) {
              if (recommendationCalls >= this.settings.maxRecommendationCalls) {
                finalStatus = 'INTERROMPIDA';
                finalReason = 'LIMITE_CHAMADAS_RECOMENDACAO';
                stopAfterUser = true;
              } else {
                recommendationCalls += 1;
                const generated = await withTimeout(
                  this.recommendations(userId, periodo, now),
                  Math.max(1, deadline - Date.now()),
                );
                state.recommendationsGenerated += Array.isArray(generated.itens) ? generated.itens.length : 0;

                if (Array.isArray(generated.itens) && generated.itens.length > 0) {
                  const proactivityAllowed = await withTimeout(
                    this.consent(userId, CONSENTIMENTO_CODIGOS.IA_PROATIVIDADE),
                    Math.max(1, deadline - Date.now()),
                  );
                  if (proactivityAllowed) {
                    if (proactivityCalls >= this.settings.maxProactivityCalls) {
                      finalStatus = 'INTERROMPIDA';
                      finalReason = 'LIMITE_CHAMADAS_PROATIVIDADE';
                      stopAfterUser = true;
                    } else {
                      proactivityCalls += 1;
                      const proactive = await withTimeout(
                        this.proactivity(userId, { now, persist: true, timezone }),
                        Math.max(1, deadline - Date.now()),
                      );
                      if (proactive.estado === 'CRIADA') state.conversationsCreated += 1;
                      else if (proactive.estado !== 'EXISTENTE') state.actionsSuppressed += 1;
                    }
                  } else {
                    state.actionsSuppressed += 1;
                  }
                }
              }
            } else {
              state.actionsSuppressed += 1;
            }
          } catch (error) {
            timedOut = isAutomationTimeout(error);
            state.errors += 1;
            errorsThisRun += 1;
            if (timedOut) state.timeouts += 1;
            console.warn('ai_automation_usuario_falhou', { executionId: state.id, codigo: safeErrorCode(error) });
          }

          state.usersEvaluated += 1;
          usersThisRun += 1;
          state.cursorUserId = userId;
          const progress: AutomationProgress = {
            cursorUserId: state.cursorUserId,
            usersEvaluated: state.usersEvaluated,
            recommendationsGenerated: state.recommendationsGenerated,
            conversationsCreated: state.conversationsCreated,
            actionsSuppressed: state.actionsSuppressed,
            errors: state.errors,
            timeouts: state.timeouts,
          };
          await this.repository.progress(state.id, progress, new Date());

          if (errorsThisRun >= this.settings.maxErrors) {
            finalStatus = 'INTERROMPIDA';
            finalReason = 'LIMITE_ERROS';
            stopAfterUser = true;
          } else if (timedOut) {
            finalStatus = 'INTERROMPIDA';
            finalReason = 'TIMEOUT_USUARIO';
            stopAfterUser = true;
          }
          if (stopAfterUser) break;
        }
      }

      await this.repository.finish(state.id, finalStatus, finalReason, new Date());
      console.info('ai_automation_concluida', {
        executionId: state.id,
        status: finalStatus,
        reason: finalReason,
        usersEvaluated: state.usersEvaluated,
        recommendationsGenerated: state.recommendationsGenerated,
        conversationsCreated: state.conversationsCreated,
        actionsSuppressed: state.actionsSuppressed,
        errors: state.errors,
        timeouts: state.timeouts,
      });
      return resultFromRecord(finalStatus, finalReason, state.id, state, recommendationCalls, proactivityCalls);
    } catch (error) {
      try {
        await this.repository.finish(state.id, 'ERRO', 'ERRO_INTERNO', new Date());
      } catch {
        // Mantem o erro operacional seguro; a próxima execução poderá assumir o lease expirado.
      }
      console.error('ai_automation_falhou', { executionId: state.id, codigo: safeErrorCode(error) });
      throw new Error('AI automation processing failed');
    }
  }
}

export const automationJobService = new AutomationJobService();
