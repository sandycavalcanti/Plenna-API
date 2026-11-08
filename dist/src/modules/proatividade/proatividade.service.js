import { createHash } from 'node:crypto';
import { AppError } from '../../errors/AppError.js';
import { env } from '../../lib/env.js';
import { CONSENTIMENTO_CODIGOS } from '../consentimento/consentimento.constants.js';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
import { recommendationService } from '../recomendacao/recomendacao.service.js';
import { dispatchPushAfterCommit } from '../notification/push.service.js';
import { PrismaProactivityRepository } from './proatividade.repository.js';
import { createApprovedProactiveMessageService } from './proatividade.text.js';
import { proactiveFactsSchema, proactiveReasonSchema, proactiveResultSchema, } from './proatividade.contracts.js';
function assertUserId(userId) {
    if (!Number.isSafeInteger(userId) || userId <= 0)
        throw new AppError('Usuário autenticado inválido', 401);
}
function minutesAt(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return hour * 60 + minute;
}
export function isQuietHours(date, timezone, start, end) {
    const now = minutesAt(date, timezone);
    const [startHour, startMinute] = start.split(':').map(Number);
    const [endHour, endMinute] = end.split(':').map(Number);
    const quietStart = startHour * 60 + startMinute;
    const quietEnd = endHour * 60 + endMinute;
    if (quietStart === quietEnd)
        return false;
    return quietStart < quietEnd
        ? now >= quietStart && now < quietEnd
        : now >= quietStart || now < quietEnd;
}
export function proactiveDedupeKey(candidate) {
    return createHash('sha256')
        .update(`proatividade:v1|regra:${candidate.tipo}|evento:${candidate.chave}`)
        .digest('hex');
}
function hasReliableEvidence(candidate) {
    const evidence = candidate.evidencias;
    const references = evidence.referencias;
    return Array.isArray(references)
        && references.length > 0
        && references.every((value) => typeof value === 'string' && value.length <= 160)
        && candidate.texto.trim().length > 0;
}
function factsFor(candidate) {
    const evidence = candidate.evidencias;
    const periodo = typeof evidence.periodo === 'string' ? evidence.periodo : undefined;
    const referencias = Array.isArray(evidence.referencias)
        ? evidence.referencias.filter((value) => typeof value === 'string').slice(0, 30)
        : [];
    const limitacoes = Array.isArray(evidence.limitacoes)
        ? evidence.limitacoes.filter((value) => typeof value === 'string').slice(0, 20)
        : [];
    return proactiveFactsSchema.parse({
        tipo: candidate.tipo,
        titulo: candidate.titulo,
        texto: candidate.texto,
        periodo,
        referencias,
        limitacoes,
    });
}
function safeReason(value) {
    const parsed = proactiveReasonSchema.safeParse(value);
    return parsed.success ? parsed.data : 'EVENTO_DUPLICADO';
}
export class ProactivityService {
    constructor(dependencies = {}) {
        this.enabled = dependencies.enabled ?? env.proactivityEnabled;
        this.repository = dependencies.repository ?? new PrismaProactivityRepository();
        this.recommendations = dependencies.recommendations ?? recommendationService;
        this.consent = dependencies.consent ?? ConsentimentoService;
        this.messages = dependencies.messages ?? createApprovedProactiveMessageService();
        this.dispatchPush = dependencies.dispatchPush ?? dispatchPushAfterCommit;
    }
    async hasConsent(userId, code) {
        return this.consent.temConsentimentoAtivo(userId, code);
    }
    async authorizationReason(userId) {
        if (!(await this.hasConsent(userId, CONSENTIMENTO_CODIGOS.IA_PROATIVIDADE))) {
            return 'CONSENTIMENTO_PROATIVIDADE_INATIVO';
        }
        if (!(await this.hasConsent(userId, CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO))) {
            return 'CONSENTIMENTO_PERSONALIZACAO_INATIVO';
        }
        return null;
    }
    async processUser(userId, options = {}) {
        assertUserId(userId);
        const now = options.now ?? new Date();
        const timezone = options.timezone ?? env.proactivityTimezone;
        const empty = (motivo, recomendacaoId = null, estado = 'SUPRIMIDA') => proactiveResultSchema.parse({
            estado, motivo, recomendacaoId, historicoId: null, notificacaoId: null, fonte: null,
        });
        const initialAuthorization = await this.authorizationReason(userId);
        if (initialAuthorization)
            return empty(initialAuthorization);
        if (!this.enabled && options.persist !== false) {
            return empty('ESTRUTURA_INDISPONIVEL');
        }
        if (!(await this.hasConsent(userId, CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO))) {
            return empty('CONSENTIMENTO_PERSONALIZACAO_INATIVO');
        }
        if (isQuietHours(now, timezone, env.proactivityQuietStart, env.proactivityQuietEnd)) {
            return empty('FORA_HORARIO_SILENCIOSO');
        }
        const since = new Date(now.getTime() - env.proactivityCooldownDays * 24 * 60 * 60 * 1000);
        if (await this.repository.findLatestCreated(userId, since))
            return empty('COOLDOWN_ATIVO');
        const candidates = await this.recommendations.listEligibleForProactivity(userId, env.proactivityMaxCandidates, now);
        const candidate = candidates.find(hasReliableEvidence);
        if (!candidate)
            return empty('SEM_RECOMENDACAO_ELEGIVEL', null, 'NENHUMA_ACAO');
        const key = proactiveDedupeKey(candidate);
        const existing = await this.repository.findByKey(userId, key);
        if (existing) {
            return proactiveResultSchema.parse({
                estado: existing.status === 'CRIADA' ? 'EXISTENTE' : 'SUPRIMIDA',
                motivo: existing.status === 'CRIADA' ? 'CONVERSA_EXISTENTE' : safeReason(existing.reason),
                recomendacaoId: candidate.id,
                historicoId: existing.historyId,
                notificacaoId: existing.notificationId,
                fonte: null,
            });
        }
        const message = await this.messages.generate(factsFor(candidate));
        if (options.persist === false) {
            return {
                estado: 'NENHUMA_ACAO',
                recomendacaoId: candidate.id,
                historicoId: null,
                notificacaoId: null,
                fonte: message.fonte,
                mensagem: message.texto,
                preview: true,
            };
        }
        // Revalidação imediatamente antes da gravação. A transação Prisma faz a
        // segunda proteção sob lock do usuário para cobrir revogação concorrente.
        const beforePersistAuthorization = await this.authorizationReason(userId);
        if (beforePersistAuthorization)
            return empty(beforePersistAuthorization, candidate.id);
        // There is intentionally no retry here: an ambiguous write must be resolved
        // by the persistent unique key, not repeated by the process.
        let persisted;
        try {
            persisted = await this.repository.createIfAbsent({
                userId,
                key,
                recommendationId: candidate.id,
                recommendationKey: candidate.chave,
                title: message.titulo,
                message: message.texto,
                createdAt: now,
                cooldownSince: since,
            });
        }
        catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
                return empty('CONSENTIMENTO_PROATIVIDADE_INATIVO', candidate.id);
            }
            throw error;
        }
        if (!persisted.created) {
            return proactiveResultSchema.parse({
                estado: persisted.record.status === 'CRIADA' ? 'EXISTENTE' : 'SUPRIMIDA',
                motivo: persisted.record.status === 'CRIADA' ? 'CONVERSA_EXISTENTE' : safeReason(persisted.record.reason),
                recomendacaoId: candidate.id,
                historicoId: persisted.record.historyId,
                notificacaoId: persisted.record.notificationId,
                fonte: null,
            });
        }
        // Revogação após o commit não recria nem remove a conversa já autorizada,
        // mas impede o despacho proativo desta execução.
        if (persisted.record.notificationId && !(await this.authorizationReason(userId))) {
            try {
                await this.dispatchPush(userId, [{
                        notificationId: persisted.record.notificationId,
                        type: 'PROATIVA',
                        body: 'Você tem uma nova mensagem da Plenna.',
                    }]);
            }
            catch {
                // Push é best effort; o histórico e a notificação persistidos são a
                // fonte de verdade e a chamada não será repetida automaticamente.
            }
        }
        return proactiveResultSchema.parse({
            estado: 'CRIADA',
            recomendacaoId: candidate.id,
            historicoId: persisted.record.historyId,
            notificacaoId: persisted.record.notificationId,
            fonte: message.fonte,
        });
    }
    async previewForUser(userId, options = {}) {
        if (env.isProduction)
            throw new AppError('Pré-visualização indisponível neste ambiente', 403);
        return this.processUser(userId, { ...options, persist: false });
    }
}
export const proactivityService = new ProactivityService();
export async function runProactivityManually(userId, options = {}) {
    if (env.isProduction)
        throw new AppError('Execução manual indisponível neste ambiente', 403);
    return options.persist === true
        ? proactivityService.processUser(userId, options)
        : proactivityService.previewForUser(userId, options);
}
