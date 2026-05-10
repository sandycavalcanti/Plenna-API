import { Router } from 'express';
import { EmailController } from './email.controller.js';
import { authMiddleware } from '../auth/auth.middleware.js';
export const emailRouter = Router();
emailRouter.get('/connect', authMiddleware, EmailController.connect);
emailRouter.get('/callback', EmailController.callback);
