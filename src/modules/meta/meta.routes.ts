import { Router } from 'express';
import { MetaController } from './meta.controller.js';
import { authMiddleware } from '../auth/auth.middleware.js';

export const metaRouter = Router();

metaRouter.post('/', authMiddleware, MetaController.create);
metaRouter.get('/', authMiddleware, MetaController.findAllByUserId);
metaRouter.put('/check', authMiddleware, MetaController.checkMeta);
metaRouter.post('/:id/movimentacoes', authMiddleware, MetaController.createMovement);
metaRouter.get('/:id/movimentacoes', authMiddleware, MetaController.listMovements);
metaRouter.put('/:id', authMiddleware, MetaController.update);
metaRouter.delete('/:id', authMiddleware, MetaController.delete);
