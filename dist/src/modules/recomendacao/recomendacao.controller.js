import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import { handleError } from '../../utils/handleError.js';
import { recommendationQuerySchema, recommendationService, recommendationStatusInputSchema } from './recomendacao.service.js';
const idSchema = z.coerce.number().int().positive();
function userId(req) {
    if (!req.userId)
        throw new AppError('Token inválido', 401);
    return req.userId;
}
async function safe(res, operation, status = 200) {
    try {
        return res.status(status).json(await operation());
    }
    catch (error) {
        return handleError(res, 500, error);
    }
}
export class RecommendationController {
    static list(req, res) { return safe(res, () => recommendationService.list(userId(req), recommendationQuerySchema.parse(req.query))); }
    static get(req, res) { return safe(res, () => recommendationService.get(userId(req), idSchema.parse(req.params.recomendacaoId))); }
    static updateStatus(req, res) { return safe(res, () => recommendationService.updateStatus(userId(req), idSchema.parse(req.params.recomendacaoId), recommendationStatusInputSchema.parse(req.body).status)); }
    static conversation(req, res) { return safe(res, () => recommendationService.conversation(userId(req), idSchema.parse(req.params.recomendacaoId))); }
}
