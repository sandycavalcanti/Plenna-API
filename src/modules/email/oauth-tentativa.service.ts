import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
import { ConsentimentoService } from '../consentimento/consentimento.service.js';
import type { FinalizarEmailDTO } from './email.schemas.js';

export const hashOAuth = (valor: string) => createHash('sha256').update(valor).digest('hex');
type CredenciaisTentativa = Pick<FinalizarEmailDTO, 'tentativa' | 'state' | 'segredo'>;
export class OAuthTentativaService {
  static async iniciar(userId: number) {
    const state = randomBytes(32).toString('base64url');
    const segredo = randomBytes(32).toString('base64url');
    const tentativa = randomUUID();
    await prisma.$transaction(async (tx) => {
      await ConsentimentoService.bloquearUsuario(tx, userId);
      await tx.tb_oauth_tentativa.updateMany({
        where: { usuario_id: userId, oauth_provedor: 'GMAIL', oauth_status: { in: ['PENDENTE', 'PROCESSANDO'] } },
        data: { oauth_status: 'CANCELADA', oauth_finalizada_em: new Date() },
      });
      await tx.tb_oauth_tentativa.create({ data: {
        oauth_tentativa_id: tentativa, usuario_id: userId, oauth_provedor: 'GMAIL',
        oauth_state_hash: hashOAuth(state), oauth_finalizacao_hash: hashOAuth(segredo),
        oauth_expira_em: new Date(Date.now() + 10 * 60_000),
      } });
      await tx.tb_oauth_tentativa.deleteMany({ where: { usuario_id: userId, oauth_expira_em: { lt: new Date(Date.now() - 86400_000) } } });
    });
    return { tentativa, state, segredo };
  }

  static async callback(state: string) {
    const tentativa = await prisma.tb_oauth_tentativa.findUnique({ where: { oauth_state_hash: hashOAuth(state) } });
    if (!tentativa || tentativa.oauth_status !== 'PENDENTE' || tentativa.oauth_expira_em <= new Date()) {
      throw new AppError('Tentativa inválida ou expirada', 400);
    }
    return tentativa.oauth_tentativa_id;
  }

  static async verificar(tx: Prisma.TransactionClient, userId: number, data: CredenciaisTentativa) {
    const tentativa = await tx.tb_oauth_tentativa.findUnique({ where: { oauth_tentativa_id: data.tentativa } });
    if (!tentativa || tentativa.usuario_id !== userId || tentativa.oauth_provedor !== 'GMAIL' ||
      tentativa.oauth_state_hash !== hashOAuth(data.state) ||
      !timingSafeEqual(Buffer.from(tentativa.oauth_finalizacao_hash, 'hex'), Buffer.from(hashOAuth(data.segredo), 'hex'))) {
      throw new AppError('Tentativa inválida', 400);
    }
    return tentativa;
  }

  static async consumir(userId: number, data: CredenciaisTentativa) {
    return prisma.$transaction(async (tx) => {
      await ConsentimentoService.bloquearUsuario(tx, userId);
      const tentativa = await this.verificar(tx, userId, data);
      if (tentativa.oauth_status !== 'PENDENTE' || tentativa.oauth_expira_em <= new Date()) {
        throw new AppError('Tentativa já encerrada ou expirada. Consulte a conexão.', 409);
      }
      const atualizado = await tx.tb_oauth_tentativa.updateMany({
        where: { oauth_tentativa_id: data.tentativa, oauth_status: 'PENDENTE', oauth_expira_em: { gt: new Date() } },
        data: { oauth_status: 'PROCESSANDO' },
      });
      if (atualizado.count !== 1) throw new AppError('Tentativa indisponível', 409);
    });
  }

  static async encerrar(userId: number, data: CredenciaisTentativa, status: 'CANCELADA' | 'FALHOU') {
    await prisma.$transaction(async (tx) => {
      await ConsentimentoService.bloquearUsuario(tx, userId);
      await this.verificar(tx, userId, data);
      await tx.tb_oauth_tentativa.updateMany({
        where: { oauth_tentativa_id: data.tentativa, oauth_status: { in: ['PENDENTE', 'PROCESSANDO'] } },
        data: { oauth_status: status, oauth_finalizada_em: new Date() },
      });
    });
  }
}
