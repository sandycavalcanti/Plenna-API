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
      const tokens = await EmailService.exchangeCodeForTokens(code);
      const email = await EmailService.getGoogleUserEmail(tokens.access_token);
      await EmailService.saveIntegration(Number(state), email, tokens.access_token, tokens.refresh_token, tokens.expires_in);
      return res.redirect('https://plenna-api-orpin.vercel.app/oauth-success.html');
    } catch (error: any) {
      console.error(error.response?.data || error);
      return res.redirect('plenna://oauth-error');
    }
  }
}
