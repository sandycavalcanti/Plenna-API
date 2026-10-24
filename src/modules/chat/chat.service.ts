import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { env } from '../../lib/env.js';
import { createAIProvider } from '../email/ai-provider.factory.js';
import { AIProviderError, type AIProvider } from '../email/ai-provider.js';
import { CodexLocalError } from '../email/codex-local.provider.js';
import { AIOrchestrationError } from '../ai/ai.errors.js';
import { AIOrchestrator } from '../ai/ai.orchestrator.js';
import { aiToolRegistry } from '../ai/ai.registry.js';
import '../ai/memory.runtime.js';
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

function sanitizeGeneratedHistoryName(value: unknown) {
  if (typeof value !== 'string') return '';

  const normalized = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*(?:titulo|título|title)\s*:\s*/i, '')
    .replace(/["'“”‘’*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .trim();
  return [...normalized].slice(0, 45).join('');
}

function providerFailure(error: unknown) {
  if (error instanceof AppError) return error;

  if (error instanceof AIOrchestrationError) {
    return new AppError(error.message, error.code === 'AI_TOOL_TIMEOUT' ? 504 : 502);
  }

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

/**
 * A intenção de escrita é derivada somente da mensagem autenticada do usuário.
 * Perguntas de recuperação de memória e frases ambíguas permanecem somente leitura.
 */
export function hasExplicitMemoryWriteIntent(text: string) {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();

  if (!normalized) return false;

  const isRecallQuestion = /\?/.test(normalized) && (
    /\b(?:voce|vc)\s+(?:se\s+)?(?:lembra|recorda)\b/.test(normalized)
    || /\b(?:o que|qual|quais)\b[^?]{0,80}\b(?:lembra|recorda)\b/.test(normalized)
    || /\b(?:voce|vc)\s+(?:pode|poderia|consegue)\s+me\s+(?:lembrar|recordar)\b/.test(normalized)
  );
  if (isRecallQuestion) return false;

  if (/\b(?:nao|nunca|jamais)\s+(?:precisa\s+)?(?:salvar|guardar|registrar|anotar|memorizar|lembrar)\b/.test(normalized)) {
    return false;
  }

  const directWrite = /^(?:por favor\s*,?\s*)?(?:registre|anote|salve|guarde|memorize|atualize|corrija|adicione|remova|esqueca)\b/.test(normalized);
  const directRemember = /^(?:por favor\s*,?\s*)?lembre-se\b[\s\S]{0,120}\b(?:que|isso|isto|minha memoria|na memoria)\b/.test(normalized);
  const requestedWrite = /\b(?:quero|gostaria|preciso)\s+que\s+(?:voce\s+)?(?:registre|anote|salve|guarde|memorize|lembre(?:-se)?|atualize|corrija|adicione|remova|esqueca)\b/.test(normalized);
  const politeWrite = /\b(?:voce|vc)\s+(?:pode|poderia)\s+(?:por favor\s+)?(?:salvar|guardar|registrar|anotar|memorizar|atualizar|corrigir|adicionar|remover|esquecer)\b[^?]{0,120}(?:\bque\b|\b(?:na|em)\s+(?:minha\s+)?memoria\b|\b(?:minha|esta)\s+memoria\b)/.test(normalized);

  return directWrite || directRemember || requestedWrite || politeWrite;
}

export class ChatFirstMessageError extends AppError {
  constructor(
    public readonly historyId: number,
    error: AppError,
  ) {
    super(error.message, error.statusCode);
  }
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

const titleGenerationInFlight = new Map<number, Promise<void>>();

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

  /** Cria historico e primeira mensagem na mesma transacao curta. */
  static async createHistoryWithUserMessage(
    userId: number,
    input: CreateMessageDTO,
    db: ChatDatabase = prisma,
  ) {
    assertUserId(userId);
    const parsedInput = parseMessageInput(input);
    const now = new Date();
    const fallbackName = deriveHistoryName(parsedInput.texto);

    return db.$transaction(async (tx) => {
      const history = await tx.tb_historico.create({
        data: {
          usuario_id: userId,
          historico_nome: fallbackName,
          historico_data_criacao: now,
          historico_data_modificacao: now,
        },
        select: historySelect,
      });

      const message = await tx.tb_mensagem.create({
        data: {
          historico_id: history.historico_id,
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

      return {
        historico: serializeHistory(history),
        mensagemUsuario: serializeMessage(message),
      };
    });
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

  /**
   * Remove um historico e suas mensagens de forma atomica.
   *
   * A relacao Prisma usa NoAction, portanto os filhos precisam ser removidos
   * antes do pai dentro da mesma transacao. A busca combina o ID do recurso
   * com o usuario autenticado para tratar recursos de terceiros como 404.
   */
  static async deleteHistory(userId: number, historyId: number | string, db: ChatDatabase = prisma) {
    assertUserId(userId);
    const parsedHistoryId = parseHistoryId(historyId);

    await db.$transaction(async (tx) => {
      const history = await findOwnedHistory(tx, userId, parsedHistoryId);
      if (!history) {
        throw new AppError('Historico nao encontrado', 404);
      }

      await tx.tb_mensagem.deleteMany({
        where: { historico_id: parsedHistoryId },
      });

      await tx.tb_historico.delete({
        where: { historico_id: parsedHistoryId },
      });
    });
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

  static async generateHistoryTitle(
    userId: number,
    historyId: number,
    firstMessage: string,
    fallbackName: string,
    provider: AIProvider,
    db: ChatDatabase = prisma,
  ) {
    if (typeof provider.generateTitle !== 'function') return;

    const existingGeneration = titleGenerationInFlight.get(historyId);
    if (existingGeneration) {
      await existingGeneration;
      return;
    }

    const generation = (async () => {
      let generatedName = '';
      try {
        generatedName = sanitizeGeneratedHistoryName(await provider.generateTitle!(firstMessage));
      } catch {
        // O fallback deterministico ja foi persistido; o erro de titulo nao interrompe o chat.
        return;
      }

      const nextName = generatedName || fallbackName;
      if (nextName === fallbackName) return;

      try {
        await db.tb_historico.updateMany({
          where: {
            historico_id: historyId,
            usuario_id: userId,
            historico_nome: fallbackName,
          },
          data: { historico_nome: nextName },
        });
      } catch {
        // Falha de titulo nao converte uma conversa ja respondida em erro geral.
      }
    })();

    titleGenerationInFlight.set(historyId, generation);
    try {
      await generation;
    } finally {
      if (titleGenerationInFlight.get(historyId) === generation) titleGenerationInFlight.delete(historyId);
    }
  }

  static async completeMessage(
    userId: number,
    historyId: number,
    userMessage: ReturnType<typeof serializeMessage>,
    firstMessage: string,
    shouldGenerateTitle: boolean,
    db: ChatDatabase,
    providerFactory: () => AIProvider | null,
  ) {
    const after = await this.getHistory(userId, historyId, db);
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
      const orchestration = await new AIOrchestrator(aiToolRegistry).run(
        provider,
        context,
        {
          usuario_id: userId,
          memory_write_intent: hasExplicitMemoryWriteIntent(persistedCurrent.texto),
        },
      );
      assistantText = orchestration.text;
    } catch (error) {
      throw providerFailure(error);
    }

    if (typeof assistantText !== 'string' || !assistantText.trim()) {
      throw new AppError('A IA retornou uma resposta vazia', 502);
    }

    const assistantMessage = await this.createAssistantMessage(
      userId,
      historyId,
      assistantText,
      db,
    );

    if (shouldGenerateTitle) {
      await this.generateHistoryTitle(
        userId,
        historyId,
        firstMessage,
        deriveHistoryName(firstMessage),
        provider,
        db,
      );
    }

    const finalHistory = await this.getHistory(userId, historyId, db);
    return {
      historico: finalHistory.historico,
      mensagemUsuario: userMessage,
      mensagemIA: assistantMessage,
    };
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
    return this.completeMessage(
      userId,
      parsedHistoryId,
      userMessage,
      parsedInput.texto,
      before.historico.historico_nome === DEFAULT_HISTORY_NAME && !before.mensagens.some((message) => message.remetente === 'user'),
      db,
      providerFactory,
    );
  }

  static async sendFirstMessage(
    userId: number,
    input: CreateMessageDTO,
    db: ChatDatabase = prisma,
    providerFactory: () => AIProvider | null = createAIProvider,
  ) {
    assertUserId(userId);
    const parsedInput = parseMessageInput(input);
    const provisionalMessage = {
      mensagem_id: -1,
      historico_id: -1,
      remetente: 'user' as const,
      texto: parsedInput.texto,
      mensagem_data_criacao: new Date(),
    };
    buildChatContext([], provisionalMessage);

    const created = await this.createHistoryWithUserMessage(userId, parsedInput, db);
    try {
      return await this.completeMessage(
        userId,
        created.historico.historico_id,
        created.mensagemUsuario,
        parsedInput.texto,
        true,
        db,
        providerFactory,
      );
    } catch (error) {
      const normalized = error instanceof AppError
        ? error
        : new AppError('Falha ao persistir a primeira mensagem', 500);
      throw new ChatFirstMessageError(created.historico.historico_id, normalized);
    }
  }
}
