import crypto from 'node:crypto';
import { env } from '../../lib/env.js';
import { RecorrenciaEngine } from './recorrencia.engine.js';
function timingSafeEqualString(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
function authorizationHeader(req) {
    return String(typeof req.header === 'function' ? req.header('authorization') : req.headers.authorization ?? '');
}
function hasValidCronSecret(req) {
    if (!env.cronSecret)
        return false;
    return timingSafeEqualString(authorizationHeader(req), `Bearer ${env.cronSecret}`);
}
function publicResult(result) {
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
    static async process(req, res, processDue = RecorrenciaEngine.processDue) {
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
        }
        catch (error) {
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
