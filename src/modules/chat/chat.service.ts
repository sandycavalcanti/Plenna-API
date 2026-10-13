import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { env } from '../../lib/env.js';
import { createAIProvider } from '../email/ai-provider.factory.js';
import { AIProviderError, type AIProvider } from '../email/ai-provider.js';
import { CodexLocalError } from '../email/codex-local.provider.js';
import { MESSAGE_SENDER, DEFAULT_HISTORY_NAME, type ChatDatabase, type PublicHistoryWithMessages } from './chat.contracts.js';
import { buildChatContext } from './chat.context.js';
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
    throw new AppError('Usuario autenticado invalido', 401);
  }
}

function parseHistoryId(historyId: number | string) {
  return historyIdSchema.parse(historyId);
}

function parseMessageInput(input: CreateMessageDTO) {
  const parsedInput = createMessageSchema.parse(input);
  if (parsedInput.texto.length > env.chatMaxMessageChars) {
    throw new AppError('Mensagem excede o limite configurado', 400);
  }
  return parsedInput;
}

function deriveHistoryName(text: string) {
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, 45).join('');
}

function providerFailure(error: unknown) {
  if (error instanceof AppError) return error;

  if (error instanceof AIProviderError) {
    return new AppError(
      error.code === 'timeout' ? 'Tempo limite ao consultar a IA' : 'Falha ao consultar a IA',
      error.code === 'timeout' ? 504 : 502,
    );
  }

  if (error instanceof CodexLocalError) {
    return new AppError(
      error.code === 'timeout' ? 'Tempo limite ao consultar a IA local' : 'Falha ao consultar a IA local',
      error.code === 'timeout' ? 504 : 502,
    );
  }

  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : undefined;
  if (record?.code === 'ECONNABORTED' || record?.code === 'ETIMEDOUT') {
    return new AppError('Tempo limite ao consultar a IA', 504);
  }

  return new AppError('Falha ao consultar a IA', 502);
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
      throw new AppError('Historico nao encontrado', 404);
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

  /** Persiste a mensagem do usuario em uma transacao curta, sem chamar IA. */
  static async createUserMessage(
    userId: number,
    historyId: number | string,
    input: CreateMessageDTO,
    db: ChatDatabase = prisma,
  ) {
    assertUserId(userId);
    const parsedHistoryId = parseHistoryId(historyId);
    const parsedInput = parseMessageInput(input);
    const now = new Date();

    return db.$transaction(async (tx) => {
      const history = await findOwnedHistory(tx, userId, parsedHistoryId);
      if (!history) {
        throw new AppError('Historico nao encontrado', 404);
      }

      const firstUserMessage = await tx.tb_mensagem.findFirst({
        where: {
          historico_id: parsedHistoryId,
          mensagem_remetente: MESSAGE_SENDER.USER,
        },
        select: { mensagem_id: true },
        orderBy: [
          { mensagem_data_criacao: 'asc' },
          { mensagem_id: 'asc' },
        ],
      });

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
        data: {
          historico_data_modificacao: now,
          ...(history.historico_nome === DEFAULT_HISTORY_NAME && !firstUserMessage
            ? { historico_nome: deriveHistoryName(parsedInput.texto) }
            : {}),
        },
      });

      return serializeMessage(message);
    });
  }

  /** Persiste uma resposta da IA em uma transacao curta, sem provider aberto. */
  static async createAssistantMessage(
    userId: number,
    historyId: number | string,
    text: string,
    db: ChatDatabase = prisma,
  ) {
    assertUserId(userId);
    const parsedHistoryId = parseHistoryId(historyId);
    const normalizedText = text.trim();
    if (!normalizedText) {
      throw new AppError('A IA retornou uma resposta vazia', 502);
    }
    if (normalizedText.length > env.chatMaxMessageChars) {
      throw new AppError('A IA retornou uma resposta acima do limite', 502);
    }
    const now = new Date();

    return db.$transaction(async (tx) => {
      const history = await findOwnedHistory(tx, userId, parsedHistoryId);
      if (!history) {
        throw new AppError('Historico nao encontrado', 404);
      }

      const message = await tx.tb_mensagem.create({
        data: {
          historico_id: parsedHistoryId,
          mensagem_remetente: MESSAGE_SENDER.ASSISTANT,
          mensagem_texto: normalizedText,
          mensagem_imagem: null,
          mensagem_possui_imagem: false,
          mensagem_texto_modificado: normalizedText,
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

  static async sendMessage(
    userId: number,
    historyId: number | string,
    input: CreateMessageDTO,
    db: ChatDatabase = prisma,
    providerFactory: () => AIProvider | null = createAIProvider,
  ) {
    assertUserId(userId);
    const parsedHistoryId = parseHistoryId(historyId);
    const parsedInput = parseMessageInput(input);

    // Verifica ownership antes da primeira escrita e valida o minimo de contexto.
    const before = await this.getHistory(userId, parsedHistoryId, db);
    const provisionalMessage = {
      mensagem_id: -1,
      historico_id: parsedHistoryId,
      remetente: 'user' as const,
      texto: parsedInput.texto,
      mensagem_data_criacao: new Date(),
    };
    buildChatContext(before.mensagens, provisionalMessage);

    // A transacao termina antes da chamada externa ao provider.
    const userMessage = await this.createUserMessage(userId, parsedHistoryId, parsedInput, db);
    const after = await this.getHistory(userId, parsedHistoryId, db);
    const persistedCurrent = after.mensagens.find((message) => message.mensagem_id === userMessage.mensagem_id);
    if (!persistedCurrent) {
      throw new AppError('Mensagem do usuario nao foi recuperada apos persistencia', 500);
    }

    let provider: AIProvider | null;
    try {
      provider = providerFactory();
    } catch (error) {
      throw providerFailure(error);
    }
    if (!provider || typeof provider.chat !== 'function') {
      throw new AppError('Provider conversacional indisponivel', 502);
    }

    const context = buildChatContext(after.mensagens, persistedCurrent);
    let assistantText: string;
    try {
      assistantText = await provider.chat(context);
    } catch (error) {
      throw providerFailure(error);
    }

    if (typeof assistantText !== 'string' || !assistantText.trim()) {
      throw new AppError('A IA retornou uma resposta vazia', 502);
    }

    const assistantMessage = await this.createAssistantMessage(
      userId,
      parsedHistoryId,
      assistantText,
      db,
    );

    return {
      mensagemUsuario: userMessage,
      mensagemIA: assistantMessage,
    };
  }
}
