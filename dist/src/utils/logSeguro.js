import { randomUUID } from 'node:crypto';
export function logSeguro(evento, erro, correlacao = randomUUID()) {
    const codigo = typeof erro === 'object' && erro !== null && 'code' in erro ? erro.code : undefined;
    const categoria = codigo === 'EAUTH' ? 'autenticacao' : codigo === 'ETIMEDOUT' ? 'timeout'
        : codigo === 'ECONNECTION' || codigo === 'ECONNREFUSED' ? 'conexao' : 'operacional';
    console.error({ evento, categoria, correlacao });
}
