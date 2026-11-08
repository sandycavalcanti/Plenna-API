import { createTempoUsoSchema, criarSyncTempoUsoSchema, tempoUsoIdSchema, tempoUsoConsultaSchema, updateTempoUsoSchema } from './tempo-uso.schemas.js';
import { TempoUsoService } from './tempo-uso.service.js';
import { handleError } from '../../utils/handleError.js';
import { AppError } from '../../errors/AppError.js';
function handleMonitoringError(res, status, error) {
    if (error instanceof AppError && error.message.startsWith('RF017_V2_REQUIRED:')) {
        return res.status(409).json({ code: 'RF017_V2_REQUIRED', message: 'Atualize o PLENNA para gerenciar o monitoramento de tempo em aplicativos.', errors: [] });
    }
    return handleError(res, status, error);
}
export class TempoUsoController {
    static async create(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const data = createTempoUsoSchema.parse(req.body);
            const tempo = await TempoUsoService.create(req.userId, data);
            return res.status(201).json(tempo);
        }
        catch (error) {
            return handleMonitoringError(res, 400, error);
        }
    }
    static async findAllByUserId(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const { mes } = tempoUsoConsultaSchema.parse(req.query);
            const tempos = await TempoUsoService.findAllByUserId(req.userId, mes);
            return res.json(tempos);
        }
        catch (error) {
            return handleMonitoringError(res, 500, error);
        }
    }
    static async findById(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const id = tempoUsoIdSchema.parse(req.params.id);
            const tempo = await TempoUsoService.findById(req.userId, id);
            return res.json(tempo);
        }
        catch (error) {
            return handleMonitoringError(res, 404, error);
        }
    }
    static async update(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const id = tempoUsoIdSchema.parse(req.params.id);
            const data = updateTempoUsoSchema.parse(req.body);
            const updated = await TempoUsoService.update(req.userId, id, data);
            return res.json(updated);
        }
        catch (error) {
            return handleMonitoringError(res, 400, error);
        }
    }
    static async delete(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const id = tempoUsoIdSchema.parse(req.params.id);
            await TempoUsoService.delete(req.userId, id);
            return res.status(204).send();
        }
        catch (error) {
            return handleMonitoringError(res, 404, error);
        }
    }
    static listarAplicativosCompra(req, res) {
        if (!req.userId)
            return res.status(401).json({ error: 'Token inválido' });
        return res.json(TempoUsoService.listarAplicativosCompra());
    }
    static async sync(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const data = criarSyncTempoUsoSchema().parse(req.body);
            const resultado = await TempoUsoService.sync(req.userId, data);
            return res.json(resultado);
        }
        catch (error) {
            return handleMonitoringError(res, 400, error);
        }
    }
}
