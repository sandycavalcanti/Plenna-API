import { Response } from 'express';
import { AuthRequest } from '../auth/auth.middleware.js';
import { EmailService } from './email.service.js';

export class EmailController {
  static async connect(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });

      const url = EmailService.generateGoogleUrl(req.userId);
      return res.json({ url });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  static async callback(req: any, res: Response) {
    try {
      const { code, state } = req.query;

      if (!code || !state) return res.status(400).send('Callback inválido');

      const tokens = await EmailService.exchangeCodeForTokens(code);
      if (!tokens.refresh_token) throw new Error('Refresh token não recebido. Revogue o acesso e tente novamente.');
      const email = await EmailService.getGoogleUserEmail(tokens.access_token);

      await EmailService.saveIntegration(Number(state), email, tokens.access_token, tokens.refresh_token, tokens.expires_in);

      res.send('Email conectado com sucesso 🎉 Pode fechar.');
    } catch (error: any) {
      console.error(error.response?.data || error);
      res.send('Erro ao conectar email 😢');
    }
  }
}
