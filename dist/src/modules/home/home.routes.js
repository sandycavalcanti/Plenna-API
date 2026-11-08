import { Router } from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { handleError } from '../../utils/handleError.js';
import { homeQuerySchema } from './home.schemas.js';
import { HomeService } from './home.service.js';
export const homeRouter = Router();
homeRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
homeRouter.get('/resumo', authMiddleware, async (req, res) => {
    try {
        const { periodo, versao } = homeQuerySchema.parse(req.query);
        return res.json(await HomeService.consultar(req.userId, periodo, new Date(), versao ?? 1));
    }
    catch (error) {
        return handleError(res, 500, error);
    }
});
