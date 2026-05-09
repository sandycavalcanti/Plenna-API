import axios from 'axios';
import { prisma } from '../../lib/prisma.js';

export class EmailService {
  static generateGoogleUrl(userId: number) {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
      response_type: 'code',
      scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/userinfo.email'].join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: userId.toString(), // 🔥 MUITO IMPORTANTE
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  static async exchangeCodeForTokens(code: string) {
    const response = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
        grant_type: 'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    return response.data;
  }

  static async getGoogleUserEmail(accessToken: string) {
    const res = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
    return res.data.email;
  }

  static async saveIntegration(userId: number, email: string, access_token: string, refreshToken: string, expiresIn: number) {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    return prisma.tb_integracao.create({
      data: {
        usuario_id: userId,
        integracao_nome: email,
        integracao_provedor: 'GMAIL',
        integracao_access_token: access_token,
        integracao_refresh_token: refreshToken,
        integracao_token_expira_em: expiresAt,
      },
    });
  }

  static async refreshAccessToken(refreshToken: string) {
    const response = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    return response.data;
  }
}
