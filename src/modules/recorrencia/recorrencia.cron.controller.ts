import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../lib/env.js';
import { RecorrenciaEngine } from './recorrencia.engine.js';

type ProcessDue = typeof RecorrenciaEngine.processDue;

function timingSafeEqualString(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function authorizationHeader(req: Request) {
  return String(
    typeof req.header === 'function' ? req.header('authorization') : req.headers.authorization ?? '',
  );
}

function hasValidCronSecret(req: Request) {
  if (!env.cronSecret) return false;
  return timingSafeEqualString(authorizationHeader(req), `Bearer ${env.cronSecret}`);
}

function publicResult(result: Awaited<ReturnType<ProcessDue>>) {
  return {
    dataAtual: result.dataAtual,
    consideradas: result.consideradas,
    geradas: result.geradas,
    jaExistentes: result.jaExistentes,
    ignoradas: result.ignoradas,
    falhas: result.falhas,
  };
}

export class RecorrenciaCronController {
  static async process(req: Request, res: Response, processDue: ProcessDue = RecorrenciaEngine.processDue) {
    // Authentication is deliberately before the feature flag and before any
    // engine call, so unauthorized requests cannot reach the database.
    if (!hasValidCronSecret(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!env.recurrenceCronEnabled) {
      return res.status(200).json({ enabled: false, processed: false });
    }

    const executionId = crypto.randomUUID();
    const startedAt = Date.now();
    console.info('recorrencia_cron_inicio', { executionId });

    try {
      const result = await processDue();
      console.info('recorrencia_cron_concluido', {
        executionId,
        duracaoMs: Date.now() - startedAt,
        ...publicResult(result),
      });
      return res.status(200).json({
        enabled: true,
        processed: true,
        executionId,
        ...publicResult(result),
      });
    } catch (error: unknown) {
      const codigo = error instanceof Error ? error.name : 'INTERNAL_ERROR';
      console.error('recorrencia_cron_falhou', {
        executionId,
        duracaoMs: Date.now() - startedAt,
        codigo,
      });
      return res.status(500).json({
        error: 'Recurrence processing failed',
        executionId,
      });
    }
  }
}

