import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
import { CONSENTIMENTO_CODIGOS, type ConsentimentoCodigo } from '../consentimento/consentimento.constants.js';
import { recommendationService } from '../recomendacao/recomendacao.service.js';
import { proactivityService } from '../proatividade/proatividade.service.js';

export type AutomationSettings = {
  enabled: boolean;
  batchSize: number;
  maxUsers: number;
  timeoutMs: number;
  maxErrors: number;
  maxRecommendationCalls: number;
  maxProactivityCalls: number;
  timezone: string;
};

type ActiveUserSelector = {
  countActive(): Promise<number>;
  listActive(offset: number, limit: number): Promise<number[]>;
};

type ConsentReader = (userId: number, code: ConsentimentoCodigo) => Promise<boolean>;
type RecommendationRunner = (userId: number, periodo: string, now: Date) => Promise<{ itens?: unknown[] }>;
type ProactivityRunner = (userId: number, options: { now: Date; persist: true; timezone: string }) => Promise<{ estado?: string }>;

export type AutomationJobDependencies = {
  users?: ActiveUserSelector;
  consent?: ConsentReader;
  recommendations?: RecommendationRunner;
  proactivity?: ProactivityRunner;
  settings?: Partial<AutomationSettings>;
};

export type AutomationJobResult = {
  status: 'DESABILITADA' | 'CONCLUIDA' | 'INTERROMPIDA';
  reason: string;
  executionId: string | null;
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

  async countActive() {
    return this.db.tb_usuario.count({ where: { usuario_status: true } });
  }

  async listActive(offset: number, limit: number) {
    const first = await this.db.tb_usuario.findMany({
      where: { usuario_status: true },
      orderBy: { usuario_id: 'asc' },
      skip: offset,
      take: limit,
      select: { usuario_id: true },
    });

    // A rotação pode atravessar o fim da lista. O segundo trecho mantém a
    // distribuição simples sem armazenar cursor ou checkpoint.
    if (first.length >= limit || offset === 0) return first.map((row) => row.usuario_id);
    const remaining = await this.db.tb_usuario.findMany({
      where: { usuario_status: true },
      orderBy: { usuario_id: 'asc' },
      take: limit - first.length,
      select: { usuario_id: true },
    });
    return [...first, ...remaining].map((row) => row.usuario_id);
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

function dayNumberFor(date: Date, timezone: string) {
  const parts = zonedParts(date, timezone);
  return Math.floor(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000);
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
    // O timeout não cancela a operação subjacente. Por isso ela não é repetida
    // nesta execução; recomendações e proatividade usam deduplicação própria.
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeDiagnosticText(value: unknown) {
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[REDACTED_URL]')
    .replace(/(?:password|token|secret|authorization|api[_-]?key)\s*[:=]?\s*\S+/gi, '[REDACTED]')
    .replace(/'(?:''|[^'])*'/g, '[REDACTED]')
    .replace(/"(?:[^"\\]|\\.)*"/g, '[REDACTED]')
    .replace(/\b\d+(?:[.,]\d+)?\b/g, '[NUMBER]')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function safeErrorDetails(stage: string, error: unknown) {
  const details = {
    etapa: stage,
    tipo: error instanceof Error ? error.name.slice(0, 80) : 'ERRO_DESCONHECIDO',
    codigo: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code.slice(0, 40)
      : undefined,
  };
  if (process.env.NODE_ENV === 'production') return details;
  const cause = error instanceof Error && 'cause' in error ? error.cause : undefined;
  return {
    ...details,
    mensagem: safeDiagnosticText(error instanceof Error ? error.message : error),
    causa: safeDiagnosticText(cause instanceof Error ? cause.message : cause),
  };
}

function emptyResult(status: AutomationJobResult['status'], reason: string, executionId: string | null): AutomationJobResult {
  return {
    status,
    reason,
    executionId,
    usersEvaluated: 0,
    recommendationsGenerated: 0,
    conversationsCreated: 0,
    actionsSuppressed: 0,
    errors: 0,
    timeouts: 0,
    recommendationCalls: 0,
    proactivityCalls: 0,
  };
}

export class AutomationJobService {
  private readonly users: ActiveUserSelector;
  private readonly consent: ConsentReader;
  private readonly recommendations: RecommendationRunner;
  private readonly proactivity: ProactivityRunner;
  private readonly settings: AutomationSettings;

  constructor(dependencies: AutomationJobDependencies = {}) {
    this.users = dependencies.users ?? new PrismaActiveUserSelector();
    this.consent = dependencies.consent ?? ((userId, code) => ConsentimentoService.temConsentimentoAtivo(userId, code));
    this.recommendations = dependencies.recommendations
      ?? ((userId, periodo, now) => recommendationService.generateForUser(userId, periodo, now, undefined, { persist: true }));
    this.proactivity = dependencies.proactivity ?? ((userId, options) => proactivityService.processUser(userId, options));
    this.settings = { ...defaultSettings(), ...dependencies.settings };
  }

  async run(options: { now?: Date; periodo?: string } = {}): Promise<AutomationJobResult> {
    const now = options.now ?? new Date();
    const runId = randomUUID();
    if (!this.settings.enabled) return emptyResult('DESABILITADA', 'FLAG_DESABILITADA', null);

    const timezone = this.settings.timezone;
    const periodo = options.periodo ?? periodFor(now, timezone);
    const startedAt = Date.now();
    const deadline = startedAt + this.settings.timeoutMs;
    let usersEvaluated = 0;
    let recommendationsGenerated = 0;
    let conversationsCreated = 0;
    let actionsSuppressed = 0;
    let errors = 0;
    let timeouts = 0;
    let recommendationCalls = 0;
    let proactivityCalls = 0;
    let finalStatus: AutomationJobResult['status'] = 'CONCLUIDA';
    let finalReason = 'CONCLUIDA';

    console.info('ai_automation_inicio', { runId });

    try {
      const activeCount = await withTimeout(this.users.countActive(), Math.max(1, deadline - Date.now()));
      if (activeCount === 0) {
        finalReason = 'SEM_USUARIOS_ELEGIVEIS';
      } else {
        const offset = (dayNumberFor(now, timezone) * this.settings.maxUsers) % activeCount;
        const userIds = await withTimeout(
          this.users.listActive(offset, this.settings.maxUsers),
          Math.max(1, deadline - Date.now()),
        );

        for (let index = 0; index < userIds.length; index += this.settings.batchSize) {
          const batch = userIds.slice(index, index + this.settings.batchSize);
          for (const userId of batch) {
            if (Date.now() >= deadline) {
              finalStatus = 'INTERROMPIDA';
              finalReason = 'TIMEOUT_EXECUCAO';
              break;
            }

            usersEvaluated += 1;
            let userStage = 'user_validation';
            try {
              if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('invalid selected user');
              const userTimeout = Math.max(1, deadline - Date.now());
              userStage = 'consent_personalizacao';
              const personalized = await withTimeout(
                this.consent(userId, CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO),
                userTimeout,
              );
              if (!personalized) {
                actionsSuppressed += 1;
                continue;
              }

              if (recommendationCalls >= this.settings.maxRecommendationCalls) {
                throw new AutomationBudgetStop('LIMITE_CHAMADAS_RECOMENDACAO');
              }
              recommendationCalls += 1;
              userStage = 'recommendation_generate';
              const generated = await withTimeout(
                this.recommendations(userId, periodo, now),
                Math.max(1, deadline - Date.now()),
              );
              const items = Array.isArray(generated.itens) ? generated.itens : [];
              recommendationsGenerated += items.length;
              if (items.length === 0) continue;

              userStage = 'consent_proatividade';
              const proactivityAllowed = await withTimeout(
                this.consent(userId, CONSENTIMENTO_CODIGOS.IA_PROATIVIDADE),
                Math.max(1, deadline - Date.now()),
              );
              if (!proactivityAllowed) {
                actionsSuppressed += 1;
                continue;
              }

              if (proactivityCalls >= this.settings.maxProactivityCalls) {
                throw new AutomationBudgetStop('LIMITE_CHAMADAS_PROATIVIDADE');
              }
              proactivityCalls += 1;
              userStage = 'proactivity_process';
              const proactive = await withTimeout(
                this.proactivity(userId, { now, persist: true, timezone }),
                Math.max(1, deadline - Date.now()),
              );
              if (proactive.estado === 'CRIADA') conversationsCreated += 1;
              else if (proactive.estado !== 'EXISTENTE') actionsSuppressed += 1;
            } catch (error) {
              if (isAutomationBudgetStop(error)) {
                finalStatus = 'INTERROMPIDA';
                finalReason = error.message;
                break;
              }
              errors += 1;
              if (isAutomationTimeout(error)) {
                timeouts += 1;
                finalStatus = 'INTERROMPIDA';
                finalReason = 'TIMEOUT_USUARIO';
                console.warn('ai_automation_usuario_falhou', { runId, detalhes: safeErrorDetails(userStage, error) });
                break;
              }
              console.warn('ai_automation_usuario_falhou', { runId, detalhes: safeErrorDetails(userStage, error) });
              if (errors >= this.settings.maxErrors) {
                finalStatus = 'INTERROMPIDA';
                finalReason = 'LIMITE_ERROS';
                break;
              }
            }
          }
          if (finalStatus === 'INTERROMPIDA') break;
        }
      }
    } catch (error) {
      finalStatus = 'INTERROMPIDA';
      finalReason = isAutomationTimeout(error) ? 'TIMEOUT_EXECUCAO' : 'ERRO_INTERNO';
      if (isAutomationTimeout(error)) timeouts += 1;
      else errors += 1;
      console.error('ai_automation_falhou', { runId, detalhes: safeErrorDetails('job', error) });
    }

    console.info('ai_automation_concluida', {
      runId,
      status: finalStatus,
      reason: finalReason,
      usersEvaluated,
      recommendationsGenerated,
      conversationsCreated,
      actionsSuppressed,
      errors,
      timeouts,
      recommendationCalls,
      proactivityCalls,
    });
    return {
      status: finalStatus,
      reason: finalReason,
      executionId: runId,
      usersEvaluated,
      recommendationsGenerated,
      conversationsCreated,
      actionsSuppressed,
      errors,
      timeouts,
      recommendationCalls,
      proactivityCalls,
    };
  }
}

export const automationJobService = new AutomationJobService();
