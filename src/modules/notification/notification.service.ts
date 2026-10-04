import { Prisma } from '@prisma/client';
import type { notificacao_tipo_enum } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';

type NotificationDatabase = Pick<Prisma.TransactionClient, 'tb_notificacao' | '$queryRaw'>;

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

const notificationSelectWithOwner = {
  ...notificationSelect,
  usuario_id: true,
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

function stripOwner<T extends { usuario_id: number }>(notification: T) {
  const { usuario_id: _usuarioId, ...publicNotification } = notification;
  return publicNotification;
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

  static async createNotification(input: CreateNotificationInput, db: NotificationDatabase = prisma) {
    // O alvo explícito da cláusula ON CONFLICT evita abortar a transaction
    // quando dois fluxos tentam persistir a mesma chave simultaneamente.
    // Assim, a consulta posterior continua segura no mesmo TransactionClient.
    const inserted = await db.$queryRaw<Array<{ notificacao_id: number }>>`
      INSERT INTO public.tb_notificacao (
        usuario_id,
        notificacao_tipo,
        notificacao_titulo,
        notificacao_mensagem,
        notificacao_chave_idempotencia,
        compra_id,
        categoria_id,
        notificacao_evento
      )
      VALUES (
        ${input.userId},
        ${input.type}::public.notificacao_tipo_enum,
        ${input.title},
        ${input.message},
        ${input.idempotencyKey},
        ${input.purchaseId ?? null},
        ${input.categoryId ?? null},
        ${input.event ?? null}
      )
      ON CONFLICT (notificacao_chave_idempotencia) DO NOTHING
      RETURNING notificacao_id
    `;

    const stored = await db.tb_notificacao.findUnique({
      where: { notificacao_chave_idempotencia: input.idempotencyKey },
      select: notificationSelectWithOwner,
    });

    if (!stored) {
      throw new AppError('Notificação não pôde ser persistida', 500);
    }

    if (stored.usuario_id !== input.userId) {
      throw new AppError('Chave de idempotência já pertence a outro usuário', 409);
    }

    return {
      notification: stripOwner(stored),
      created: inserted.length > 0,
    };
  }
}
