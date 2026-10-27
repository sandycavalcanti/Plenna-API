import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { RecommendationController } from './recomendacao.controller.js';

export const recomendacaoRouter = Router();
recomendacaoRouter.use(authMiddleware);
recomendacaoRouter.get('/', RecommendationController.list);
recomendacaoRouter.get('/:recomendacaoId', RecommendationController.get);
recomendacaoRouter.patch('/:recomendacaoId/status', RecommendationController.updateStatus);
recomendacaoRouter.get('/:recomendacaoId/conversa', RecommendationController.conversation);
