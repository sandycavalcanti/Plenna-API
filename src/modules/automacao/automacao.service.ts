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
  maxUserRetries: number;
  leaseMs: number;
  timezone: string;
};

type ActiveUserSelector = {
  listActive(afterUserId: number | null, limit: number, retryUserId?: number | null): Promise<number[]>;
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

  async listActive(afterUserId: number | null, limit: number, retryUserId: number | null = null) {
    const userIdFilter = retryUserId !== null
      ? { usuario_id: { gte: retryUserId } }
      : afterUserId === null
        ? {}
        : { usuario_id: { gt: afterUserId } };
    const rows = await this.db.tb_usuario.findMany({
      where: { usuario_status: true, ...userIdFilter },
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
    maxUserRetries: env.aiAutomationMaxUserRetries,
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

class AutomationBudgetStop extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AutomationBudgetStop';
  }
}

function isAutomationTimeout(error: unknown): error is AutomationTimeout {
  return error instanceof AutomationTimeout;
}

function isAutomationBudgetStop(error: unknown): error is AutomationBudgetStop {
  return error instanceof AutomationBudgetStop;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new AutomationTimeout()), timeoutMs);
    timer.unref?.();
  });
  try {
    // This timeout does not cancel the underlying operation. The caller never
    // retries the ambiguous operation in the same run; persistent dedupe is
    // responsible for resolving a late completion on a later run.
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
  record: Pick<AutomationExecution,
    'usersEvaluated' | 'recommendationsGenerated' | 'conversationsCreated' | 'actionsSuppressed'
    | 'errors' | 'timeouts' | 'recommendationCalls' | 'proactivityCalls'>,
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
    recommendationCalls: record.recommendationCalls,
    proactivityCalls: record.proactivityCalls,
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
        actionsSuppressed: 0, errors: 0, timeouts: 0, recommendationCalls: 0, proactivityCalls: 0,
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
    let errorsThisRun = 0;
    let finalStatus: 'CONCLUIDA' | 'INTERROMPIDA' = 'CONCLUIDA';
    let finalReason = 'SEM_USUARIOS_PENDENTES';
    const startedAt = Date.now();
    const deadline = startedAt + this.settings.timeoutMs;
    let usersThisRun = 0;

    const persistProgress = () => this.repository.progress(state.id, state.leaseToken, {
      cursorUserId: state.cursorUserId,
      cursorAttempts: state.cursorAttempts,
      usersEvaluated: state.usersEvaluated,
      recommendationsGenerated: state.recommendationsGenerated,
      conversationsCreated: state.conversationsCreated,
      actionsSuppressed: state.actionsSuppressed,
      errors: state.errors,
      timeouts: state.timeouts,
      recommendationCalls: state.recommendationCalls,
      proactivityCalls: state.proactivityCalls,
    }, new Date());

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
        const retryUserId = state.cursorAttempts > 0 ? state.cursorUserId : null;
        const userIds = await withTimeout(this.users.listActive(state.cursorUserId, take, retryUserId), remainingTime);
        if (userIds.length === 0) break;

        for (const userId of userIds) {
          if (Date.now() >= deadline) {
            finalStatus = 'INTERROMPIDA';
            finalReason = 'TIMEOUT_EXECUCAO';
            stopAfterUser = true;
            break;
          }

          let completed = false;
          let budgetStopped = false;
          try {
            if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('invalid selected user');
            const userTimeout = Math.max(1, deadline - Date.now());
            const personalized = await withTimeout(
              this.consent(userId, CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO),
              userTimeout,
            );
            if (!personalized) {
              state.actionsSuppressed += 1;
              completed = true;
            } else if (state.recommendationCalls >= this.settings.maxRecommendationCalls) {
              throw new AutomationBudgetStop('LIMITE_CHAMADAS_RECOMENDACAO');
            } else {
              state.recommendationCalls += 1;
              await persistProgress();
              const generated = await withTimeout(
                this.recommendations(userId, periodo, now),
                Math.max(1, deadline - Date.now()),
              );
              const items = Array.isArray(generated.itens) ? generated.itens : [];
              state.recommendationsGenerated += items.length;
              if (items.length === 0) {
                completed = true;
              } else {
                const proactivityAllowed = await withTimeout(
                  this.consent(userId, CONSENTIMENTO_CODIGOS.IA_PROATIVIDADE),
                  Math.max(1, deadline - Date.now()),
                );
                if (!proactivityAllowed) {
                  state.actionsSuppressed += 1;
                  completed = true;
                } else if (state.proactivityCalls >= this.settings.maxProactivityCalls) {
                  await persistProgress();
                  throw new AutomationBudgetStop('LIMITE_CHAMADAS_PROATIVIDADE');
                } else {
                  state.proactivityCalls += 1;
                  await persistProgress();
                  const proactive = await withTimeout(
                    this.proactivity(userId, { now, persist: true, timezone }),
                    Math.max(1, deadline - Date.now()),
                  );
                  if (proactive.estado === 'CRIADA') state.conversationsCreated += 1;
                  else if (proactive.estado !== 'EXISTENTE') state.actionsSuppressed += 1;
                  completed = true;
                }
              }
            }
          } catch (error) {
            if (isAutomationBudgetStop(error)) {
              finalStatus = 'INTERROMPIDA';
              finalReason = error.message;
              budgetStopped = true;
            } else {
              const timedOut = isAutomationTimeout(error);
              state.errors += 1;
              errorsThisRun += 1;
              if (timedOut) state.timeouts += 1;
              state.cursorUserId = userId;
              state.cursorAttempts += 1;
              console.warn('ai_automation_usuario_falhou', { executionId: state.id, codigo: safeErrorCode(error) });
              if (state.cursorAttempts >= this.settings.maxUserRetries) {
                state.actionsSuppressed += 1;
                state.cursorAttempts = 0;
                completed = true;
              } else {
                finalStatus = 'INTERROMPIDA';
                finalReason = timedOut ? 'TIMEOUT_USUARIO' : 'REPROCESSAR_USUARIO';
                stopAfterUser = true;
              }
            }
          }

          if (budgetStopped) {
            stopAfterUser = true;
            break;
          }

          usersThisRun += 1;
          state.usersEvaluated += 1;
          if (completed) {
            state.cursorUserId = userId;
            state.cursorAttempts = 0;
          }
          await persistProgress();

          if (completed && errorsThisRun >= this.settings.maxErrors) {
            finalStatus = 'INTERROMPIDA';
            finalReason = 'LIMITE_ERROS';
            stopAfterUser = true;
          }
          if (stopAfterUser) break;
        }
      }

      await this.repository.finish(state.id, state.leaseToken, finalStatus, finalReason, new Date());
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
        recommendationCalls: state.recommendationCalls,
        proactivityCalls: state.proactivityCalls,
      });
      return resultFromRecord(finalStatus, finalReason, state.id, state);
    } catch (error) {
      if (isAutomationTimeout(error)) {
        await this.repository.finish(state.id, state.leaseToken, 'INTERROMPIDA', 'TIMEOUT_EXECUCAO', new Date());
        return resultFromRecord('INTERROMPIDA', 'TIMEOUT_EXECUCAO', state.id, state);
      }
      try {
        await this.repository.finish(state.id, state.leaseToken, 'ERRO', 'ERRO_INTERNO', new Date());
      } catch {
        // Um worker que perdeu o fencing token não pode concluir a execução.
      }
      console.error('ai_automation_falhou', { executionId: state.id, codigo: safeErrorCode(error) });
      throw new Error('AI automation processing failed');
    }
  }
}

export const automationJobService = new AutomationJobService();
