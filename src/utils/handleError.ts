// utils/handleError.ts

import { Response } from 'express';
import { ZodError } from 'zod';

export function handleError(res: Response, status: number, err: unknown) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      message: 'Dados inválidos',
      errors: err.issues.map((issue) => ({
        field: issue.path[0],
        message: issue.message,
      })),
    });
  }

  const message = err instanceof Error ? err.message : 'Erro interno do servidor';

  return res.status(status).json({
    message,
    errors: [],
  });
}