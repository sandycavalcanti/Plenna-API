import { createTempoUsoSchema, updateTempoUsoSchema } from './tempo-uso.schemas.js';
import { TempoUsoService } from './tempo-uso.service.js';
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
            return res.status(400).json({ error: error.message });
        }
    }
    static async findAllByUserId(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const tempos = await TempoUsoService.findAllByUserId(req.userId);
            return res.json(tempos);
        }
        catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }
    static async findById(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const id = Number(req.params.id);
            const tempo = await TempoUsoService.findById(req.userId, id);
            return res.json(tempo);
        }
        catch (error) {
            return res.status(404).json({ error: error.message });
        }
    }
    static async update(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const id = Number(req.params.id);
            const data = updateTempoUsoSchema.parse(req.body);
            const updated = await TempoUsoService.update(req.userId, id, data);
            return res.json(updated);
        }
        catch (error) {
            return res.status(400).json({ error: error.message });
        }
    }
    static async delete(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const id = Number(req.params.id);
            await TempoUsoService.delete(req.userId, id);
            return res.status(204).send();
        }
        catch (error) {
            return res.status(404).json({ error: error.message });
        }
    }
}
