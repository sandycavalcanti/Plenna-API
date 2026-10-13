import type { Response } from 'express';
import type { AuthRequest } from '../auth/auth.middleware.js';
import { handleError } from '../../utils/handleError.js';
import { ChatService } from './chat.service.js';
import { createHistorySchema, historyIdSchema } from './chat.schemas.js';

export class ChatController {
  static async createHistory(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      createHistorySchema.parse(req.body ?? {});
      return res.status(201).json(await ChatService.createHistory(req.userId));
    } catch (error: unknown) {
      return handleError(res, 500, error);
    }
  }

  static async listHistories(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      return res.status(200).json(await ChatService.listHistories(req.userId));
    } catch (error: unknown) {
      return handleError(res, 500, error);
    }
  }

  static async getHistory(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const historyId = historyIdSchema.parse(req.params.historicoId);
      return res.status(200).json(await ChatService.getHistory(req.userId, historyId));
    } catch (error: unknown) {
      return handleError(res, 404, error);
    }
  }
}
