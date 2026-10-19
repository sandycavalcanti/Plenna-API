import { ConsentimentoService } from './consentimento.service.js';
import { registrarConsentimentoSchema, registrarConsentimentosBulkSchema } from './consentimento.schemas.js';
import { handleError } from '../../utils/handleError.js';
export class ConsentimentoController {
    static async findTipos(req, res) {
        try {
            const tipos = await ConsentimentoService.findTipos();
            return res.status(200).json(tipos);
        }
        catch (err) {
            return handleError(res, 400, err);
        }
    }
    static async findAllByUserId(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const consentimentos = await ConsentimentoService.findAllByUserId(req.userId);
            return res.status(200).json(consentimentos);
        }
        catch (err) {
            return handleError(res, 400, err);
        }
    }
    static async registrar(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const data = registrarConsentimentoSchema.parse(req.body);
            const consentimento = await ConsentimentoService.registrar(req.userId, data.consentimentoTipoCodigo, data.status);
            return res.status(200).json(consentimento);
        }
        catch (err) {
            return handleError(res, 400, err);
        }
    }
    static async registrarBulk(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const data = registrarConsentimentosBulkSchema.parse(req.body);
            const consentimentos = await ConsentimentoService.registrarBulk(req.userId, data);
            return res.status(200).json(consentimentos);
        }
        catch (err) {
            return handleError(res, 400, err);
        }
    }
}
