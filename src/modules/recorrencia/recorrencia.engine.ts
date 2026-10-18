import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { AppError } from '../../errors/AppError.js';
import { evaluateConfirmedPurchaseLimits, itemTotalCents } from '../compra/limite.service.js';
import { MetricasService } from '../compra/metricas.service.js';
import { dispatchPushAfterCommit, type PushNotificationCandidate } from '../notification/push.service.js';
import {
  addCivilDays,
  businessDateNow,
  dateOnlyAtTimeZoneMidnight,
  formatDateInTimeZone,
  formatDateOnly,
  nextOccurrenceOnOrAfter,
  parseDateOnly,
  RECURRENCE_TIMEZONE,
  type RecurrenceFrequency,
} from './recorrencia.calendar.js';

const RECURRENCE_FREQUENCIES = new Set<RecurrenceFrequency>(['DIARIA', 'SEMANAL', 'MENSAL', 'ANUAL']);

type RecurrenceDatabase = {
  $queryRaw: <T = any>(...args: any[]) => Promise<T>;
  $transaction: (callback: (tx: any) => Promise<any>, options?: { timeout?: number }) => Promise<any>;
};

type ProcessingDependencies = {
  evaluateLimits?: typeof evaluateConfirmedPurchaseLimits;
  recalculateMetrics?: typeof MetricasService.recalculateMonthlyMetrics;
  dispatchPush?: typeof dispatchPushAfterCommit;
};

export type ProcessDueRecurrencesOptions = ProcessingDependencies & {
  db?: RecurrenceDatabase;
  now?: Date;
  batchSize?: number;
  maxOccurrences?: number;
  transactionTimeoutMs?: number;
};

type LockedRecurrence = {
  compra_recorrencia_id: number;
  usuario_id: number;
  forma_pagamento_id: number;
  compra_recorrencia_fonte: string | null;
  compra_recorrencia_frequencia: string;
  compra_recorrencia_primeira_ocorrencia: Date;
  compra_recorrencia_proxima_ocorrencia: Date;
  compra_recorrencia_data_final: Date | null;
  compra_recorrencia_fuso_horario: string;
  compra_recorrencia_data_criacao: Date;
};

type TemplateItem = {
  compra_item_id: number;
  categoria_id: number | null;
  compra_item_nome: string;
  compra_item_valor: Prisma.Decimal | number | string;
  compra_item_quantidade: Prisma.Decimal | number | string | null;
  compra_item_unidade_medida: string | null;
};

type ProcessedOccurrence = {
  kind: 'GENERATED' | 'ALREADY_EXISTS' | 'SKIPPED' | 'ADVANCED';
  recurrenceId: number;
  userId: number;
  occurrence: string | null;
  nextOccurrence: string | null;
  reason?: 'INITIAL_DATE_BEFORE_CREATION' | 'AFTER_END_DATE';
  notifications: PushNotificationCandidate[];
};

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new AppError(`${name} inválido`, 500);
  }
  return candidate;
}

function boundedCount(value: number | undefined, fallback: number, name: string) {
  return Math.min(positiveInteger(value, fallback, name), 1000);
}

function frequencyOf(value: string): RecurrenceFrequency {
  if (!RECURRENCE_FREQUENCIES.has(value as RecurrenceFrequency)) {
    throw new AppError('Frequência de recorrência inválida', 500);
  }
  return value as RecurrenceFrequency;
}

function processingErrorCode(error: unknown) {
  if (error instanceof AppError) return `APP_ERROR_${error.statusCode}`;
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code;
  return 'INTERNAL_ERROR';
}

function toPurchaseValue(totalCents: number) {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    throw new AppError('Itens da recorrência não possuem valor financeiro válido', 422);
  }
  return new Prisma.Decimal(totalCents).div(100).toDecimalPlaces(2);
}

function notificationCandidates(evaluation: any): PushNotificationCandidate[] {
  return (evaluation?.alerts ?? [])
    .filter((alert: any) => alert.created)
    .map((alert: any) => ({ notificationId: alert.notificationId, type: alert.type }));
}

