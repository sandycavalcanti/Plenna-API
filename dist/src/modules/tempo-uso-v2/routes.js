import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { authMiddleware } from '../auth/auth.middleware.js';
import { getUsageService } from './runtime.js';
import { UsageMonitoringError, isUsageMonitoringEnabled } from './policy.js';
export function usageRouter(service, auth = authMiddleware, enabled = isUsageMonitoringEnabled) {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); if (!enabled())
        return res.status(503).json({ schemaVersion: 2, error: { code: 'RF017_V2_NOT_ENABLED', correlationId: randomUUID(), message: 'Monitoramento v2 indisponível.' } }); next(); });
    router.use(auth);
    const route = (action) => async (req, res) => {
        try {
            if (!req.userId)
                throw new UsageMonitoringError('SESSION_REQUIRED', 401);
            res.json(await action(service(), req));
        }
        catch (error) {
            const known = error instanceof UsageMonitoringError;
            const invalid = error instanceof ZodError;
            // Pure domain errors are machine codes, never expose arbitrary SQL/provider messages.
            const domain = error instanceof Error && /^[A-Z][A-Z_]{2,63}$/.test(error.message) ? error.message : null;
            res.status(known ? error.status : invalid ? 400 : domain ? 409 : 503).json({ schemaVersion: 2, error: { code: known ? error.code : invalid ? 'INVALID_CONTRACT' : domain ?? 'RF017_UNAVAILABLE', correlationId: randomUUID(), message: 'Não foi possível concluir a operação de monitoramento.' } });
        }
    };
    const secret = (req) => String(req.headers['x-rf017-installation-key'] ?? '');
    router.post('/associations', route((s, r) => s.associate(r.userId, r.body, secret(r))));
    router.post('/associations/validate', route((s, r) => { z.object({ action: z.literal('VALIDATE') }).passthrough().parse(r.body); return s.associate(r.userId, r.body, secret(r)); }));
    router.post('/associations/close', route((s, r) => s.close(r.userId, r.body, secret(r))));
    router.put('/snapshots', route((s, r) => s.ingest(r.userId, r.body, secret(r))));
    router.post('/deletions', route((s, r) => s.delete(r.userId, r.body)));
    router.get('/summary', route((s, r) => { const q = z.object({ month: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/) }).strict().parse(r.query); return s.summary(r.userId, q.month); }));
    router.get('/state', route((s, r) => { const q = z.object({ installationId: z.string().uuid() }).strict().parse(r.query); return s.state(r.userId, q.installationId, secret(r)); }));
    return router;
}
export const tempoUsoV2Router = usageRouter(getUsageService);
