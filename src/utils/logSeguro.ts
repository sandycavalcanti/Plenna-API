import { randomUUID } from 'node:crypto';

type Evento = 'redefinicao_falhou' | 'redefinicao_smtp_falhou' | 'redefinicao_invalidacao_falhou' | 'oauth_falhou';
type ContextoSeguro = { etapa?: string };

function propriedade(erro: unknown, nome: string): unknown {
  return typeof erro === 'object' && erro !== null && nome in erro
    ? (erro as Record<string, unknown>)[nome]
    : undefined;
}

function textoSeguro(valor: unknown, limite = 64): string | undefined {
  if (typeof valor !== 'string' || valor.length === 0) return undefined;
  return valor.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, limite);
}

function numeroSeguro(valor: unknown): number | undefined {
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= 100 && valor <= 599
    ? valor
    : undefined;
}

export function logSeguro(evento: Evento, erro: unknown, correlacao = randomUUID(), contexto: ContextoSeguro = {}) {
  const codigo = textoSeguro(propriedade(erro, 'code'));
  const categoria = codigo === 'EAUTH' ? 'autenticacao' : codigo === 'ETIMEDOUT' ? 'timeout'
    : codigo === 'ECONNECTION' || codigo === 'ECONNREFUSED' || codigo === 'ESOCKET' ? 'conexao'
      : codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN' ? 'dns' : 'operacional';
  const eventoSeguro: Record<string, unknown> = { evento, categoria, correlacao };

  if (evento === 'redefinicao_smtp_falhou') {
    eventoSeguro.etapa = contexto.etapa ?? 'smtp.sendMail';
    eventoSeguro.tipo_erro = textoSeguro(propriedade(erro, 'name')) ?? 'Error';
    eventoSeguro.codigo_smtp = codigo ?? 'DESCONHECIDO';
    eventoSeguro.codigo_resposta_smtp = numeroSeguro(propriedade(erro, 'responseCode'));
    eventoSeguro.comando_smtp = textoSeguro(propriedade(erro, 'command'), 32);
  }

  console.error(eventoSeguro);
}