async function findDueCandidateIds(db: RecurrenceDatabase, runDate: Date, limit: number) {
  return db.$queryRaw<Array<{ compra_recorrencia_id: number }>>`
    SELECT compra_recorrencia_id
    FROM public.tb_compra_recorrencia
    WHERE compra_recorrencia_status = 'ATIVA'
      AND compra_recorrencia_proxima_ocorrencia IS NOT NULL
      AND compra_recorrencia_proxima_ocorrencia <= ${runDate}
    ORDER BY compra_recorrencia_proxima_ocorrencia ASC, compra_recorrencia_id ASC
    LIMIT ${limit}
  `;
}

async function lockDueRecurrence(tx: any, recurrenceId: number, runDate: Date) {
  const rows = await tx.$queryRaw<LockedRecurrence[]>`
    SELECT
      compra_recorrencia_id,
      usuario_id,
      forma_pagamento_id,
      compra_recorrencia_fonte,
      compra_recorrencia_frequencia,
      compra_recorrencia_primeira_ocorrencia,
      compra_recorrencia_proxima_ocorrencia,
      compra_recorrencia_data_final,
      compra_recorrencia_fuso_horario,
      compra_recorrencia_data_criacao
    FROM public.tb_compra_recorrencia
    WHERE compra_recorrencia_id = ${recurrenceId}
      AND compra_recorrencia_status = 'ATIVA'
      AND compra_recorrencia_proxima_ocorrencia IS NOT NULL
      AND compra_recorrencia_proxima_ocorrencia <= ${runDate}
    FOR UPDATE SKIP LOCKED
  `;

  return rows[0] ?? null;
}

