import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { MESSAGE_SENDER, DEFAULT_HISTORY_NAME, type ChatDatabase, type PublicHistoryWithMessages } from './chat.contracts.js';
import { createMessageSchema, historyIdSchema, type CreateMessageDTO } from './chat.schemas.js';
import { serializeHistory, serializeMessage } from './chat.serializers.js';

const historySelect = {
  historico_id: true,
  historico_nome: true,
  historico_data_criacao: true,
  historico_data_modificacao: true,
} as const;

const messageSelect = {
  mensagem_id: true,
  historico_id: true,
  mensagem_remetente: true,
  mensagem_texto: true,
  mensagem_data_criacao: true,
} as const;

function assertUserId(userId: number) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppError('Usuário autenticado inválido', 401);
  }
}

function parseHistoryId(historyId: number | string) {
  return historyIdSchema.parse(historyId);
}

async function findOwnedHistory(db: Pick<ChatDatabase, 'tb_historico'>, userId: number, historyId: number) {
  return db.tb_historico.findFirst({
    where: {
      historico_id: historyId,
      usuario_id: userId,
    },
    select: historySelect,
  });
}

export class ChatService {
  static async createHistory(userId: number, db: ChatDatabase = prisma) {
    assertUserId(userId);
    const now = new Date();

    const history = await db.tb_historico.create({
      data: {
        usuario_id: userId,
        historico_nome: DEFAULT_HISTORY_NAME,
        historico_data_criacao: now,
        historico_data_modificacao: now,
      },
      select: historySelect,
    });

    return serializeHistory(history);
  }

  static async listHistories(userId: number, db: ChatDatabase = prisma) {
    assertUserId(userId);

    const histories = await db.tb_historico.findMany({
      where: { usuario_id: userId },
      orderBy: [
        { historico_data_modificacao: 'desc' },
        { historico_id: 'desc' },
      ],
      select: historySelect,
    });

    return histories.map(serializeHistory);
  }

  static async getHistory(userId: number, historyId: number | string, db: ChatDatabase = prisma): Promise<PublicHistoryWithMessages> {
    assertUserId(userId);
    const parsedHistoryId = parseHistoryId(historyId);
    const history = await findOwnedHistory(db, userId, parsedHistoryId);

    if (!history) {
      throw new AppError('Histórico não encontrado', 404);
    }

    const messages = await db.tb_mensagem.findMany({
      where: { historico_id: parsedHistoryId },
      orderBy: [
        { mensagem_data_criacao: 'asc' },
        { mensagem_id: 'asc' },
      ],
      select: messageSelect,
    });

    return {
      historico: serializeHistory(history),
      mensagens: messages.map(serializeMessage),
    };
  }

  /**
   * Persiste uma mensagem textual do usuario para ser reutilizada pela Phase 2.
   * Este helper nao e registrado em rota nesta fase e nao chama provider algum.
   */
  static async createUserMessage(
    userId: number,
    historyId: number | string,
    input: CreateMessageDTO,
    db: ChatDatabase = prisma,
  ) {
    assertUserId(userId);
    const parsedHistoryId = parseHistoryId(historyId);
    const parsedInput = createMessageSchema.parse(input);
    const now = new Date();

    return db.$transaction(async (tx) => {
      const history = await findOwnedHistory(tx, userId, parsedHistoryId);
      if (!history) {
        throw new AppError('Histórico não encontrado', 404);
      }

      const message = await tx.tb_mensagem.create({
        data: {
          historico_id: parsedHistoryId,
          mensagem_remetente: MESSAGE_SENDER.USER,
          mensagem_texto: parsedInput.texto,
          mensagem_imagem: null,
          mensagem_possui_imagem: false,
          mensagem_texto_modificado: parsedInput.texto,
          mensagem_data_criacao: now,
          mensagem_data_modificacao: now,
        },
        select: messageSelect,
      });

      await tx.tb_historico.update({
        where: { historico_id: parsedHistoryId },
        data: { historico_data_modificacao: now },
      });

      return serializeMessage(message);
    });
  }
}
