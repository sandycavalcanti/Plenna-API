import { AppError } from '../../errors/AppError.js';
import type { AIMessage } from '../email/ai-provider.js';
import { env } from '../../lib/env.js';
import { PLENNA_CHAT_SYSTEM_PROMPT } from './chat.prompt.js';
import type { PublicMessage } from './chat.contracts.js';

export type ChatContextLimits = {
  maxMessages: number;
  maxChars: number;
};

type ContextMessage = PublicMessage;

function toAIMessage(message: ContextMessage): AIMessage {
  return {
    role: message.remetente,
    content: message.texto,
  };
}

function compareMessages(left: ContextMessage, right: ContextMessage) {
  const byDate = left.mensagem_data_criacao.getTime() - right.mensagem_data_criacao.getTime();
  return byDate || left.mensagem_id - right.mensagem_id;
}

function messageCost(message: AIMessage) {
  return message.role.length + 1 + message.content.length;
}

function contextCost(messages: AIMessage[]) {
  return messages.reduce((total, message) => total + messageCost(message), 0);
}

function failIfRequiredMessagesDoNotFit(messages: AIMessage[], maxChars: number) {
  if (contextCost(messages) > maxChars) {
    throw new AppError('A mensagem excede o limite de contexto configurado', 400);
  }
}

export function getDefaultChatContextLimits(): ChatContextLimits {
  return {
    maxMessages: env.chatContextMaxMessages,
    maxChars: env.chatContextMaxChars,
  };
}

/**
 * Monta o prompt apenas com a conversa selecionada. O system prompt nunca e
 * persistido e a mensagem atual e normalizada por id para aparecer uma unica vez.
 */
export function buildChatContext(
  historyMessages: ContextMessage[],
  currentMessage: ContextMessage,
  limits: ChatContextLimits = getDefaultChatContextLimits(),
): AIMessage[] {
  const messagesById = new Map<number, ContextMessage>();
  for (const message of historyMessages) {
    messagesById.set(message.mensagem_id, message);
  }
  messagesById.set(currentMessage.mensagem_id, currentMessage);

  const ordered = [...messagesById.values()].sort(compareMessages);
  const required = [
    { role: 'system' as const, content: PLENNA_CHAT_SYSTEM_PROMPT },
    toAIMessage(currentMessage),
  ];
  failIfRequiredMessagesDoNotFit(required, limits.maxChars);

  let selected = ordered.slice(-Math.max(1, limits.maxMessages));
  if (!selected.some((message) => message.mensagem_id === currentMessage.mensagem_id)) {
    selected = [
      ...selected.slice(1),
      currentMessage,
    ].sort(compareMessages);
  }

  const systemMessage = { role: 'system' as const, content: PLENNA_CHAT_SYSTEM_PROMPT };
  while (contextCost([systemMessage, ...selected.map(toAIMessage)]) > limits.maxChars) {
    const removableIndex = selected.findIndex((message) => message.mensagem_id !== currentMessage.mensagem_id);
    if (removableIndex < 0) break;
    selected.splice(removableIndex, 1);
  }

  const result = [
    systemMessage,
    ...selected.map(toAIMessage),
  ];

  if (selected.filter((message) => message.mensagem_id === currentMessage.mensagem_id).length !== 1 || contextCost(result) > limits.maxChars) {
    throw new AppError('Nao foi possivel montar o contexto dentro dos limites configurados', 400);
  }

  return result;
}
