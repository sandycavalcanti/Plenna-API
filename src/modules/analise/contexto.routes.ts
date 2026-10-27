import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthRequest } from '../auth/auth.middleware.js';
import { handleError } from '../../utils/handleError.js';
import { contextoParamsSchema } from './contexto.schemas.js';
import { ContextoService } from './contexto.service.js';
import { AvaliacaoService } from './avaliacao.service.js';
import { HistoricoService } from './historico.service.js';

export const contextoRouter = Router();
contextoRouter.use(authMiddleware);
contextoRouter.get('/:compraId/contexto/historico', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { compraId } = contextoParamsSchema.parse(req.params);
    const { antes } = z
      .object({
        antes: z.coerce.number().int().positive().max(2147483647).optional(),
      })
      .strict()
      .parse(req.query);
    return res.json(
      await ContextoService.historico(
        (req as AuthRequest).userId!,
        compraId,
        antes,
      ),
    );
  } catch (error) {
    return handleError(res, 500, error);
  }
});
contextoRouter.get('/:compraId/indicadores-historicos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { compraId } = contextoParamsSchema.parse(req.params);
    z.object({}).strict().parse(req.query);
    return res.json(
      await HistoricoService.complementarCompra(
        (req as AuthRequest).userId!,
        compraId,
      ),
    );
  } catch (error) {
    return handleError(res, 500, error);
  }
});
contextoRouter.post('/:compraId/avaliacoes', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { compraId } = contextoParamsSchema.parse(req.params);
    z.object({}).strict().parse(req.query);
    return res.json(
      await AvaliacaoService.calcular(
        (req as AuthRequest).userId!,
        compraId,
        req.body,
      ),
    );
  } catch (error) {
    return handleError(res, 500, error);
  }
});
contextoRouter.get('/:compraId/avaliacoes/atual', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { compraId } = contextoParamsSchema.parse(req.params);
    z.object({}).strict().parse(req.query);
    return res.json(
      await AvaliacaoService.consultar((req as AuthRequest).userId!, compraId),
    );
  } catch (error) {
    return handleError(res, 500, error);
  }
});
contextoRouter.get('/:compraId/avaliacoes/:avaliacaoId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { compraId } = contextoParamsSchema.parse({
      compraId: req.params.compraId,
    });
    const avaliacaoId = z.coerce
      .number()
      .int()
      .positive()
      .max(2147483647)
      .parse(req.params.avaliacaoId);
    z.object({}).strict().parse(req.query);
    return res.json(
      await AvaliacaoService.consultar(
        (req as AuthRequest).userId!,
        compraId,
        avaliacaoId,
      ),
    );
  } catch (error) {
    return handleError(res, 500, error);
  }
});
contextoRouter.get('/:compraId/perguntas', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { compraId } = contextoParamsSchema.parse(req.params);
    z.object({}).strict().parse(req.query);
    return res.json(
      await ContextoService.perguntas((req as AuthRequest).userId!, compraId),
    );
  } catch (error) {
    return handleError(res, 500, error);
  }
});
contextoRouter
  .route('/:compraId/contexto')
  .get(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { compraId } = contextoParamsSchema.parse(req.params);
      z.object({}).strict().parse(req.query);
      return res.json(
        await ContextoService.consultar((req as AuthRequest).userId!, compraId),
      );
    } catch (error) {
      return handleError(res, 500, error);
    }
  })
  .patch(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { compraId } = contextoParamsSchema.parse(req.params);
      z.object({}).strict().parse(req.query);
      return res.json(
        await ContextoService.atualizar(
          (req as AuthRequest).userId!,
          compraId,
          req.body,
        ),
      );
    } catch (error) {
      return handleError(res, 500, error);
    }
  });