async function processLockedOccurrence(
  tx: any,
  recurrenceId: number,
  runDate: Date,
  dependencies: Required<ProcessingDependencies>,
): Promise<ProcessedOccurrence> {
  const recurrence = await lockDueRecurrence(tx, recurrenceId, runDate);
  if (!recurrence) {
    return {
      kind: 'SKIPPED',
      recurrenceId,
      userId: 0,
      occurrence: null,
      nextOccurrence: null,
      notifications: [],
    };
  }

  const scheduledDate = parseDateOnly(recurrence.compra_recorrencia_proxima_ocorrencia, 'proximaOcorrencia');
  const scheduledDateText = formatDateOnly(scheduledDate);
  const creationDateText = formatDateInTimeZone(
    recurrence.compra_recorrencia_data_criacao,
    recurrence.compra_recorrencia_fuso_horario || RECURRENCE_TIMEZONE,
  );

  const frequency = frequencyOf(recurrence.compra_recorrencia_frequencia);
  const firstOccurrence = parseDateOnly(recurrence.compra_recorrencia_primeira_ocorrencia, 'primeiraOcorrencia');
  const endDate = recurrence.compra_recorrencia_data_final
    ? parseDateOnly(recurrence.compra_recorrencia_data_final, 'dataFinal')
    : null;

  // Do not create a charge before the recurrence existed. Advance atomically
  // to the first eligible occurrence so the same due row is not retried.
  if (scheduledDateText < creationDateText) {
    const nextEligible = nextOccurrenceOnOrAfter(
      frequency,
      firstOccurrence,
      endDate,
      parseDateOnly(creationDateText, 'dataCriacao'),
    );
    const advanced = await tx.tb_compra_recorrencia.updateMany({
      where: {
        compra_recorrencia_id: recurrenceId,
        compra_recorrencia_status: 'ATIVA',
        compra_recorrencia_proxima_ocorrencia: scheduledDate,
      },
      data: {
        compra_recorrencia_proxima_ocorrencia: nextEligible,
        compra_recorrencia_status: nextEligible ? 'ATIVA' : 'FINALIZADA',
        compra_recorrencia_data_modificacao: new Date(),
      },
    });
    if (advanced.count !== 1) {
      throw new AppError('RecorrÃªncia foi alterada durante o processamento', 409);
    }
    return {
      kind: 'ADVANCED',
      recurrenceId,
      userId: recurrence.usuario_id,
      occurrence: scheduledDateText,
      nextOccurrence: nextEligible ? formatDateOnly(nextEligible) : null,
      reason: 'INITIAL_DATE_BEFORE_CREATION',
      notifications: [],
    };
  }

  if (endDate && scheduledDate > endDate) {
    const finalized = await tx.tb_compra_recorrencia.updateMany({
      where: {
        compra_recorrencia_id: recurrenceId,
        compra_recorrencia_status: 'ATIVA',
        compra_recorrencia_proxima_ocorrencia: scheduledDate,
      },
      data: {
        compra_recorrencia_proxima_ocorrencia: null,
        compra_recorrencia_status: 'FINALIZADA',
        compra_recorrencia_data_modificacao: new Date(),
      },
    });
    if (finalized.count !== 1) {
      throw new AppError('Recorrência foi alterada durante o processamento', 409);
    }
    return {
      kind: 'ADVANCED',
      recurrenceId,
      userId: recurrence.usuario_id,
      occurrence: scheduledDateText,
      nextOccurrence: null,
      reason: 'AFTER_END_DATE',
      notifications: [],
    };
  }

  const existingPurchase = await tx.tb_compra.findFirst({
    where: {
      compra_recorrencia_id: recurrenceId,
      compra_recorrencia_data_prevista: scheduledDate,
    },
    select: { compra_id: true },
  });

  let notifications: PushNotificationCandidate[] = [];
  let kind: ProcessedOccurrence['kind'] = 'ALREADY_EXISTS';

  if (!existingPurchase) {
    const templates = await tx.tb_compra_item.findMany({
      where: {
        compra_recorrencia_id: recurrenceId,
        compra_id: null,
        compra_item_ativo: 1,
      },
      orderBy: { compra_item_id: 'asc' },
      select: {
        compra_item_id: true,
        categoria_id: true,
        compra_item_nome: true,
        compra_item_valor: true,
        compra_item_quantidade: true,
        compra_item_unidade_medida: true,
      },
    }) as TemplateItem[];

    if (templates.length === 0) {
      throw new AppError('Recorrência sem itens-modelo ativos', 422);
    }

    const totalCents = templates.reduce((total, item) => {
      if (item.categoria_id === null || item.compra_item_nome.trim().length === 0) {
        throw new AppError('Item-modelo de recorrência inválido', 422);
      }
      const lineTotal = itemTotalCents(item.compra_item_valor, item.compra_item_quantidade);
      if (lineTotal === null) throw new AppError('Item-modelo de recorrência inválido', 422);
      const nextTotal = total + lineTotal;
      if (!Number.isSafeInteger(nextTotal)) throw new AppError('Total financeiro inválido', 422);
      return nextTotal;
    }, 0);

    const scheduledTimestamp = dateOnlyAtTimeZoneMidnight(
      scheduledDate,
      recurrence.compra_recorrencia_fuso_horario,
    );
    const compra = await tx.tb_compra.create({
      data: {
        usuario_id: recurrence.usuario_id,
        forma_pagamento_id: recurrence.forma_pagamento_id,
        compra_recorrencia_id: recurrenceId,
        compra_recorrencia_data_prevista: scheduledDate,
        compra_valor: toPurchaseValue(totalCents),
        compra_horario: scheduledTimestamp,
        compra_fonte: recurrence.compra_recorrencia_fonte,
        compra_email: false,
        compra_classificacao: 'PENDENTE',
        compra_acima_limite: null,
        compra_usuario_concorda: null,
        compra_usuario_anotacao: null,
        compra_status: 'CONFIRMADA',
        compra_ativo: 1,
        compra_desconto: new Prisma.Decimal(0),
        compra_pedido_externo_id: null,
        compra_email_mensagem_id: null,
      },
    });

    await tx.tb_compra_item.createMany({
      data: templates.map((item) => ({
        compra_id: compra.compra_id,
        compra_recorrencia_id: null,
        categoria_id: item.categoria_id,
        compra_item_nome: item.compra_item_nome,
        compra_item_valor: item.compra_item_valor,
        compra_item_quantidade: item.compra_item_quantidade,
        compra_item_unidade_medida: item.compra_item_unidade_medida,
        compra_item_ativo: 1,
      })),
    });

    const evaluation = await dependencies.evaluateLimits(compra.compra_id, tx);
    notifications = notificationCandidates(evaluation);
    await dependencies.recalculateMetrics(recurrence.usuario_id, scheduledTimestamp, tx);
    kind = 'GENERATED';
  }

  const nextOccurrence = nextOccurrenceOnOrAfter(
    frequency,
    firstOccurrence,
    endDate,
    addCivilDays(scheduledDate, 1),
  );
  const nextStatus = nextOccurrence ? 'ATIVA' : 'FINALIZADA';
  const advanced = await tx.tb_compra_recorrencia.updateMany({
    where: {
      compra_recorrencia_id: recurrenceId,
      compra_recorrencia_status: 'ATIVA',
      compra_recorrencia_proxima_ocorrencia: scheduledDate,
    },
    data: {
      compra_recorrencia_proxima_ocorrencia: nextOccurrence,
      compra_recorrencia_status: nextStatus,
      compra_recorrencia_data_modificacao: new Date(),
    },
  });

  if (advanced.count !== 1) {
    throw new AppError('Recorrência foi alterada durante o processamento', 409);
  }

  return {
    kind,
    recurrenceId,
    userId: recurrence.usuario_id,
    occurrence: scheduledDateText,
    nextOccurrence: nextOccurrence ? formatDateOnly(nextOccurrence) : null,
    notifications,
  };
}

