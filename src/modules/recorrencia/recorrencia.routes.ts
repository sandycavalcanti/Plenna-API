import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { RecorrenciaController } from './recorrencia.controller.js';

export const recorrenciaRouter = Router();
recorrenciaRouter.use(authMiddleware);

recorrenciaRouter.get('/', RecorrenciaController.findAll);
recorrenciaRouter.post('/', RecorrenciaController.create);
recorrenciaRouter.get('/:recorrenciaId/proximas', RecorrenciaController.upcoming);
recorrenciaRouter.get('/:recorrenciaId', RecorrenciaController.findById);
recorrenciaRouter.patch('/:recorrenciaId', RecorrenciaController.update);
recorrenciaRouter.post('/:recorrenciaId/pausar', RecorrenciaController.pause);
recorrenciaRouter.post('/:recorrenciaId/retomar', RecorrenciaController.resume);
recorrenciaRouter.post('/:recorrenciaId/cancelar', RecorrenciaController.cancel);
