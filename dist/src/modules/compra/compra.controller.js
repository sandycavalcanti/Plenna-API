import { CompraService } from './compra.service.js';
import { createCompraSchema, updateCompraSchema } from './compra.schemas.js';
import { handleError } from '../../utils/handleError.js';
/**
 * Controla as operações HTTP relacionadas às compras.
 *
 * O usuário das operações é obtido do JWT por meio de `req.userId`,
 * impedindo que o cliente escolha arbitrariamente o proprietário de uma compra.
 * As regras de negócio permanecem concentradas em `CompraService`.
 */
export class CompraController {
    static async create(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const data = createCompraSchema.parse(req.body);
            return res.status(201).json(await CompraService.create(req.userId, data));
        }
        catch (error) {
            return handleError(res, 400, error);
        }
    }
    static async update(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const data = updateCompraSchema.parse(req.body);
            return res.json(await CompraService.update(req.userId, Number(req.params.compraId), data));
        }
        catch (error) {
            return handleError(res, 400, error);
        }
    }
    /**
     * Confirma uma compra detectada automaticamente por e-mail.
     *
     * O usuário pode enviar correções ou complementar os dados extraídos
     * automaticamente antes da confirmação definitiva da compra.
     */
    static async confirm(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const data = updateCompraSchema.partial().parse(req.body);
            return res.json(await CompraService.confirm(req.userId, Number(req.params.compraId), data));
        }
        catch (error) {
            return handleError(res, 400, error);
        }
    }
    /**
     * Confirma uma compra detectada automaticamente por e-mail.
     *
     * O usuário pode enviar correções ou complementar os dados extraídos
     * automaticamente antes da confirmação definitiva da compra.
     */
    static async ignore(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            await CompraService.ignore(req.userId, Number(req.params.compraId));
            return res.status(204).send();
        }
        catch (error) {
            return handleError(res, 400, error);
        }
    }
    static async findAllByUserId(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            return res.json(await CompraService.findAllByUserId(req.userId));
        }
        catch (error) {
            return handleError(res, 500, error);
        }
    }
    /**
     * Retorna as compras que ainda aguardam confirmação do usuário.
     */
    static async findPendingByUserId(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            return res.json(await CompraService.findPendingByUserId(req.userId));
        }
        catch (error) {
            return handleError(res, 500, error);
        }
    }
    static async findById(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            return res.json(await CompraService.findById(req.userId, Number(req.params.compraId)));
        }
        catch (error) {
            return handleError(res, 404, error);
        }
    }
}
