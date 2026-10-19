import type { Response } from 'express';
import type { AuthRequest } from '../auth/auth.middleware.js';
import { handleError } from '../../utils/handleError.js';
import { ChatFirstMessageError, ChatService } from './chat.service.js';
import { createHistorySchema, createMessageSchema, historyIdSchema } from './chat.schemas.js';

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

  static async deleteHistory(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token invalido' });
      const historyId = historyIdSchema.parse(req.params.historicoId);
      await ChatService.deleteHistory(req.userId, historyId);
      return res.status(204).send();
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

  static async createMessage(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token invalido' });
      const historyId = historyIdSchema.parse(req.params.historicoId);
      const input = createMessageSchema.parse(req.body);
      const result = await ChatService.sendMessage(req.userId, historyId, input);
      return res.status(200).json(result);
    } catch (error: unknown) {
      return handleError(res, 500, error);
    }
  }

  static async createFirstMessage(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token invalido' });
      const input = createMessageSchema.parse(req.body);
      return res.status(200).json(await ChatService.sendFirstMessage(req.userId, input));
    } catch (error: unknown) {
      if (error instanceof ChatFirstMessageError) {
        return res.status(error.statusCode).json({
          message: error.message,
          errors: [],
          historico_id: error.historyId,
        });
      }
      return handleError(res, 500, error);
    }
  }
}
