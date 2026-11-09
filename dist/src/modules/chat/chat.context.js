import { AppError } from '../../errors/AppError.js';
import { env } from '../../lib/env.js';
import { buildPlennaSystemPrompt } from './chat.prompt.js';
function toAIMessage(message) {
    return {
        role: message.remetente,
        content: message.texto,
    };
}
function compareMessages(left, right) {
    const byDate = left.mensagem_data_criacao.getTime() - right.mensagem_data_criacao.getTime();
    return byDate || left.mensagem_id - right.mensagem_id;
}
function messageCost(message) {
    return message.role.length + 1 + message.content.length;
}
function contextCost(messages) {
    return messages.reduce((total, message) => total + messageCost(message), 0);
}
function failIfRequiredMessagesDoNotFit(messages, maxChars) {
    if (contextCost(messages) > maxChars) {
        throw new AppError('A mensagem excede o limite de contexto configurado', 400);
    }
}
export function getDefaultChatContextLimits() {
    return {
        maxMessages: env.chatContextMaxMessages,
        maxChars: env.chatContextMaxChars,
    };
}
/**
 * Monta o prompt apenas com a conversa selecionada. O system prompt nunca e
 * persistido e a mensagem atual e normalizada por id para aparecer uma unica vez.
 */
export function buildChatContext(historyMessages, currentMessage, limits = getDefaultChatContextLimits(), now = new Date()) {
    const messagesById = new Map();
    for (const message of historyMessages) {
        messagesById.set(message.mensagem_id, message);
    }
    messagesById.set(currentMessage.mensagem_id, currentMessage);
    const ordered = [...messagesById.values()].sort(compareMessages);
    const systemPrompt = buildPlennaSystemPrompt(now);
    const required = [
        { role: 'system', content: systemPrompt },
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
    const systemMessage = { role: 'system', content: systemPrompt };
    while (contextCost([systemMessage, ...selected.map(toAIMessage)]) > limits.maxChars) {
        const removableIndex = selected.findIndex((message) => message.mensagem_id !== currentMessage.mensagem_id);
        if (removableIndex < 0)
            break;
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
