import { Request, Response } from 'express';
import { AuthRequest } from '../auth/auth.middleware.js';
import { createTempoUsoSchema, updateTempoUsoSchema } from './tempo-uso.schemas.js';
import { TempoUsoService } from './tempo-uso.service.js';
import { handleError } from '../../utils/handleError.js';

export class TempoUsoController {
  static async create(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const data = createTempoUsoSchema.parse(req.body);
      const tempo = await TempoUsoService.create(req.userId, data);
      return res.status(201).json(tempo);
    } catch (error: any) {
      return handleError(res, 400, error);
    }
  }

  static async findAllByUserId(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const tempos = await TempoUsoService.findAllByUserId(req.userId);
      return res.json(tempos);
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }

  static async findById(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const id = Number(req.params.id);
      const tempo = await TempoUsoService.findById(req.userId, id);
      return res.json(tempo);
    } catch (error: any) {
      return handleError(res, 404, error);
    }
  }

  static async update(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const id = Number(req.params.id);
      const data = updateTempoUsoSchema.parse(req.body);
      const updated = await TempoUsoService.update(req.userId, id, data);
      return res.json(updated);
    } catch (error: any) {
      return handleError(res, 400, error);
    }
  }

  static async delete(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const id = Number(req.params.id);
      await TempoUsoService.delete(req.userId, id);
      return res.status(204).send();
    } catch (error: any) {
      return handleError(res, 404, error);
    }
  }
}
