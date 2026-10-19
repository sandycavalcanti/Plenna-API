import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../auth/auth.middleware.js';
import { RF018Service } from './rf018.service.js';
import { handleError } from '../../utils/handleError.js';
export const analisesRouter = Router();
const querySchema = z.object({ periodo: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/) }).strict();
analisesRouter.get('/comportamento', authMiddleware, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { periodo } = querySchema.parse(req.query);
    const userId = (req as import('../auth/auth.middleware.js').AuthRequest).userId!;
    return res.json(await RF018Service.consultar(userId, periodo));
  } catch (error) { return handleError(res, 500, error); }
});
