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
// A rota de item fica antes da exclusão da compra para deixar explícitos os
// dois recursos destrutivos oferecidos pelo módulo.
compraRouter.delete('/:compraId/items/:compraItemId', CompraController.deleteItem);
// A rota de exclusão permanece protegida pelo authMiddleware aplicado acima.
// O controller extrai o usuário do JWT, portanto o cliente não escolhe o proprietário.
compraRouter.delete('/:compraId', CompraController.delete);
compraRouter.post('/:compraId/confirm', CompraController.confirm);
compraRouter.post('/:compraId/ignore', CompraController.ignore);
