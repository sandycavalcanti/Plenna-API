import type { Request, Response } from 'express';
import { AuthRequest } from '../auth/auth.middleware.js';
import { EmailService } from './email.service.js';
import { EmailSyncService } from './email-sync.service.js';
import { handleError } from '../../utils/handleError.js';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import crypto from 'node:crypto';
import { OAuthTentativaService } from './oauth-tentativa.service.js';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
/**
 * Compara segredos utilizando tempo constante quando possuem o mesmo tamanho,
 * reduzindo a exposição a ataques baseados no tempo da comparação.
 */
function timingSafeEqualString(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function semCache(res: Response) {
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    Expires: '0',
  });
}
/**
 * Controla as operações HTTP da integração de e-mail.
 *
 * O controller trata autenticação, parâmetros e respostas HTTP, enquanto
 * OAuth, acesso ao Gmail e sincronização permanecem concentrados nos services.
 */
export class EmailController {
  /**
   * Inicia a vinculação da conta Gmail do usuário autenticado.
   *
   * A URL OAuth é gerada pelo service com os escopos necessários para leitura
   * do Gmail e identificação da conta conectada.
   */
  static async connect(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      semCache(res);
      const tentativa = await OAuthTentativaService.iniciar(req.userId);
      return res.json({ url: EmailService.generateGoogleUrl(tentativa.state), ...tentativa });
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }
  static async cancelConnect(req: AuthRequest, res: Response) {
    semCache(res);
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      const attempt = z.object({
        tentativa: z.uuid(),
        state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        segredo: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      }).parse(req.body);
      await OAuthTentativaService.encerrar(req.userId, attempt, 'CANCELADA');
      return res.status(204).send();
    } catch (error: unknown) {
      return handleError(res, 400, error);
    }
  }

  static async status(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token invalido' });
      return res.json(await EmailService.getIntegrationStatus(req.userId));
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }

  static async callback(req: Request, res: Response): Promise<void> {
    semCache(res);
    let tentativaId: string | null = null;
    try {
      const { code, state } = req.query;
      if (typeof req.query.error === 'string') {
        if (typeof state === 'string') await OAuthTentativaService.cancelar(state);
        res.redirect('plenna://oauth-error');
        return;
      }
      if (typeof code !== 'string' || typeof state !== 'string') {
        res.redirect('plenna://oauth-error');
        return;
      }

      const tentativa = await OAuthTentativaService.callback(state);
      tentativaId = tentativa.tentativaId;
      const tokens = await EmailService.exchangeCodeForTokens(String(code));
      const email = await EmailService.getGoogleUserEmail(tokens.access_token);
      await prisma.$transaction(async (tx) => {
        await ConsentimentoService.bloquearUsuario(tx, tentativa.userId);
        const finalizada = await tx.tb_oauth_tentativa.updateMany({
          where: { oauth_tentativa_id: tentativa.tentativaId, oauth_status: 'PROCESSANDO' },
          data: { oauth_status: 'CONCLUIDA', oauth_finalizada_em: new Date() },
        });
        if (finalizada.count !== 1) throw new Error('Tentativa indisponível');
        await EmailService.saveIntegration(tentativa.userId, email, tokens.access_token, tokens.refresh_token, tokens.expires_in, tx);
        await ConsentimentoService.registrarComClient(tx, tentativa.userId, 'EMAIL', true);
      });

      res.redirect(`${env.apiBaseUrl}/oauth-success.html?tentativa=${encodeURIComponent(tentativa.tentativaId)}`);
    } catch {
      if (tentativaId) {
        try {
          await OAuthTentativaService.finalizar(tentativaId, 'FALHOU');
        } catch {
          // A falha no saneamento da tentativa nÃ£o deve expor detalhes internos no redirect.
        }
      }
      res.redirect('plenna://oauth-error');
    }
  }

  static async sync(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      return res.json(await EmailSyncService.syncUser(req.userId));
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }
  /**
   * Executa a sincronização automática disparada pelo scheduler.
   *
   * Essa rota não usa JWT de usuário porque representa uma chamada interna da
   * infraestrutura. O acesso é protegido por um segredo enviado no header
   * `Authorization`.
   */
  static async syncCron(req: any, res: Response) {
    try {
      const authHeader = String(req.header('authorization') ?? '');
      const expected = `Bearer ${env.cronSecret}`;
      if (!env.cronSecret || !timingSafeEqualString(authHeader, expected)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      return res.json(await EmailSyncService.syncAllUsers());
    } catch (error: any) {
      return handleError(res, 500, error);
    }
  }

  static async listMessages(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      await EmailService.assertCaptureConsent(req.userId);
      const integration = await EmailService.findIntegrationByUserId(req.userId);
      if (!integration) return res.status(404).json({ error: 'Integração Gmail não encontrada' });

      const accessToken = await EmailService.getValidAccessToken(integration);
      const messages = await EmailService.listMessages(accessToken, 'in:inbox', 25);
      return res.json(messages.map((message) => ({ id: message.id, threadId: message.threadId, snippet: message.snippet, internalDate: message.internalDate, labelIds: message.labelIds })));
    } catch (error: any) {
      if (req.userId) {
        try {
          await EmailService.markAuthorizationFailureForUser(req.userId, error);
        } catch {
          // O erro original do Gmail continua sendo tratado sem expor detalhes internos.
        }
      }
      return handleError(res, 500, error);
    }
  }

  static async getMessage(req: AuthRequest, res: Response) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Token inválido' });
      await EmailService.assertCaptureConsent(req.userId);
      const integration = await EmailService.findIntegrationByUserId(req.userId);
      if (!integration) return res.status(404).json({ error: 'Integração Gmail não encontrada' });

      const accessToken = await EmailService.getValidAccessToken(integration);
      return res.json(await EmailService.getMessage(accessToken, String(req.params.messageId)));
    } catch (error: any) {
      if (req.userId) {
        try {
          await EmailService.markAuthorizationFailureForUser(req.userId, error);
        } catch {
          // O erro original do Gmail continua sendo tratado sem expor detalhes internos.
        }
      }
      return handleError(res, 500, error);
    }
  }
}
