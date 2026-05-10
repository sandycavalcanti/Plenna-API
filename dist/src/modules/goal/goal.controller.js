import { GoalService } from './goal.service.js';
import { checkGoalSchema, createGoalSchema, updateGoalSchema } from './goal.schemas.js';
export class GoalController {
    static async create(req, res) {
        try {
            const authReq = req;
            if (!authReq.userId) {
                return res.status(401).json({ error: 'Token inválido' });
            }
            const userId = authReq.userId;
            const data = createGoalSchema.parse(req.body);
            const goal = await GoalService.create(userId, data);
            return res.status(201).json(goal);
        }
        catch (error) {
            return res.status(400).json({ error: error.message });
        }
    }
    static async findAllByUserId(req, res) {
        try {
            const authReq = req;
            if (!authReq.userId) {
                return res.status(401).json({ error: 'Token inválido' });
            }
            const userId = authReq.userId;
            const goals = await GoalService.findAllByUserId(userId);
            return res.status(200).json(goals);
        }
        catch (error) {
            return res.status(400).json({ error: error.message });
        }
    }
    static async checkGoal(req, res) {
        try {
            const authReq = req;
            if (!authReq.userId) {
                return res.status(401).json({ error: 'Token inválido' });
            }
            const userId = authReq.userId;
            const data = checkGoalSchema.parse(req.body);
            const goals = await GoalService.checkGoal(userId, data);
            return res.status(200).json(goals);
        }
        catch (error) {
            return res.status(400).json({ error: error.message });
        }
    }
    static async update(req, res) {
        try {
            if (!req.userId) {
                return res.status(401).json({ error: 'Token inválido' });
            }
            const id = Number(req.params.id);
            const data = updateGoalSchema.parse(req.body);
            const updated = await GoalService.update(req.userId, id, data);
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
            await GoalService.delete(req.userId, id);
            return res.status(204).send();
        }
        catch (error) {
            return res.status(404).json({ error: error.message });
        }
    }
}
