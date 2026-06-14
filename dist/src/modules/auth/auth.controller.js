import { AuthService } from './auth.service.js';
import { registerSchema, loginSchema } from './auth.schemas.js';
import { handleError } from '../../utils/handleError.js';
export class AuthController {
    static async register(req, res) {
        try {
            const data = registerSchema.parse(req.body);
            const user = await AuthService.register(data);
            return res.status(201).json(user);
        }
        catch (err) {
            return handleError(res, 400, err);
        }
    }
    static async login(req, res) {
        try {
            const data = loginSchema.parse(req.body);
            const result = await AuthService.login(data.email, data.senha);
            return res.json(result);
        }
        catch (err) {
            return handleError(res, 401, err);
        }
    }
}
