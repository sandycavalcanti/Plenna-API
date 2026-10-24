import { Prisma, PrismaClient, type notificacao_tipo_enum } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { NotificationService } from '../notification/notification.service.js';
import { CONSENTIMENTO_CODIGOS } from '../consentimento/consentimento.constants.js';

export type ProactivityStored = {
  id: number;
  userId: number;
  key: string;
  recommendationId: number;
  historyId: number | null;
  notificationId: number | null;
  status: string;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProactivityPersistInput = {
  userId: number;
  key: string;
  recommendationId: number;
  recommendationKey: string;
  title: string;
  message: string;
  createdAt?: Date;
  cooldownSince?: Date;
};

export type ProactivityRepository = {
  findByKey(userId: number, key: string): Promise<ProactivityStored | null>;
  findLatestCreated(userId: number, since: Date): Promise<ProactivityStored | null>;
  createIfAbsent(input: ProactivityPersistInput): Promise<{ created: boolean; record: ProactivityStored }>;
};

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
} as const;

function mapRecord(record: {
  ai_proatividade_id: number;
  usuario_id: number;
  ai_proatividade_chave: string;
  ai_proatividade_recomendacao_id: number;
  ai_proatividade_historico_id: number | null;
  ai_proatividade_notificacao_id: number | null;
  ai_proatividade_status: string;
  ai_proatividade_motivo: string | null;
  ai_proatividade_data_criacao: Date;
  ai_proatividade_data_atualizacao: Date;
}): ProactivityStored {
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

type ProactivityDatabase = Pick<PrismaClient, 'tb_ai_proatividade' | '$transaction'>;

function isUniqueError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class PrismaProactivityRepository implements ProactivityRepository {
  private readonly db: ProactivityDatabase;

  constructor(db: ProactivityDatabase = prisma) {
    this.db = db;
  }

  async findByKey(userId: number, key: string) {
    const record = await this.db.tb_ai_proatividade.findUnique({
      where: { usuario_chave_unique: { usuario_id: userId, ai_proatividade_chave: key } },
      select: proactivitySelect,
    });
    return record ? mapRecord(record) : null;
  }

  async findLatestCreated(userId: number, since: Date) {
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

  async createIfAbsent(input: ProactivityPersistInput) {
    try {
      return await this.db.$transaction(async (tx) => {
        // Serializa a janela de proatividade do usuário no banco; não depende
        // de locks locais que desapareceriam em outra instância da API.
        await tx.$queryRaw<Array<{ locked: null }>>`SELECT pg_advisory_xact_lock(hashtextextended(${`proatividade:${input.userId}`}, 0)) AS locked`;
        // O mesmo lock de usuário usado pelo ConsentimentoService serializa a
        // revogação com a decisão de criar a conversa.
        const userRows = await tx.$queryRaw<Array<{ usuario_id: number }>>`
          SELECT usuario_id FROM public.tb_usuario WHERE usuario_id = ${input.userId} FOR UPDATE
        `;
        if (userRows.length !== 1) throw new AppError('Usuário autenticado não encontrado', 404);

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
        if (activeConsents !== 2) throw new AppError('Consentimento proativo não está ativo', 403);

        const inserted = await tx.$queryRaw<Array<{ ai_proatividade_id: number }>>`
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

        const control = await tx.tb_ai_proatividade.findUnique({
          where: { usuario_chave_unique: { usuario_id: input.userId, ai_proatividade_chave: input.key } },
          select: proactivitySelect,
        });
        if (!control) throw new AppError('Proatividade não pôde ser registrada', 500);
        if (inserted.length === 0) return { created: false, record: mapRecord(control) };

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

        const notification = await NotificationService.createNotification({
          userId: input.userId,
          type: 'PROATIVA' as notificacao_tipo_enum,
          title: 'Nova mensagem da Plenna',
          message: 'Você tem uma nova mensagem da Plenna.',
          idempotencyKey: `proatividade:${input.userId}:${input.key}`,
          event: 'PROATIVA',
          historyId: history.historico_id,
        }, tx);

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
    } catch (error) {
      if (isUniqueError(error)) {
        const existing = await this.findByKey(input.userId, input.key);
        if (existing) return { created: false, record: existing };
      }
      if (error instanceof AppError) throw error;
      throw new AppError('Não foi possível criar a conversa proativa', 500);
    }
  }
}

