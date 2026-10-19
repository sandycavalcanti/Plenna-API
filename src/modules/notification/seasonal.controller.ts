import crypto from 'node:crypto';
import type { Response } from 'express';
import { env } from '../../lib/env.js';
import { handleError } from '../../utils/handleError.js';
import { SeasonalNotificationService } from './seasonal-notification.service.js';

function timingSafeEqualString(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export class SeasonalController {
  static async run(req: any, res: Response) {
    try {
      const authHeader = String(
        typeof req.header === 'function' ? req.header('authorization') : req.headers?.authorization ?? '',
      );
      const expected = `Bearer ${env.cronSecret}`;
      if (!env.cronSecret || !timingSafeEqualString(authHeader, expected)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const result = await SeasonalNotificationService.process(new Date());
      const status = result.failures > 0 ? 500 : 200;
      return res.status(status).json({
        status: result.failures > 0 ? 'PARTIAL_FAILURE' : 'COMPLETED',
        ...result,
      });
    } catch (error: unknown) {
      return handleError(res, 500, error);
    }
  }
}
