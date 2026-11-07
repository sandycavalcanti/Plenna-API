import { Request, Response } from 'express';
import { MetaService, serializeMeta } from './meta.service.js';
import { MetaMovimentacaoError, MetaMovimentacaoService } from './meta-movimentacao.service.js';
import {
  checkMetaSchema,
  createMetaSchema,
  metaMovimentacaoInputSchema,
  metaMovimentacaoListQuerySchema,
  metaMovimentacaoPathSchema,
  updateMetaSchema,
} from './meta.schemas.js';
import { AuthRequest } from '../auth/auth.middleware.js';
import { handleError } from '../../utils/handleError.js';
import { ZodError } from 'zod';

function handleMovementError(res: Response, error: unknown) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      message: 'Dados inválidos',
      code: 'DADOS_INVALIDOS',
      errors: error.issues.map((issue) => ({
        field: issue.path[0] ?? null,
        message: issue.message,
      })),
    });
  }
  if (error instanceof MetaMovimentacaoError) {
    return res.status(error.statusCode).json({
      message: error.message,
      code: error.code,
      errors: [],
    });
  }
  return res.status(500).json({
    message: 'Erro interno do servidor',
    code: 'ERRO_INTERNO',
    errors: [],
  });
}

export class MetaController {
  static async create(req: AuthRequest, res: Response) {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const userId = authReq.userId;
      const data = createMetaSchema.parse(req.body);
      const meta = await MetaService.create(userId, data);
      return res.status(201).json(serializeMeta(meta));
    } catch (error: any) {
      return handleError(res, 400, error);
    }
  }

  static async findAllByUserId(req: AuthRequest, res: Response) {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const userId = authReq.userId;
      const metas = await MetaService.findAllByUserId(userId, { includeSavings: true });
      return res.status(200).json(metas.map(serializeMeta));
    } catch (error: any) {
      return handleError(res, 400, error);
    }
  }

  static async checkMeta(req: AuthRequest, res: Response) {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const userId = authReq.userId;
      const data = checkMetaSchema.parse(req.body);
      const meta = await MetaService.checkMeta(userId, data);
      return res.status(200).json(serializeMeta(meta));
    } catch (error: any) {
      return handleError(res, 400, error);
    }
  }

  static async update(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const id = Number(req.params.id);
      const data = updateMetaSchema.parse(req.body);
      const updated = await MetaService.update(req.userId, id, data);
      return res.status(200).json(serializeMeta(updated));
    } catch (error: any) {
      return handleError(res, 400, error);
    }
  }

  static async delete(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const id = Number(req.params.id);
      await MetaService.delete(req.userId, id);
      return res.status(204).send();
    } catch (error: any) {
      return handleError(res, 404, error);
    }
  }

  static async createMovement(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const { id } = metaMovimentacaoPathSchema.parse(req.params);
      const input = metaMovimentacaoInputSchema.parse(req.body);
      const result = await MetaMovimentacaoService.create(req.userId, id, input);
      return res.status(201).json(result);
    } catch (error) {
      return handleMovementError(res, error);
    }
  }

  static async listMovements(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const { id } = metaMovimentacaoPathSchema.parse(req.params);
      const query = metaMovimentacaoListQuerySchema.parse(req.query);
      const result = await MetaMovimentacaoService.list(req.userId, id, query);
      return res.status(200).json(result);
    } catch (error) {
      return handleMovementError(res, error);
    }
  }
}
