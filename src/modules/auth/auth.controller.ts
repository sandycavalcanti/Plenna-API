import { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { registerSchema, loginSchema, forgotPasswordSchema, verifyResetCodeSchema, resetPasswordSchema } from './auth.schemas.js';
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

  static async forgotPassword(req: Request, res: Response) {
    try {
      const data = forgotPasswordSchema.parse(req.body);
      await AuthService.forgotPassword(data.email);

      return res.status(200).json({ message: 'Se o e-mail existir, um código foi enviado.' });
    } catch (err: any) {
      return handleError(res, 400, err);
    }
  }

  static async verifyResetCode(req: Request, res: Response) {
    try {
      const data = verifyResetCodeSchema.parse(req.body);
      const result = await AuthService.verifyResetCode(data.email, data.codigo);

      return res.status(200).json(result);
    } catch (err: any) {
      return handleError(res, 400, err);
    }
  }

  static async resetPassword(req: Request, res: Response) {
    try {
      const data = resetPasswordSchema.parse(req.body);
      await AuthService.resetPassword(data.email, data.codigo, data.novaSenha);

      return res.status(200).json({ message: 'Senha redefinida com sucesso.' });
    } catch (err: any) {
      return handleError(res, 400, err);
    }
  }
}
