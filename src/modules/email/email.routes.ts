import { Router } from 'express';
import { EmailController } from './email.controller.js';
import { authMiddleware } from '../auth/auth.middleware.js';

export const emailRouter = Router();

emailRouter.post('/connect', authMiddleware, EmailController.connect);
emailRouter.post('/finalize', authMiddleware, EmailController.finalizar);
emailRouter.post('/cancel', authMiddleware, EmailController.cancelar);
emailRouter.get('/status', authMiddleware, EmailController.estado);
emailRouter.get('/callback', EmailController.callback);
