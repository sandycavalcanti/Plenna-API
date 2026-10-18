import type { Response } from 'express';
import { AuthRequest } from '../auth/auth.middleware.js';
import { handleError } from '../../utils/handleError.js';
import {
  createRecurrenceSchema,
  recurrenceIdSchema,
  recurrenceListQuerySchema,
  recurrenceUpcomingQuerySchema,
  updateRecurrenceSchema,
} from './recorrencia.schemas.js';
import { RecorrenciaService } from './recorrencia.service.js';

function parseId(value: string | string[]) {
  return recurrenceIdSchema.parse(typeof value === 'string' ? value : '');
}

export class RecorrenciaController {
  static async create(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      return res.status(201).json(await RecorrenciaService.create(req.userId, createRecurrenceSchema.parse(req.body)));
    } catch (error: unknown) {
      return handleError(res, 400, error);
    }
  }

  static async findAll(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const query = recurrenceListQuerySchema.parse(req.query);
      return res.json(await RecorrenciaService.findAll(req.userId, query.status));
    } catch (error: unknown) {
      return handleError(res, 400, error);
    }
  }

  static async findById(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      return res.json(await RecorrenciaService.findById(req.userId, parseId(req.params.recorrenciaId)));
    } catch (error: unknown) {
      return handleError(res, 404, error);
    }
  }

  static async update(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const data = updateRecurrenceSchema.parse(req.body);
      return res.json(await RecorrenciaService.update(req.userId, parseId(req.params.recorrenciaId), data));
    } catch (error: unknown) {
      return handleError(res, 400, error);
    }
  }

  static async pause(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      return res.json(await RecorrenciaService.pause(req.userId, parseId(req.params.recorrenciaId)));
    } catch (error: unknown) {
      return handleError(res, 400, error);
    }
  }

  static async resume(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      return res.json(await RecorrenciaService.resume(req.userId, parseId(req.params.recorrenciaId)));
    } catch (error: unknown) {
      return handleError(res, 400, error);
    }
  }

  static async cancel(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      return res.json(await RecorrenciaService.cancel(req.userId, parseId(req.params.recorrenciaId)));
    } catch (error: unknown) {
      return handleError(res, 400, error);
    }
  }

  static async upcoming(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const query = recurrenceUpcomingQuerySchema.parse(req.query);
      return res.json(await RecorrenciaService.upcoming(
        req.userId,
        parseId(req.params.recorrenciaId),
        query.limit,
      ));
    } catch (error: unknown) {
      return handleError(res, 400, error);
    }
  }
}
