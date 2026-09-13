import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';

export const REDEFINICAO_LIMITES = { email: 3, ip: 20, segundos: 900 } as const;

export function obterIp(req: Request): string {
  // Vercel sobrescreve este header. Fora dela, usa somente o peer TCP.
  const ip = process.env.VERCEL === '1' ? req.get('x-vercel-forwarded-for') : req.socket.remoteAddress;
  if (!ip || !isIP(ip)) throw new Error('Origem indisponivel');
  return ip;
}

export async function permitirRedefinicao(email: string, ip: string): Promise<boolean> {
  const chave = env.rateLimitHmacKey;
  if (!chave || Buffer.byteLength(chave) < 32) throw new Error('Limitador nao configurado');
  const hmac = (contexto: string, valor: string) => createHmac('sha256', chave).update(contexto).update('\0').update(valor).digest('hex');
  return prisma.$transaction(async (tx) => {
    // Sempre a mesma ordem de locks. O limite por IP também limita novas chaves de email.
    for (const [contexto, valor, maximo] of [
      ['forgot:ip', ip, REDEFINICAO_LIMITES.ip],
      ['forgot:email', email.trim().toLowerCase(), REDEFINICAO_LIMITES.email],
    ] as const) {
      const hash = hmac(contexto, valor);
      const rows = await tx.$queryRaw<{ limite_contagem: number }[]>`
        INSERT INTO public.tb_limite_requisicao (limite_chave, limite_janela_inicio, limite_contagem, limite_expira_em)
        VALUES (${hash}, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP + ${REDEFINICAO_LIMITES.segundos} * INTERVAL '1 second')
        ON CONFLICT (limite_chave) DO UPDATE SET
          limite_contagem = CASE WHEN tb_limite_requisicao.limite_expira_em <= CURRENT_TIMESTAMP THEN 1 ELSE LEAST(tb_limite_requisicao.limite_contagem + 1, ${maximo + 1}) END,
          limite_janela_inicio = CASE WHEN tb_limite_requisicao.limite_expira_em <= CURRENT_TIMESTAMP THEN CURRENT_TIMESTAMP ELSE tb_limite_requisicao.limite_janela_inicio END,
          limite_expira_em = CASE WHEN tb_limite_requisicao.limite_expira_em <= CURRENT_TIMESTAMP THEN CURRENT_TIMESTAMP + ${REDEFINICAO_LIMITES.segundos} * INTERVAL '1 second' ELSE tb_limite_requisicao.limite_expira_em END
        RETURNING limite_contagem`;
      if (rows.length !== 1 || rows[0].limite_contagem > maximo) return false;
    }
    // Retenção curta e trabalho limitado, sem cron nem remoção de linhas bloqueadas.
    await tx.$executeRaw`DELETE FROM public.tb_limite_requisicao WHERE limite_chave IN (
      SELECT limite_chave FROM public.tb_limite_requisicao WHERE limite_expira_em < CURRENT_TIMESTAMP - INTERVAL '1 day'
      LIMIT 20 FOR UPDATE SKIP LOCKED)`;
    return true;
  });
}
