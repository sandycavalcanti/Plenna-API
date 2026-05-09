import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { TempoUsoController } from './tempo-uso.controller.js';

export const tempoUsoRouter = Router();

tempoUsoRouter.post('/', authMiddleware, TempoUsoController.create);
tempoUsoRouter.get('/', authMiddleware, TempoUsoController.findAllByUserId);
tempoUsoRouter.get('/:id', authMiddleware, TempoUsoController.findById);
tempoUsoRouter.put('/:id', authMiddleware, TempoUsoController.update);
tempoUsoRouter.delete('/:id', authMiddleware, TempoUsoController.delete);
