import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { PreferenciasCategoriaController } from './preferencias-categoria.controller.js';

export const preferenciasCategoriaRouter = Router();

preferenciasCategoriaRouter.post('/', authMiddleware, PreferenciasCategoriaController.create);
preferenciasCategoriaRouter.post('/bulk', authMiddleware, PreferenciasCategoriaController.createMany);
preferenciasCategoriaRouter.get('/', authMiddleware, PreferenciasCategoriaController.findAllByUserId);
preferenciasCategoriaRouter.get('/:id', authMiddleware, PreferenciasCategoriaController.findById);
preferenciasCategoriaRouter.put('/:id', authMiddleware, PreferenciasCategoriaController.update);
preferenciasCategoriaRouter.delete('/:id', authMiddleware, PreferenciasCategoriaController.delete);
