import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { NotificationService } from '../notification/notification.service.js';
import { CONSENTIMENTO_CODIGOS } from '../consentimento/consentimento.constants.js';
const proactivitySelect = {
    ai_proatividade_id: true,
    usuario_id: true,
    ai_proatividade_chave: true,
    ai_proatividade_recomendacao_id: true,
    ai_proatividade_historico_id: true,
    ai_proatividade_notificacao_id: true,
    ai_proatividade_status: true,
    ai_proatividade_motivo: true,
    ai_proatividade_data_criacao: true,
    ai_proatividade_data_atualizacao: true,
};
function mapRecord(record) {
    return {
        id: record.ai_proatividade_id,
        userId: record.usuario_id,
        key: record.ai_proatividade_chave,
        recommendationId: record.ai_proatividade_recomendacao_id,
        historyId: record.ai_proatividade_historico_id,
        notificationId: record.ai_proatividade_notificacao_id,
        status: record.ai_proatividade_status,
        reason: record.ai_proatividade_motivo,
        createdAt: record.ai_proatividade_data_criacao,
        updatedAt: record.ai_proatividade_data_atualizacao,
    };
}
function isUniqueError(error) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
function diagnosticCode(error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError)
        return error.code;
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
        return error.code.slice(0, 40);
    }
    return undefined;
}
function sanitizeDiagnosticText(value) {
    if (typeof value !== 'string')
        return undefined;
    return value
        .replace(/postgres(?:ql)?:\/\/\S+/gi, '[REDACTED_URL]')
        .replace(/(?:password|token|secret|authorization|api[_-]?key)\s*[:=]?\s*\S+/gi, '[REDACTED]')
        .replace(/'(?:''|[^'])*'/g, '[REDACTED]')
        .replace(/"(?:[^"\\]|\\.)*"/g, '[REDACTED]')
        .replace(/\b\d+(?:[.,]\d+)?\b/g, '[NUMBER]')
        .replace(/\s+/g, ' ')
        .slice(0, 240);
}
export function logProactivityFailure(stage, error) {
    const details = {
        stage: stage.slice(0, 60),
        tipo: error instanceof Error ? error.name.slice(0, 80) : 'ERRO_DESCONHECIDO',
        codigo: diagnosticCode(error),
    };
    if (process.env.NODE_ENV === 'production') {
        console.error('ai_proactivity_persistencia_falhou', details);
        return;
    }
    const cause = error instanceof Error && 'cause' in error ? error.cause : undefined;
    console.error('ai_proactivity_persistencia_falhou', {
        ...details,
        mensagem: sanitizeDiagnosticText(error instanceof Error ? error.message : error),
        causa: sanitizeDiagnosticText(cause instanceof Error ? cause.message : cause),
    });
}
export class PrismaProactivityRepository {
    constructor(db = prisma) {
        this.db = db;
    }
    async findByKey(userId, key) {
        const record = await this.db.tb_ai_proatividade.findUnique({
            where: { usuario_chave_unique: { usuario_id: userId, ai_proatividade_chave: key } },
            select: proactivitySelect,
        });
        return record ? mapRecord(record) : null;
    }
    async findLatestCreated(userId, since) {
        const record = await this.db.tb_ai_proatividade.findFirst({
            where: {
                usuario_id: userId,
                ai_proatividade_status: 'CRIADA',
                ai_proatividade_data_criacao: { gte: since },
            },
            orderBy: [
                { ai_proatividade_data_criacao: 'desc' },
                { ai_proatividade_id: 'desc' },
            ],
            select: proactivitySelect,
        });
        return record ? mapRecord(record) : null;
    }
    async createIfAbsent(input) {
        let stage = 'transaction.begin';
        try {
            return await this.db.$transaction(async (tx) => {
                // Serializa a janela de proatividade do usuário no banco; não depende
                // de locks locais que desapareceriam em outra instância da API.
                stage = 'advisory_lock';
                // pg_advisory_xact_lock retorna void. $executeRaw executa o lock na
                // mesma transacao sem pedir ao Prisma para desserializar esse tipo.
                await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended(${`proatividade:${input.userId}`}, 0))`;
                // O mesmo lock de usuário usado pelo ConsentimentoService serializa a
                // revogação com a decisão de criar a conversa.
                stage = 'user_lock';
                const userRows = await tx.$queryRaw `
          SELECT usuario_id FROM public.tb_usuario WHERE usuario_id = ${input.userId} FOR UPDATE
        `;
                if (userRows.length !== 1)
                    throw new AppError('Usuário autenticado não encontrado', 404);
                stage = 'consent_check';
                const activeConsents = await tx.tb_consentimento.count({
                    where: {
                        usuario_id: input.userId,
                        consentimento_status: true,
                        tb_consentimento_tipo: {
                            consentimento_tipo_codigo: {
                                in: [CONSENTIMENTO_CODIGOS.IA_PROATIVIDADE, CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO],
                            },
                        },
                    },
                });
                if (activeConsents !== 2)
                    throw new AppError('Consentimento proativo não está ativo', 403);
                stage = 'proactivity_control_insert';
                const inserted = await tx.$queryRaw `
          INSERT INTO public.tb_ai_proatividade (
            usuario_id,
            ai_proatividade_chave,
            ai_proatividade_recomendacao_id,
            ai_proatividade_status,
            ai_proatividade_data_criacao,
            ai_proatividade_data_atualizacao
          )
          VALUES (
            ${input.userId},
            ${input.key},
            ${input.recommendationId},
            'PROCESSANDO',
            ${input.createdAt ?? new Date()},
            ${input.createdAt ?? new Date()}
          )
          ON CONFLICT (usuario_id, ai_proatividade_chave) DO NOTHING
          RETURNING ai_proatividade_id
        `;
                stage = 'proactivity_control_read';
                const control = await tx.tb_ai_proatividade.findUnique({
                    where: { usuario_chave_unique: { usuario_id: input.userId, ai_proatividade_chave: input.key } },
                    select: proactivitySelect,
                });
                if (!control)
                    throw new AppError('Proatividade não pôde ser registrada', 500);
                if (inserted.length === 0)
                    return { created: false, record: mapRecord(control) };
                stage = 'cooldown_check';
                const recent = input.cooldownSince
                    ? await tx.tb_ai_proatividade.findFirst({
                        where: {
                            usuario_id: input.userId,
                            ai_proatividade_status: 'CRIADA',
                            ai_proatividade_data_criacao: { gte: input.cooldownSince },
                        },
                        orderBy: [{ ai_proatividade_data_criacao: 'desc' }, { ai_proatividade_id: 'desc' }],
                        select: proactivitySelect,
                    })
                    : null;
                if (recent) {
                    const suppressed = await tx.tb_ai_proatividade.update({
                        where: { ai_proatividade_id: control.ai_proatividade_id },
                        data: { ai_proatividade_status: 'SUPRIMIDA', ai_proatividade_motivo: 'COOLDOWN_ATIVO', ai_proatividade_data_atualizacao: new Date() },
                        select: proactivitySelect,
                    });
                    return { created: false, record: mapRecord(suppressed) };
                }
                stage = 'recommendation_check';
                const recommendation = await tx.tb_ai_recomendacao.findFirst({
                    where: {
                        usuario_id: input.userId,
                        ai_recomendacao_id: input.recommendationId,
                        ai_recomendacao_chave: input.recommendationKey,
                        ai_recomendacao_status: { not: 'DESCARTADA' },
                        ai_recomendacao_historico_id: null,
                        OR: [
                            { ai_recomendacao_data_expiracao: null },
                            { ai_recomendacao_data_expiracao: { gt: input.createdAt ?? new Date() } },
                        ],
                    },
                    select: { ai_recomendacao_id: true },
                });
                if (!recommendation) {
                    const suppressed = await tx.tb_ai_proatividade.update({
                        where: { ai_proatividade_id: control.ai_proatividade_id },
                        data: { ai_proatividade_status: 'SUPRIMIDA', ai_proatividade_motivo: 'EVENTO_INVALIDO', ai_proatividade_data_atualizacao: new Date() },
                        select: proactivitySelect,
                    });
                    return { created: false, record: mapRecord(suppressed) };
                }
                stage = 'history_create';
                const now = input.createdAt ?? new Date();
                const history = await tx.tb_historico.create({
                    data: {
                        usuario_id: input.userId,
                        historico_nome: input.title.slice(0, 45),
                        historico_origem: 'PROATIVO',
                        historico_data_criacao: now,
                        historico_data_modificacao: now,
                    },
                    select: { historico_id: true },
                });
                stage = 'message_create';
                await tx.tb_mensagem.create({
                    data: {
                        historico_id: history.historico_id,
                        mensagem_remetente: true,
                        mensagem_texto: input.message,
                        mensagem_imagem: null,
                        mensagem_possui_imagem: false,
                        mensagem_texto_modificado: input.message,
                        mensagem_data_criacao: now,
                        mensagem_data_modificacao: now,
                    },
                    select: { mensagem_id: true },
                });
                stage = 'recommendation_link';
                const linked = await tx.tb_ai_recomendacao.updateMany({
                    where: {
                        usuario_id: input.userId,
                        ai_recomendacao_id: input.recommendationId,
                        ai_recomendacao_chave: input.recommendationKey,
                        ai_recomendacao_historico_id: null,
                    },
                    data: { ai_recomendacao_historico_id: history.historico_id },
                });
                if (linked.count !== 1) {
                    await tx.tb_mensagem.deleteMany({ where: { historico_id: history.historico_id } });
                    await tx.tb_historico.delete({ where: { historico_id: history.historico_id } });
                    const suppressed = await tx.tb_ai_proatividade.update({
                        where: { ai_proatividade_id: control.ai_proatividade_id },
                        data: { ai_proatividade_status: 'SUPRIMIDA', ai_proatividade_motivo: 'EVENTO_DUPLICADO', ai_proatividade_data_atualizacao: new Date() },
                        select: proactivitySelect,
                    });
                    return { created: false, record: mapRecord(suppressed) };
                }
                stage = 'notification_create';
                const notification = await NotificationService.createNotification({
                    userId: input.userId,
                    type: 'PROATIVA',
                    title: 'Nova mensagem da Plenna',
                    message: 'Você tem uma nova mensagem da Plenna.',
                    idempotencyKey: `proatividade:${input.userId}:${input.key}`,
                    event: 'PROATIVA',
                    historyId: history.historico_id,
                }, tx);
                stage = 'proactivity_control_complete';
                const completed = await tx.tb_ai_proatividade.update({
                    where: { ai_proatividade_id: control.ai_proatividade_id },
                    data: {
                        ai_proatividade_status: 'CRIADA',
                        ai_proatividade_historico_id: history.historico_id,
                        ai_proatividade_notificacao_id: notification.notification.notificacao_id,
                        ai_proatividade_data_atualizacao: new Date(),
                    },
                    select: proactivitySelect,
                });
                return { created: true, record: mapRecord(completed) };
            });
        }
        catch (error) {
            if (isUniqueError(error)) {
                const existing = await this.findByKey(input.userId, input.key);
                if (existing)
                    return { created: false, record: existing };
            }
            if (error instanceof AppError)
                throw error;
            logProactivityFailure(stage, error);
            throw new AppError('Não foi possível criar a conversa proativa', 500);
        }
    }
}
