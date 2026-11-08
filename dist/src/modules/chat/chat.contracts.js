import { prisma } from '../../lib/prisma.js';
export const DEFAULT_HISTORY_NAME = 'Nova conversa';
/**
 * Convencao unica persistida no Boolean legado mensagem_remetente.
 * O system prompt nunca e persistido em tb_mensagem.
 */
export const MESSAGE_SENDER = Object.freeze({
    USER: false,
    ASSISTANT: true,
});
export const defaultChatDatabase = prisma;
