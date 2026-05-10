import { UsersService } from "./user.service.js";
import { createUserSchema, updateUserSchema } from "./user.schemas.js";
export class UsersController {
    static async create(req, res) {
        try {
            const data = createUserSchema.parse(req.body);
            const user = await UsersService.create(data);
            return res.status(201).json(user);
        }
        catch (error) {
            return res.status(400).json({ error: error.message });
        }
    }
    static async findAll(req, res) {
        try {
            const users = await UsersService.findAll();
            return res.json(users);
        }
        catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }
    static async findById(req, res) {
        try {
            const id = Number(req.params.id);
            const user = await UsersService.findById(id);
            return res.json(user);
        }
        catch (error) {
            return res.status(404).json({ error: error.message });
        }
    }
    static async findByEmail(req, res) {
        try {
            const email = String(req.params.email);
            const user = await UsersService.findByEmail(email);
            return res.json(user);
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
            const data = updateUserSchema.parse(req.body);
            const user = await UsersService.update(req.userId, data);
            return res.json(user);
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
            await UsersService.delete(req.userId);
            return res.status(204).send();
        }
        catch (error) {
            return res.status(404).json({ error: error.message });
        }
    }
    static async findUserByToken(req, res) {
        try {
            const authReq = req;
            if (!authReq.userId) {
                return res.status(401).json({ error: "Token inválido" });
            }
            const user = await UsersService.findUserByToken(authReq.userId);
            return res.json(user);
        }
        catch (error) {
            return res.status(401).json({ error: error.message });
        }
    }
}
