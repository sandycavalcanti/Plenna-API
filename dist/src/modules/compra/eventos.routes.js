import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../auth/auth.middleware.js';
import { handleError } from '../../utils/handleError.js';
import { EventosCompraService } from './eventos.service.js';
import { ReferenciasService } from './referencias.service.js';
import { prisma } from '../../lib/prisma.js';
import { resumirEventos, criarResumoEventosDesc } from './eventos.engine.js';
import { separarContextoPersistido } from '../analise/contexto-eventos.js';
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
            .parse(req.query), ids = [...new Set(query.ids.split(',').map(Number))];
        if (ids.length > 100 ||
            ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647))
            return res.status(400).json({ message: 'Selecione até cem compras' });
        const userId = req.userId;
        const result = await prisma.$transaction(async (tx) => {
            const purchases = await tx.tb_compra.findMany({
                where: { usuario_id: userId, compra_id: { in: ids }, compra_ativo: 1 },
                select: { compra_id: true, compra_classificacao: true },
            });
            const summaries = new Map();
            if (purchases.length) {
                let cursor;
                while (true) {
                    const page = await tx.tb_compra_evento.findMany({
                        where: { usuario_id: userId, compra_id: { in: purchases.map(c => c.compra_id) },
                            ...(cursor ? { OR: [{ revisao: { lt: cursor.revisao } }, { revisao: cursor.revisao, evento_id: { lt: cursor.evento_id } }] } : {}) },
                        orderBy: [{ revisao: 'desc' }, { evento_id: 'desc' }], take: 200,
                        select: { evento_id: true, compra_id: true, compra_item_id: true, revisao: true, tipo: true, dados: true, corrige_evento_id: true, anulado: true, efetiva_em: true },
                    });
                    for (const event of page) {
                        const summary = summaries.get(event.compra_id) ?? criarResumoEventosDesc();
                        summary.adicionar(event);
                        summaries.set(event.compra_id, summary);
                    }
                    if (page.length < 200)
                        break;
                    cursor = page[page.length - 1];
                }
            }
            const contexts = purchases.length
                ? await tx.contexto_compra_revisao.findMany({
                    where: {
                        usuario_id: userId,
                        compra_id: { in: purchases.map((c) => c.compra_id) },
                    },
                    distinct: ['compra_id'],
                    orderBy: [{ compra_id: 'asc' }, { revisao: 'desc' }],
                    select: { compra_id: true, revisao: true, respostas: true },
                })
                : [];
            return purchases.map((c) => {
                const context = contexts.find((r) => r.compra_id === c.compra_id), answers = context
                    ? separarContextoPersistido(context.respostas).respostas
                    : null;
                const resumo = summaries.get(c.compra_id)?.resultado() ?? resumirEventos([]);
                return {
                    compraId: c.compra_id,
                    contextoRevisao: context?.revisao ?? 0,
                    percepcao: answers?.autopercepcaoImpulsividade === 'SIM' ? 'SIM' : null,
                    ...resumo,
                    classificacao: resumo.classificacao ?? c.compra_classificacao,
                };
            });
        }, { isolationLevel: 'RepeatableRead' });
        return res.json({ versaoContrato: 1, resumos: result });
    }
    catch (e) {
        return handleError(res, 500, e);
    }
});
eventosCompraRouter.post('/referencias', async (req, res) => {
    try {
        return res.json(await ReferenciasService.registrar(req.userId, req.body));
    }
    catch (e) {
        return handleError(res, 500, e);
    }
});
eventosCompraRouter.get('/:compraId/referencias', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const { compraId } = params.parse(req.params);
        return res.json(await ReferenciasService.consultar(req.userId, compraId));
    }
    catch (e) {
        return handleError(res, 500, e);
    }
});
eventosCompraRouter.get('/:compraId/eventos/historico', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const { compraId } = params.parse(req.params);
        const query = z.object({ antes: z.coerce.number().int().positive().max(2147483647).optional(), itemId: z.coerce.number().int().positive().max(2147483647).optional(), escopo: z.enum(['COMPRA', 'ITENS']).optional(), finalidade: z.enum(['COMPRA', 'ANALISE']).optional() }).strict().parse(req.query);
        return res.json(await EventosCompraService.historico(req.userId, compraId, query));
    }
    catch (error) {
        return handleError(res, 500, error);
    }
});
eventosCompraRouter
    .route('/:compraId/eventos')
    .get(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const { compraId } = params.parse(req.params);
        return res.json(await EventosCompraService.consultar(req.userId, compraId, req.query.compacto === '1'));
    }
    catch (e) {
        return handleError(res, 500, e);
    }
})
    .post(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const { compraId } = params.parse(req.params);
        return res.json(await EventosCompraService.registrar(req.userId, compraId, req.body));
    }
    catch (e) {
        return handleError(res, 500, e);
    }
});
