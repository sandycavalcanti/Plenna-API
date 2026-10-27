import type { Response } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '../auth/auth.middleware.js';
import { AppError } from '../../errors/AppError.js';
import { handleError } from '../../utils/handleError.js';
import { recommendationQuerySchema, recommendationService, recommendationStatusInputSchema } from './recomendacao.service.js';

const idSchema = z.coerce.number().int().positive();

function userId(req: AuthRequest) {
  if (!req.userId) throw new AppError('Token inválido', 401);
  return req.userId;
}

async function safe(res: Response, operation: () => Promise<unknown>, status = 200) {
  try { return res.status(status).json(await operation()); } catch (error) { return handleError(res, 500, error); }
}

export class RecommendationController {
  static list(req: AuthRequest, res: Response) { return safe(res, () => recommendationService.list(userId(req), recommendationQuerySchema.parse(req.query))); }
  static get(req: AuthRequest, res: Response) { return safe(res, () => recommendationService.get(userId(req), idSchema.parse(req.params.recomendacaoId))); }
  static updateStatus(req: AuthRequest, res: Response) { return safe(res, () => recommendationService.updateStatus(userId(req), idSchema.parse(req.params.recomendacaoId), recommendationStatusInputSchema.parse(req.body).status)); }
  static conversation(req: AuthRequest, res: Response) { return safe(res, () => recommendationService.conversation(userId(req), idSchema.parse(req.params.recomendacaoId))); }
}
