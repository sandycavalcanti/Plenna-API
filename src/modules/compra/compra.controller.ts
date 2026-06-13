import type { Request, Response } from 'express';
import { authMiddleware, type AuthRequest } from '../auth/auth.middleware.js';
import { CompraService } from './compra.service.js';
import { createCompraSchema, updateCompraSchema } from './compra.schemas.js';
import { handleError } from '../../utils/handleError.js';

export class CompraController {
  static async create(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const data = createCompraSchema.parse(req.body);
      const result = await CompraService.create(req.userId, data);

      return res.status(201).json(result);
    } catch (error: any) {
      return handleError(res, 400, error);
    }
  }

  static async update(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const compraId = Number(req.params.compraId);
      const data = updateCompraSchema.parse(req.body);
      const result = await CompraService.update(req.userId, compraId, data);

      return res.json(result);
    } catch (error: any) {
      return handleError(res, 400, error);
    }
  }

  static async delete(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const compraId = Number(req.params.compraId);
      await CompraService.delete(req.userId, compraId);

      return res.status(204).send();
    } catch (error: any) {
      return handleError(res, 400, error);
    }
  }

  static async findAllByUserId(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const compras = await CompraService.findAllByUserId(req.userId);
      return res.json(compras);
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }

  static async findById(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      const compraId = Number(req.params.compraId);
      const compra = await CompraService.findById(req.userId, compraId);

      return res.json(compra);
    } catch (error: any) {
      return handleError(res, 404, error);
    }
  }
}