export class RecorrenciaEngine {
  static async processDue(options: ProcessDueRecurrencesOptions = {}) {
    const db = options.db ?? (prisma as unknown as RecurrenceDatabase);
    const runDate = options.now ? parseDateOnly(options.now, 'dataAtual') : businessDateNow();
    const batchSize = boundedCount(options.batchSize, env.recurrenceProcessingBatchSize, 'Lote de recorrências');
    const maxOccurrences = boundedCount(
      options.maxOccurrences,
      env.recurrenceProcessingMaxOccurrencesPerRun,
      'Limite de ocorrências',
    );
    const transactionTimeoutMs = positiveInteger(
      options.transactionTimeoutMs,
      env.recurrenceProcessingTransactionTimeoutMs,
      'Timeout da transação',
    );
    const candidates = await findDueCandidateIds(db, runDate, batchSize);
    const result = {
      dataAtual: formatDateOnly(runDate),
      consideradas: candidates.length,
      geradas: 0,
      jaExistentes: 0,
      ignoradas: 0,
      falhas: 0,
      falhasRecorrenciaIds: [] as number[],
    };
    const dependencies: Required<ProcessingDependencies> = {
      evaluateLimits: options.evaluateLimits ?? evaluateConfirmedPurchaseLimits,
      recalculateMetrics: options.recalculateMetrics ?? MetricasService.recalculateMonthlyMetrics,
      dispatchPush: options.dispatchPush ?? dispatchPushAfterCommit,
    };

    for (const candidate of candidates.slice(0, batchSize)) {
      let continueRecurrence = true;
      try {
        while (continueRecurrence && result.geradas + result.jaExistentes < maxOccurrences) {
          const processed = await db.$transaction(
            (tx) => processLockedOccurrence(tx, candidate.compra_recorrencia_id, runDate, dependencies),
            { timeout: transactionTimeoutMs },
          );

          if (processed.kind === 'GENERATED') result.geradas += 1;
          if (processed.kind === 'ALREADY_EXISTS') result.jaExistentes += 1;
          if (processed.kind === 'SKIPPED') result.ignoradas += 1;
          if (processed.notifications.length > 0) {
            try {
              // Push is external and deliberately cannot roll back a committed
              // purchase. A failed delivery must not make the occurrence look
              // unprocessed to a future execution.
              await dependencies.dispatchPush(processed.userId, processed.notifications);
            } catch {
              console.error('recorrencia_push_pos_commit_falhou', {
                recorrenciaId: processed.recurrenceId,
                codigo: 'PUSH_DELIVERY_FAILED',
              });
            }
          }

          if (processed.kind === 'SKIPPED' || processed.nextOccurrence === null) {
            continueRecurrence = false;
            continue;
          }

          continueRecurrence = parseDateOnly(processed.nextOccurrence, 'proximaOcorrencia') <= runDate;
        }
      } catch (error: unknown) {
        result.falhas += 1;
        result.falhasRecorrenciaIds.push(candidate.compra_recorrencia_id);
        console.error('recorrencia_processamento_falhou', {
          recorrenciaId: candidate.compra_recorrencia_id,
          codigo: processingErrorCode(error),
        });
      }
    }

    return result;
  }
}

export const processDueRecurrences = RecorrenciaEngine.processDue;

