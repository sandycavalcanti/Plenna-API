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

      if (!code || !state) {
        return res.status(400).json({ error: 'Código e state são obrigatórios' });
      }

      const tokens = await EmailService.exchangeCodeForTokens(code);
      const email = await EmailService.getGoogleUserEmail(tokens.access_token);
      await EmailService.saveIntegration(Number(state), email, tokens.access_token, tokens.refresh_token, tokens.expires_in);

      const successUrl = `${process.env.API_BASE_URL || 'https://plenna-api-orpin.vercel.app'}/oauth-success.html`;
      return res.redirect(successUrl);
    } catch (error: any) {
      console.error(error.response?.data || error);
      return res.redirect('plenna://oauth-error');
    }
  }
}
