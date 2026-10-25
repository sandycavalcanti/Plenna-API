import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthRequest } from '../auth/auth.middleware.js';
import { handleError } from '../../utils/handleError.js';
import { EventosCompraService } from './eventos.service.js';
import { ReferenciasService } from './referencias.service.js';
import { prisma } from '../../lib/prisma.js';
import { ledgerDisponivel } from './eventos.service.js';
import { resumirEventos } from './eventos.engine.js';
import { separarContextoPersistido } from '../rf018/eventos.schemas.js';
export const eventosCompraRouter = Router();
eventosCompraRouter.use(authMiddleware);
// As chaves do banco são INTEGER; rejeitar overflow aqui preserva a resposta de validação HTTP.
const params = z.object({ compraId: z.coerce.number().int().positive().max(2147483647) });
eventosCompraRouter.get('/resumos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const query = z
        .object({ ids: z.string().regex(/^\d+(?:,\d+)*$/) })
        .strict()
        .parse(req.query),
      ids = [...new Set(query.ids.split(',').map(Number))];
    if (
      ids.length > 100 ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)
    )
      return res.status(400).json({ message: 'Selecione até cem compras' });
    const userId = (req as AuthRequest).userId!;
    const result = await prisma.$transaction(async (tx) => {
      const purchases = await tx.tb_compra.findMany({
        where: { usuario_id: userId, compra_id: { in: ids }, compra_ativo: 1 },
        select: { compra_id: true, compra_classificacao: true },
      });
      const available = await ledgerDisponivel(tx),
        eventos = available
          ? await tx.tb_compra_evento.findMany({
              where: {
                usuario_id: userId,
                compra_id: { in: purchases.map((c) => c.compra_id) },
              },
              orderBy: { revisao: 'asc' },
            })
          : [];
      const contexts = await tx.tb_rf018_contexto_revisao.findMany({
        where: {
          usuario_id: userId,
          compra_id: { in: purchases.map((c) => c.compra_id) },
        },
        distinct: ['compra_id'],
        orderBy: [{ compra_id: 'asc' }, { revisao: 'desc' }],
        select: { compra_id: true, revisao: true, respostas: true },
      });
      return purchases.map((c) => {
        const context = contexts.find((r) => r.compra_id === c.compra_id),
          answers = context
            ? (separarContextoPersistido(context.respostas).respostas as Record<
                string,
                unknown
              >)
            : null;
        return {
          compraId: c.compra_id,
          classificacao: c.compra_classificacao,
          contextoRevisao: context?.revisao ?? 0,
          percepcao:
            answers?.autopercepcaoImpulsividade === 'SIM' ? 'SIM' : null,
          ...(available
            ? resumirEventos(eventos.filter((e) => e.compra_id === c.compra_id))
            : {
                oculto: false,
                itensOcultos: [],
                classificacaoVoluntaria: null,
              }),
          eventosDisponiveis: available,
        };
      });
    });
    return res.json({ versaoContrato: 1, resumos: result });
  } catch (e) {
    return handleError(res, 500, e);
  }
});
eventosCompraRouter.post('/referencias', async (req, res) => {
  try {
    return res.json(
      await ReferenciasService.registrar(
        (req as AuthRequest).userId!,
        req.body,
      ),
    );
  } catch (e) {
    return handleError(res, 500, e);
  }
});
eventosCompraRouter.get('/:compraId/referencias', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { compraId } = params.parse(req.params);
    return res.json(
      await ReferenciasService.consultar(
        (req as AuthRequest).userId!,
        compraId,
      ),
    );
  } catch (e) {
    return handleError(res, 500, e);
  }
});
eventosCompraRouter
  .route('/:compraId/eventos')
  .get(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { compraId } = params.parse(req.params);
      return res.json(
        await EventosCompraService.consultar(
          (req as AuthRequest).userId!,
          compraId,
        ),
      );
    } catch (e) {
      return handleError(res, 500, e);
    }
  })
  .post(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { compraId } = params.parse(req.params);
      return res.json(
        await EventosCompraService.registrar(
          (req as AuthRequest).userId!,
          compraId,
          req.body,
        ),
      );
    } catch (e) {
      return handleError(res, 500, e);
    }
  });
