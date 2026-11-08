import { EmailService } from './email.service.js';
import { EmailSyncService } from './email-sync.service.js';
import { handleError } from '../../utils/handleError.js';
import { env } from '../../lib/env.js';
import crypto from 'node:crypto';
import { OAuthTentativaService } from './oauth-tentativa.service.js';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
/**
 * Compara segredos utilizando tempo constante quando possuem o mesmo tamanho,
 * reduzindo a exposição a ataques baseados no tempo da comparação.
 */
function timingSafeEqualString(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
function semCache(res) {
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
    static async connect(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            const tentativa = await OAuthTentativaService.iniciar(req.userId);
            return res.json({ url: EmailService.generateGoogleUrl(tentativa.state) });
        }
        catch (error) {
            return handleError(res, 500, error);
        }
    }
    static async status(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token invalido' });
            return res.json(await EmailService.getIntegrationStatus(req.userId));
        }
        catch (error) {
            return handleError(res, 500, error);
        }
    }
    static async callback(req, res) {
        semCache(res);
        let tentativaId = null;
        try {
            const { code, state } = req.query;
            if (typeof req.query.error === 'string') {
                if (typeof state === 'string')
                    await OAuthTentativaService.cancelar(state);
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
            await EmailService.saveIntegration(tentativa.userId, email, tokens.access_token, tokens.refresh_token, tokens.expires_in);
            await ConsentimentoService.registrar(tentativa.userId, 'EMAIL', true);
            await OAuthTentativaService.finalizar(tentativa.tentativaId, 'CONCLUIDA');
            res.redirect(`${env.apiBaseUrl}/oauth-success.html`);
        }
        catch {
            if (tentativaId) {
                try {
                    await OAuthTentativaService.finalizar(tentativaId, 'FALHOU');
                }
                catch {
                    // A falha no saneamento da tentativa nÃ£o deve expor detalhes internos no redirect.
                }
            }
            res.redirect('plenna://oauth-error');
        }
    }
    static async sync(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            return res.json(await EmailSyncService.syncUser(req.userId));
        }
        catch (error) {
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
    static async syncCron(req, res) {
        try {
            const authHeader = String(req.header('authorization') ?? '');
            const expected = `Bearer ${env.cronSecret}`;
            if (!env.cronSecret || !timingSafeEqualString(authHeader, expected)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            return res.json(await EmailSyncService.syncAllUsers());
        }
        catch (error) {
            return handleError(res, 500, error);
        }
    }
    static async listMessages(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            await EmailService.assertCaptureConsent(req.userId);
            const integration = await EmailService.findIntegrationByUserId(req.userId);
            if (!integration)
                return res.status(404).json({ error: 'Integração Gmail não encontrada' });
            const accessToken = await EmailService.getValidAccessToken(integration);
            const messages = await EmailService.listMessages(accessToken, 'in:inbox', 25);
            return res.json(messages.map((message) => ({ id: message.id, threadId: message.threadId, snippet: message.snippet, internalDate: message.internalDate, labelIds: message.labelIds })));
        }
        catch (error) {
            if (req.userId) {
                try {
                    await EmailService.markAuthorizationFailureForUser(req.userId, error);
                }
                catch {
                    // O erro original do Gmail continua sendo tratado sem expor detalhes internos.
                }
            }
            return handleError(res, 500, error);
        }
    }
    static async getMessage(req, res) {
        try {
            if (!req.userId)
                return res.status(401).json({ error: 'Token inválido' });
            await EmailService.assertCaptureConsent(req.userId);
            const integration = await EmailService.findIntegrationByUserId(req.userId);
            if (!integration)
                return res.status(404).json({ error: 'Integração Gmail não encontrada' });
            const accessToken = await EmailService.getValidAccessToken(integration);
            return res.json(await EmailService.getMessage(accessToken, String(req.params.messageId)));
        }
        catch (error) {
            if (req.userId) {
                try {
                    await EmailService.markAuthorizationFailureForUser(req.userId, error);
                }
                catch {
                    // O erro original do Gmail continua sendo tratado sem expor detalhes internos.
                }
            }
            return handleError(res, 500, error);
        }
    }
}
