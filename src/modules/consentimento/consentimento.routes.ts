import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { ConsentimentoController } from './consentimento.controller.js';

export const consentimentoRouter = Router();

consentimentoRouter.get('/tipos', authMiddleware, ConsentimentoController.findTipos);
consentimentoRouter.get('/', authMiddleware, ConsentimentoController.findAllByUserId);
consentimentoRouter.post('/', authMiddleware, ConsentimentoController.registrar);
consentimentoRouter.post('/bulk', authMiddleware, ConsentimentoController.registrarBulk);
