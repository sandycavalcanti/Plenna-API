import type { Response } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '../auth/auth.middleware.js';
import { AppError } from '../../errors/AppError.js';
import { handleError } from '../../utils/handleError.js';
import {
  MEMORY_LIST_MAX_LIMIT,
  MEMORY_ORIGINS,
  memoryOriginSchema,
  memoryStatusSchema,
  MemoryPolicyError,
} from './memory.contracts.js';
import { MemoryServiceError } from './memory.service.js';
import { resolveMemoryAuthorization } from './memory.authorization.js';
import { memoryService } from './memory.runtime.js';

const listQuerySchema = z.object({
  status: memoryStatusSchema.optional(),
  origem: memoryOriginSchema.optional(),
  limite: z.coerce.number().int().min(1).max(MEMORY_LIST_MAX_LIMIT).optional(),
  cursor: z.string().trim().min(1).max(256).optional(),
}).strict();

function requireUserId(req: AuthRequest): number {
  if (!req.userId) throw new AppError('Token inválido', 401);
  return req.userId;
}

function mapMemoryError(error: unknown): AppError | null {
  if (error instanceof MemoryPolicyError) {
    const status = error.code === 'MEMORY_CONSENT_REQUIRED'
      || error.code === 'MEMORY_OPERATION_FORBIDDEN'
      || error.code === 'MEMORY_OWNER_MISMATCH'
      ? 403
      : 400;
    return new AppError(error.message, status);
  }

  if (error instanceof MemoryServiceError) {
    const status = error.code === 'MEMORY_NOT_FOUND' ? 404
      : error.code === 'MEMORY_DUPLICATE' || error.code === 'MEMORY_DUPLICATE_INACTIVE_OR_EXPIRED' ? 409
        : error.code === 'MEMORY_PERSISTENCE_FAILED' ? 500
          : 400;
    return new AppError(error.message, status);
  }

  return null;
}

async function withMemoryErrorHandling(
  res: Response,
  operation: () => Promise<unknown>,
  successStatus = 200,
) {
  try {
    return res.status(successStatus).json(await operation());
  } catch (error: unknown) {
    const mapped = mapMemoryError(error);
    return handleError(res, mapped?.statusCode ?? 500, mapped ?? error);
  }
}

export class MemoryController {
  static async list(req: AuthRequest, res: Response) {
    return withMemoryErrorHandling(res, async () => {
      const userId = requireUserId(req);
      const query = listQuerySchema.parse(req.query);
      return memoryService.list(await resolveMemoryAuthorization(userId), query);
    });
  }

  static async create(req: AuthRequest, res: Response) {
    return withMemoryErrorHandling(res, async () => {
      const userId = requireUserId(req);
      if (req.body?.origem !== undefined && req.body.origem !== MEMORY_ORIGINS.DECLARADA) {
        throw new AppError('Memórias declaradas devem usar origem DECLARADA', 400);
      }
      return memoryService.save(
        await resolveMemoryAuthorization(userId),
        { ...req.body, origem: MEMORY_ORIGINS.DECLARADA },
      );
    }, 201);
  }

  static async update(req: AuthRequest, res: Response) {
    return withMemoryErrorHandling(res, async () => {
      const userId = requireUserId(req);
      return memoryService.update(await resolveMemoryAuthorization(userId), {
        ...req.body,
        memoria_id: Number(req.params.memoriaId),
      });
    });
  }

  static async inactivate(req: AuthRequest, res: Response) {
    return withMemoryErrorHandling(res, async () => {
      const userId = requireUserId(req);
      return memoryService.inactivate(await resolveMemoryAuthorization(userId), {
        memoria_id: Number(req.params.memoriaId),
      });
    });
  }

  static async delete(req: AuthRequest, res: Response) {
    return withMemoryErrorHandling(res, async () => {
      const userId = requireUserId(req);
      return memoryService.delete(await resolveMemoryAuthorization(userId), {
        memoria_id: Number(req.params.memoriaId),
      });
    });
  }
}
