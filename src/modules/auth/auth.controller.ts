import { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { registerSchema, loginSchema } from './auth.schemas.js';
import { handleError } from '../../utils/handleError.js';

export class AuthController {
  static async register(req: Request, res: Response) {
    try {
      const data = registerSchema.parse(req.body);
      const user = await AuthService.register(data);

      return res.status(201).json(user);
    } catch (err: any) {
      return handleError(res, 400, err);
    }
  }

  static async login(req: Request, res: Response) {
    try {
      const data = loginSchema.parse(req.body);
      const result = await AuthService.login(data.email, data.senha);

      return res.json(result);
    } catch (err: any) {
      return handleError(res, 401, err);
    }
  }
}
