import { Request, Response } from 'express';
import { GoalService } from './goal.service.js';
import { GoalMovementError, GoalMovementService } from './goal-movement.service.js';
import {
  checkGoalSchema,
  createGoalSchema,
  goalMovementInputSchema,
  goalMovementListQuerySchema,
  goalMovementPathSchema,
  updateGoalSchema,
} from './goal.schemas.js';
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
  if (error instanceof GoalMovementError) {
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

export class GoalController {
  static async create(req: AuthRequest, res: Response) {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const userId = authReq.userId;
      const data = createGoalSchema.parse(req.body);
      const goal = await GoalService.create(userId, data);
      return res.status(201).json(goal);
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
      const goals = await GoalService.findAllByUserId(userId, { includeSavings: true });
      return res.status(200).json(goals);
    } catch (error: any) {
      return handleError(res, 400, error);
    }
  }

  static async checkGoal(req: AuthRequest, res: Response) {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.userId) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const userId = authReq.userId;
      const data = checkGoalSchema.parse(req.body);
      const goals = await GoalService.checkGoal(userId, data);
      return res.status(200).json(goals);
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
      const data = updateGoalSchema.parse(req.body);
      const updated = await GoalService.update(req.userId, id, data);
      return res.status(200).json(updated);
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
      await GoalService.delete(req.userId, id);
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
      const { id } = goalMovementPathSchema.parse(req.params);
      const input = goalMovementInputSchema.parse(req.body);
      const result = await GoalMovementService.create(req.userId, id, input);
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
      const { id } = goalMovementPathSchema.parse(req.params);
      const query = goalMovementListQuerySchema.parse(req.query);
      const result = await GoalMovementService.list(req.userId, id, query);
      return res.status(200).json(result);
    } catch (error) {
      return handleMovementError(res, error);
    }
  }
}
