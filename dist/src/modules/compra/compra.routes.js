import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { CompraController } from './compra.controller.js';
export const compraRouter = Router();
// Todas as rotas de compra exigem autenticação. O usuário utilizado nas
// operações é obtido do JWT pelo authMiddleware, e não enviado pelo cliente.
compraRouter.use(authMiddleware);
compraRouter.get('/', CompraController.findAllByUserId);
// Rotas fixas devem ser declaradas antes de `/:compraId` para que valores
// como "pending" não sejam interpretados como identificadores de compra.
compraRouter.get('/pending', CompraController.findPendingByUserId);
compraRouter.get('/:compraId', CompraController.findById);
compraRouter.post('/', CompraController.create);
compraRouter.put('/:compraId', CompraController.update);
compraRouter.post('/:compraId/confirm', CompraController.confirm);
compraRouter.post('/:compraId/ignore', CompraController.ignore);
