import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export const DEFAULT_HISTORY_NAME = 'Nova conversa';

/**
 * Convencao unica persistida no Boolean legado mensagem_remetente.
 * O system prompt nunca e persistido em tb_mensagem.
 */
export const MESSAGE_SENDER = Object.freeze({
  USER: false,
  ASSISTANT: true,
} as const);

export type PublicMessageSender = 'user' | 'assistant';

export type PublicHistory = {
  historico_id: number;
  historico_nome: string;
  historico_data_criacao: Date;
  historico_data_modificacao: Date;
  historico_origem: 'MANUAL' | 'PROATIVO';
};

export type PublicMessage = {
  mensagem_id: number;
  historico_id: number;
  remetente: PublicMessageSender;
  texto: string;
  mensagem_data_criacao: Date;
};

export type PublicHistoryWithMessages = {
  historico: PublicHistory;
  mensagens: PublicMessage[];
};

/**
 * Permite testar o service com um client Prisma fake sem acoplar os testes a
 * uma base de dados real.
 */
export type ChatDatabase = Pick<PrismaClient, 'tb_historico' | 'tb_mensagem' | '$transaction'>;

export const defaultChatDatabase: ChatDatabase = prisma;

export type HistoryRow = Omit<PublicHistory, 'historico_origem'> & { historico_origem?: string | null };

export type MessageRow = {
  mensagem_id: number;
  historico_id: number;
  mensagem_remetente: boolean;
  mensagem_texto: string;
  mensagem_data_criacao: Date;
};
