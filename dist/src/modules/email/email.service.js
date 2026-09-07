import axios from 'axios';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { normalizeGmailMessage } from './gmail.normalizer.js';
const googleTokenResponseSchema = z.object({
    access_token: z.string(),
    expires_in: z.number(),
    refresh_token: z.string().optional(),
});
const gmailListResponseSchema = z.object({
    messages: z.array(z.object({
        id: z.string(),
        threadId: z.string().optional(),
    })).optional(),
    nextPageToken: z.string().optional(),
});
const gmailMessageResponseSchema = z.object({
    id: z.string(),
    threadId: z.string().optional(),
    snippet: z.string().optional(),
    internalDate: z.string().optional(),
    labelIds: z.array(z.string()).optional(),
    payload: z.any().optional(),
});
const userInfoSchema = z.object({ email: z.string().email() });
/**
 * Centraliza acesso ao Google/Gmail e validação das respostas externas.
 */
export class EmailService {
    /**
     * Gera a URL OAuth do Google usando os escopos mínimos necessários.
     */
    static generateGoogleUrl(userId) {
        const params = new URLSearchParams({
            client_id: env.googleClientId,
            redirect_uri: env.googleRedirectUri,
            response_type: 'code',
            scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/userinfo.email'].join(' '),
            access_type: 'offline',
            prompt: 'consent',
            state: userId.toString(),
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }
    static async exchangeCodeForTokens(code) {
        const response = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
            code,
            client_id: env.googleClientId,
            client_secret: env.googleClientSecret,
            redirect_uri: env.googleRedirectUri,
            grant_type: 'authorization_code',
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        return googleTokenResponseSchema.parse(response.data);
    }
    static async getGoogleUserEmail(accessToken) {
        const response = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        return userInfoSchema.parse(response.data).email;
    }
    static async saveIntegration(userId, email, accessToken, refreshToken, expiresIn) {
        const existing = await prisma.tb_integracao.findFirst({
            where: { usuario_id: userId, integracao_provedor: 'GMAIL' },
            orderBy: { integracao_data_criacao: 'desc' },
        });
        const expiresAt = new Date(Date.now() + expiresIn * 1000);
        const nextRefreshToken = refreshToken && refreshToken.trim().length > 0
            ? refreshToken
            : existing?.integracao_refresh_token ?? null;
        if (!nextRefreshToken)
            throw new Error('Refresh token ausente');
        if (existing) {
            return prisma.tb_integracao.update({
                where: { integracao_id: existing.integracao_id },
                data: {
                    integracao_email: email,
                    integracao_access_token: accessToken,
                    integracao_refresh_token: nextRefreshToken,
                    integracao_token_expira_em: expiresAt,
                },
            });
        }
        return prisma.tb_integracao.create({
            data: {
                usuario_id: userId,
                integracao_email: email,
                integracao_provedor: 'GMAIL',
                integracao_access_token: accessToken,
                integracao_refresh_token: nextRefreshToken,
                integracao_token_expira_em: expiresAt,
            },
        });
    }
    static async refreshAccessToken(refreshToken) {
        const response = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
            client_id: env.googleClientId,
            client_secret: env.googleClientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        return googleTokenResponseSchema.parse(response.data);
    }
    static async findIntegrationByUserId(userId) {
        return prisma.tb_integracao.findFirst({
            where: { usuario_id: userId, integracao_provedor: 'GMAIL' },
            orderBy: { integracao_data_criacao: 'desc' },
            select: {
                integracao_id: true,
                usuario_id: true,
                integracao_email: true,
                integracao_access_token: true,
                integracao_refresh_token: true,
                integracao_token_expira_em: true,
                integracao_ultima_sincronizacao_em: true,
            },
        });
    }
    static async refreshIntegrationTokens(integration) {
        const refreshed = await this.refreshAccessToken(integration.integracao_refresh_token);
        const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
        return prisma.tb_integracao.update({
            where: { integracao_id: integration.integracao_id },
            data: {
                integracao_access_token: refreshed.access_token,
                integracao_token_expira_em: expiresAt,
            },
        });
    }
    static async getValidAccessToken(integration) {
        if (integration.integracao_token_expira_em.getTime() > Date.now() + 60000)
            return integration.integracao_access_token;
        const refreshed = await this.refreshIntegrationTokens(integration);
        return refreshed.integracao_access_token;
    }
    static async listMessages(accessToken, query, maxResults = 25, maxTotal) {
        const messages = [];
        let pageToken;
        do {
            const response = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
                headers: { Authorization: `Bearer ${accessToken}` },
                params: { q: query, maxResults, pageToken },
            });
            const parsed = gmailListResponseSchema.parse(response.data);
            for (const message of parsed.messages ?? []) {
                messages.push({ id: message.id, threadId: message.threadId, labelIds: [] });
                if (maxTotal !== undefined && messages.length >= maxTotal) {
                    return messages;
                }
            }
            pageToken = parsed.nextPageToken;
        } while (pageToken);
        return messages;
    }
    static async fetchMessage(accessToken, messageId) {
        const response = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: { format: 'full' },
        });
        return gmailMessageResponseSchema.parse(response.data);
    }
    static async getNormalizedMessage(accessToken, messageId) {
        const parsed = await this.fetchMessage(accessToken, messageId);
        return normalizeGmailMessage(parsed);
    }
    static async getMessage(accessToken, messageId) {
        const parsed = await this.fetchMessage(accessToken, messageId);
        const payload = parsed.payload ?? {};
        const headers = Array.isArray(payload.headers)
            ? (payload.headers ?? [])
            : [];
        const findHeader = (name) => headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
        const normalized = normalizeGmailMessage(parsed);
        return {
            id: parsed.id,
            threadId: parsed.threadId,
            snippet: parsed.snippet,
            internalDate: parsed.internalDate,
            labelIds: parsed.labelIds ?? [],
            from: findHeader('From'),
            to: findHeader('To'),
            subject: findHeader('Subject'),
            date: findHeader('Date'),
            bodyText: normalized.textBody,
            textBody: normalized.textBody,
            htmlBody: normalized.htmlBody,
            links: normalized.links,
            attachments: normalized.attachments,
        };
    }
}
