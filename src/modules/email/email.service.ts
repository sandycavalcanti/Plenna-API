import axios from 'axios';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { logSeguro } from '../../utils/logSeguro.js';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
import { CONSENTIMENTO_CODIGOS } from '../consentimento/consentimento.constants.js';
import { OAuthTentativaService } from './oauth-tentativa.service.js';
import type { FinalizarEmailDTO } from './email.schemas.js';
import { GoogleTokenResponseSchema } from './email.schemas.js';

const identidadeSchema = z.object({ email: z.string().email().max(45), verified_email: z.literal(true) });
function configuracaoGoogle() {
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  const redirect_uri = process.env.GOOGLE_REDIRECT_URI;
  if (!client_id || !client_secret || !redirect_uri) throw new AppError('Conexão indisponível', 503);
  return { client_id, client_secret, redirect_uri };
}
export class EmailService {
  static async iniciar(userId: number) {
    const { client_id, redirect_uri } = configuracaoGoogle();
    const tentativa = await OAuthTentativaService.iniciar(userId);
    const params = new URLSearchParams({ client_id, redirect_uri, response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email',
      access_type: 'offline', prompt: 'consent', state: tentativa.state });
    return { ...tentativa, url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params };
  }
  static async exchangeCodeForTokens(code: string) {
    const response = await axios.post<unknown>('https://oauth2.googleapis.com/token',
      new URLSearchParams({ ...configuracaoGoogle(), code, grant_type: 'authorization_code' }),
      { timeout: 10000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const tokens = GoogleTokenResponseSchema.parse(response.data);
    const scopes = tokens.scope.split(' ');
    if (!scopes.includes('https://www.googleapis.com/auth/gmail.readonly') ||
      !scopes.includes('https://www.googleapis.com/auth/userinfo.email')) {
      throw new AppError('Permissões de e-mail insuficientes', 400);
    }
    return tokens;
  }
  static async getGoogleUserEmail(accessToken: string) {
    const response = await axios.get<unknown>('https://www.googleapis.com/oauth2/v2/userinfo', {
      timeout: 10000, headers: { Authorization: 'Bearer ' + accessToken },
    });
    return identidadeSchema.parse(response.data).email;
  }
  static async finalizar(userId: number, data: FinalizarEmailDTO) {
    await OAuthTentativaService.consumir(userId, data);
    try {
      // Nenhuma transação fica aberta durante estas chamadas de rede.
      const tokens = await this.exchangeCodeForTokens(data.code);
      const email = await this.getGoogleUserEmail(tokens.access_token);
      await prisma.$transaction(async (tx) => {
        await ConsentimentoService.bloquearUsuario(tx, userId);
        const tentativa = await OAuthTentativaService.verificar(tx, userId, data);
        if (tentativa.oauth_status !== 'PROCESSANDO' || tentativa.oauth_expira_em <= new Date()) {
          throw new AppError('Tentativa encerrada. Inicie uma nova conexão.', 409);
        }
        const anterior = await tx.tb_integracao.findFirst({
          where: { usuario_id: userId, integracao_provedor: 'GMAIL', integracao_nome: email },
        });
        const refreshToken = tokens.refresh_token ?? anterior?.integracao_refresh_token;
        if (!refreshToken) throw new AppError('Autorize novamente o acesso ao Google', 400);
        await tx.tb_integracao.deleteMany({ where: { usuario_id: userId, integracao_provedor: 'GMAIL' } });
        await tx.tb_integracao.create({ data: {
          usuario_id: userId, integracao_nome: email, integracao_provedor: 'GMAIL',
          integracao_access_token: tokens.access_token, integracao_refresh_token: refreshToken,
          integracao_token_expira_em: new Date(Date.now() + tokens.expires_in * 1000),
        } });
        await ConsentimentoService.registrarComClient(tx, userId, CONSENTIMENTO_CODIGOS.EMAIL, true, true);
        await tx.tb_oauth_tentativa.update({ where: { oauth_tentativa_id: data.tentativa },
          data: { oauth_status: 'CONCLUIDA', oauth_finalizada_em: new Date() } });
      });
      return { concluida: true };
    } catch (error) {
      logSeguro('oauth_falhou', error);
      try { await OAuthTentativaService.encerrar(userId, data, 'FALHOU'); }
      catch (encerramentoError) { logSeguro('oauth_falhou', encerramentoError); }
      throw new AppError('Não foi possível confirmar a conexão. Consulte o estado e tente novamente.', 409);
    }
  }
  static async estado(userId: number) {
    return prisma.$transaction(async (tx) => {
      await ConsentimentoService.bloquearUsuario(tx, userId);
      const autorizado = await tx.tb_consentimento.findFirst({ where: {
        usuario_id: userId, consentimento_status: true,
        tb_consentimento_tipo: { consentimento_tipo_codigo: 'EMAIL' },
      }, select: { consentimento_id: true } });
      const integracao = await tx.tb_integracao.findFirst({ where: { usuario_id: userId, integracao_provedor: 'GMAIL' },
        select: { integracao_id: true, integracao_sincronizacao_status: true } });
      const tentativa = await tx.tb_oauth_tentativa.findFirst({ where: { usuario_id: userId, oauth_provedor: 'GMAIL',
        oauth_status: { in: ['PENDENTE', 'PROCESSANDO'] }, oauth_expira_em: { gt: new Date() } }, select: { oauth_tentativa_id: true } });
      return { autorizacaoEmail: autorizado !== null,
        conexaoEmail: tentativa ? 'tentativa_em_andamento' : !integracao ? 'desconectado'
          : !autorizado || integracao.integracao_sincronizacao_status === 'ERRO' ? 'requer_reconexao' : 'conectado' };
    });
  }
  static async refreshAccessToken(refreshToken: string) {
    const { client_id, client_secret } = configuracaoGoogle();
    const response = await axios.post<unknown>('https://oauth2.googleapis.com/token',
      new URLSearchParams({ client_id, client_secret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
      { timeout: 10000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).parse(response.data);
  }
}

