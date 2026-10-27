import type { HistoryRow, MessageRow, PublicHistory, PublicMessage } from './chat.contracts.js';

export function serializeHistory(history: HistoryRow): PublicHistory {
  return {
    historico_id: history.historico_id,
    historico_nome: history.historico_nome,
    historico_data_criacao: history.historico_data_criacao,
    historico_data_modificacao: history.historico_data_modificacao,
    historico_origem: history.historico_origem === 'PROATIVO' ? 'PROATIVO' : 'MANUAL',
  };
}

export function serializeMessage(message: MessageRow): PublicMessage {
  return {
    mensagem_id: message.mensagem_id,
    historico_id: message.historico_id,
    remetente: message.mensagem_remetente ? 'assistant' : 'user',
    texto: message.mensagem_texto,
    mensagem_data_criacao: message.mensagem_data_criacao,
  };
}
