import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authMiddleware, type AuthRequest } from '../auth/auth.middleware.js';
import { UsageMonitoringError, isUsageMonitoringEnabled } from '../tempo-uso-v2/policy.js';
import { localDateSchema, utcSchema } from '../tempo-uso-v2/schemas.js';
import { getMonitoringService } from './runtime.js';
import type { MonitoringService } from './service.js';
export function monitoringRouter(service: () => MonitoringService = getMonitoringService, auth = authMiddleware, enabled = isUsageMonitoringEnabled) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled()) return res.status(503).json({
      schemaVersion: 3,
      error: {
        code: 'RF017_V2_NOT_ENABLED',
        correlationId: randomUUID(),
        message: 'Monitoramento indisponível.'
      }
    });
    next();
  });
  router.use(auth);
  const route = (work: (s: MonitoringService, r: AuthRequest) => Promise<unknown>) => async (req: AuthRequest, res: import('express').Response) => {
    try {
      if (!req.userId) throw new UsageMonitoringError('SESSION_REQUIRED', 401);
      res.json(await work(service(), req));
    } catch (e) {
      res.status(e instanceof UsageMonitoringError ? e.status : e instanceof z.ZodError ? 400 : 503).json({
        schemaVersion: 3,
        error: {
          code: e instanceof UsageMonitoringError ? e.code : e instanceof z.ZodError ? 'INVALID_CONTRACT' : 'RF017_UNAVAILABLE',
          correlationId: randomUUID(),
          message: 'Não foi possível concluir a operação de monitoramento.'
        }
      });
    }
  };
  const secret = (r: AuthRequest) => String(r.headers['x-rf017-installation-key'] ?? '');
  router.post('/prepare', route((s, r) => s.prepare(r.userId!, r.body, secret(r))));
  router.put('/observations', route((s, r) => s.ingest(r.userId!, r.body, secret(r))));
  router.post('/close', route((s, r) => s.close(r.userId!, r.body, secret(r))));
  router.post('/deletions', route((s, r) => s.delete(r.userId!, r.body)));
  router.get('/summary', route((s, r) => {
    const q = z.object({
      month: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/)
    }).strict().parse(r.query);
    return s.summary(r.userId!, q.month);
  }));
  router.get('/accesses', route(async (s, r) => {
    const q = z.object({
      date: localDateSchema,
      cursor: z.string().max(512).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20)
    }).strict().parse(r.query);
    let after: null | {
      id: string;
      start: string;
      key: string;
    } = null;
    if (q.cursor) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      } catch {
        throw new UsageMonitoringError('INVALID_CURSOR', 400);
      }
      after = z.object({
        id: z.string().regex(/^[1-9]\d{0,18}$/),
        start: utcSchema,
        key: z.string().uuid()
      }).strict().parse(parsed);
    }
    return s.accessPage(r.userId!, q.date, after, q.limit);
  }));
  // Escritas antigas devem falhar sem alcançar tabelas descontinuadas.
  router.all(['/associations', '/associations/validate', '/associations/close', '/snapshots', '/state'], (_req, res) => res.status(409).json({
    schemaVersion: 3,
    error: {
      code: 'RF017_PROTOCOL_UPGRADE_REQUIRED',
      message: 'Atualize o aplicativo para continuar o monitoramento.'
    }
  }));
  return router;
}
export const tempoUsoMonitoramentoRouter = monitoringRouter();
