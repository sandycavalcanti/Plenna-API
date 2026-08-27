/**
 * Tipos internos utilizados para representar apenas os dados do Gmail
 * necessários à integração.
 *
 * Eles evitam propagar os payloads completos da API Google pelas demais
 * camadas da aplicação.
 */
export type GmailMessageSummary = {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
};

export type GmailMessageDetail = GmailMessageSummary & {
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  date?: string | null;
  bodyText?: string | null;
};

export type GmailIntegration = {
  integracao_id: number;
  usuario_id: number;
  integracao_email: string;
  integracao_access_token: string;
  integracao_refresh_token: string;
  integracao_token_expira_em: Date;
  integracao_ultima_sincronizacao_em: Date | null;
};

export type GmailMessageQueryResult = {
  processed: number;
  created: number;
  skipped: number;
};
