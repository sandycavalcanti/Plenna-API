import { Prisma } from '@prisma/client';
import type { notificacao_tipo_enum } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';

const notificationSelect = {
  notificacao_id: true,
  notificacao_tipo: true,
  notificacao_titulo: true,
  notificacao_mensagem: true,
  compra_id: true,
  categoria_id: true,
  notificacao_evento: true,
  notificacao_lida: true,
  notificacao_lida_em: true,
  notificacao_data_criacao: true,
} as const;

export type CreateNotificationInput = {
  userId: number;
  type: notificacao_tipo_enum;
  title: string;
  message: string;
  idempotencyKey: string;
  purchaseId?: number | null;
  categoryId?: number | null;
  event?: string | null;
};

function isExpectedIdempotencyConflict(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const target = error.meta?.target;
  const targetText = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return targetText.includes('notificacao_chave_idempotencia');
}

export class NotificationService {
  static async listByUserId(userId: number) {
    return prisma.tb_notificacao.findMany({
      where: { usuario_id: userId },
      orderBy: [
        { notificacao_data_criacao: 'desc' },
        { notificacao_id: 'desc' },
      ],
      select: notificationSelect,
    });
  }

  static async countUnread(userId: number) {
    return prisma.tb_notificacao.count({
      where: {
        usuario_id: userId,
        notificacao_lida: 0,
      },
    });
  }

  static async markAsRead(userId: number, notificationId: number) {
    const existing = await prisma.tb_notificacao.findFirst({
      where: {
        notificacao_id: notificationId,
        usuario_id: userId,
      },
      select: notificationSelect,
    });

    if (!existing) {
      throw new AppError('Notificação não encontrada', 404);
    }

    if (existing.notificacao_lida !== 0) {
      return existing;
    }

    await prisma.tb_notificacao.updateMany({
      where: {
        notificacao_id: notificationId,
        usuario_id: userId,
        notificacao_lida: 0,
      },
      data: {
        notificacao_lida: 1,
        notificacao_lida_em: new Date(),
      },
    });

    return prisma.tb_notificacao.findFirst({
      where: {
        notificacao_id: notificationId,
        usuario_id: userId,
      },
      select: notificationSelect,
    });
  }

  static async createNotification(input: CreateNotificationInput) {
    const existing = await prisma.tb_notificacao.findUnique({
      where: { notificacao_chave_idempotencia: input.idempotencyKey },
      select: notificationSelect,
    });

    if (existing) {
      return { notification: existing, created: false };
    }

    try {
      const notification = await prisma.tb_notificacao.create({
        data: {
          usuario_id: input.userId,
          notificacao_tipo: input.type,
          notificacao_titulo: input.title,
          notificacao_mensagem: input.message,
          notificacao_chave_idempotencia: input.idempotencyKey,
          compra_id: input.purchaseId ?? null,
          categoria_id: input.categoryId ?? null,
          notificacao_evento: input.event ?? null,
        },
        select: notificationSelect,
      });

      return { notification, created: true };
    } catch (error) {
      if (!isExpectedIdempotencyConflict(error)) {
        throw error;
      }

      const concurrent = await prisma.tb_notificacao.findUnique({
        where: { notificacao_chave_idempotencia: input.idempotencyKey },
        select: notificationSelect,
      });

      if (!concurrent) {
        throw error;
      }

      return { notification: concurrent, created: false };
    }
  }
}
