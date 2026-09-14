import { randomUUID } from 'node:crypto';

type Evento = 'redefinicao_falhou' | 'redefinicao_smtp_falhou' | 'redefinicao_invalidacao_falhou' | 'oauth_falhou';
export function logSeguro(evento: Evento, erro: unknown, correlacao = randomUUID()) {
  const codigo = typeof erro === 'object' && erro !== null && 'code' in erro ? erro.code : undefined;
  const categoria = codigo === 'EAUTH' ? 'autenticacao' : codigo === 'ETIMEDOUT' ? 'timeout'
    : codigo === 'ECONNECTION' || codigo === 'ECONNREFUSED' ? 'conexao' : 'operacional';
  console.error({ evento, categoria, correlacao });
}
