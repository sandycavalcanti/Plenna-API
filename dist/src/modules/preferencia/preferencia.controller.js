import { createPreferenciaCategoriaSchema, createPreferenciasCategoriaBulkSchema, updatePreferenciaCategoriaSchema } from './preferencia.schemas.js';
import { PreferenciasCategoriaService } from './preferencia.service.js';
export class PreferenciasCategoriaController {
    static async create(req, res) {
        try {
            if (!req.userId) {
                return res.status(401).json({ error: 'Token inválido' });
            }
            const data = createPreferenciaCategoriaSchema.parse(req.body);
            const created = await PreferenciasCategoriaService.create(req.userId, data);
            return res.status(201).json(created);
        }
        catch (error) {
            return res.status(400).json({ error: error.message });
        }
    }
    static async createMany(req, res) {
        try {
            if (!req.userId) {
                return res.status(401).json({ error: 'Token inválido' });
            }
            const data = createPreferenciasCategoriaBulkSchema.parse(req.body);
            const created = await PreferenciasCategoriaService.createMany(req.userId, data.preferencias);
            return res.status(201).json(created);
        }
        catch (error) {
            return res.status(400).json({ error: error.message });
        }
    }
    static async replaceMany(req, res) {
        try {
            if (!req.userId) {
                return res.status(401).json({ error: 'Token inválido' });
            }
            const data = createPreferenciasCategoriaBulkSchema.parse(req.body);
            const result = await PreferenciasCategoriaService.replaceMany(req.userId, data.preferencias);
            return res.status(200).json(result);
        }
        catch (error) {
            return res.status(400).json({ error: error.message });
        }
    }
    static async findAllByUserId(req, res) {
        try {
            if (!req.userId) {
                return res.status(401).json({ error: 'Token inválido' });
            }
            const preferencias = await PreferenciasCategoriaService.findAllByUserId(req.userId);
            return res.status(200).json(preferencias);
        }
        catch (error) {
            return res.status(400).json({ error: error.message });
        }
    }
    static async findById(req, res) {
        try {
            if (!req.userId) {
                return res.status(401).json({ error: 'Token inválido' });
            }
            const id = Number(req.params.id);
            const preferencia = await PreferenciasCategoriaService.findById(req.userId, id);
            return res.status(200).json(preferencia);
        }
        catch (error) {
            return res.status(404).json({ error: error.message });
        }
    }
    static async update(req, res) {
        try {
            if (!req.userId) {
                return res.status(401).json({ error: 'Token inválido' });
            }
            const id = Number(req.params.id);
            const data = updatePreferenciaCategoriaSchema.parse(req.body);
            const updated = await PreferenciasCategoriaService.update(req.userId, id, data);
            return res.status(200).json(updated);
        }
        catch (error) {
            return res.status(400).json({ error: error.message });
        }
    }
    static async delete(req, res) {
        try {
            if (!req.userId) {
                return res.status(401).json({ error: 'Token inválido' });
            }
            const id = Number(req.params.id);
            await PreferenciasCategoriaService.delete(req.userId, id);
            return res.status(204).send();
        }
        catch (error) {
            return res.status(404).json({ error: error.message });
        }
    }
}
