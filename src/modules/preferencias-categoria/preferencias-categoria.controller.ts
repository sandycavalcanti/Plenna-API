import { Response } from 'express';
import { AuthRequest } from '../auth/auth.middleware.js';
import { createPreferenciaCategoriaSchema, updatePreferenciaCategoriaSchema } from './preferencias-categoria.schemas.js';
import { PreferenciasCategoriaService } from './preferencias-categoria.service.js';

export class PreferenciasCategoriaController {
  static async create(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const data = createPreferenciaCategoriaSchema.parse(req.body);
      const created = await PreferenciasCategoriaService.create(req.userId, data);
      return res.status(201).json(created);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }

  static async findAllByUserId(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const preferencias = await PreferenciasCategoriaService.findAllByUserId(req.userId);
      return res.status(200).json(preferencias);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }

  static async findById(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const id = Number(req.params.id);
      const preferencia = await PreferenciasCategoriaService.findById(req.userId, id);

      return res.status(200).json(preferencia);
    } catch (error: any) {
      return res.status(404).json({ error: error.message });
    }
  }

  static async update(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const id = Number(req.params.id);
      const data = updatePreferenciaCategoriaSchema.parse(req.body);
      const updated = await PreferenciasCategoriaService.update(req.userId, id, data);
      return res.status(200).json(updated);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  }

  static async delete(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const id = Number(req.params.id);
      await PreferenciasCategoriaService.delete(req.userId, id);
      return res.status(204).send();
    } catch (error: any) {
      return res.status(404).json({ error: error.message });
    }
  }
}
