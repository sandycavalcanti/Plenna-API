import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../lib/env.js';
import { automationJobService, type AutomationJobResult } from './automacao.service.js';

function timingSafeEqualString(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function authorizationHeader(req: Request) {
  return String(typeof req.header === 'function' ? req.header('authorization') : req.headers.authorization ?? '');
}

export function hasValidAutomationCronSecret(req: Request) {
  return Boolean(env.cronSecret) && timingSafeEqualString(authorizationHeader(req), `Bearer ${env.cronSecret}`);
}

export class AutomationController {
  static async process(
    req: Request,
    res: Response,
    run: () => Promise<AutomationJobResult> = () => automationJobService.run(),
  ) {
    if (!hasValidAutomationCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (!env.aiAutomationEnabled) return res.status(200).json({ enabled: false, processed: false });

    const executionId = crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const result = await run();
      return res.status(200).json({
        enabled: true,
        processed: true,
        ...result,
        executionId: result.executionId ?? executionId,
      });
    } catch {
      console.error('ai_automation_controller_falhou', { executionId, duracaoMs: Date.now() - startedAt });
      return res.status(500).json({ error: 'AI automation processing failed', executionId });
    }
  }
}
