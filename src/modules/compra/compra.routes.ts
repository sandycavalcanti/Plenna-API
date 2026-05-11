import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { CompraController } from './compra.controller.js';

export const compraRouter = Router();

compraRouter.use(authMiddleware);

compraRouter.get('/', CompraController.findAllByUserId);
compraRouter.get('/:compraId', CompraController.findById);
compraRouter.post('/', CompraController.create);
compraRouter.put('/:compraId', CompraController.update);
compraRouter.delete('/:compraId', CompraController.delete);
