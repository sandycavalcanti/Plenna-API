import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { ChatController } from './chat.controller.js';

export const chatRouter = Router();

chatRouter.use(authMiddleware);
chatRouter.post('/', ChatController.createHistory);
chatRouter.get('/', ChatController.listHistories);
chatRouter.post('/:historicoId/mensagens', ChatController.createMessage);
chatRouter.get('/:historicoId', ChatController.getHistory);
