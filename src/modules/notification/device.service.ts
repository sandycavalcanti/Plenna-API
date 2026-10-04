import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';

const publicDeviceSelect = {
  dispositivo_id: true,
  dispositivo_plataforma: true,
  dispositivo_ativo: true,
  dispositivo_ultima_utilizacao_em: true,
  dispositivo_data_criacao: true,
  dispositivo_data_modificacao: true,
} as const;

export class DeviceService {
  static async registerPushToken(userId: number, pushToken: string, platform: string) {
    const now = new Date();

    return prisma.tb_dispositivo.upsert({
      where: { dispositivo_push_token: pushToken },
      update: {
        usuario_id: userId,
        dispositivo_plataforma: platform,
        dispositivo_ativo: 1,
        dispositivo_ultimo_erro: null,
        dispositivo_ultima_utilizacao_em: now,
        dispositivo_data_modificacao: now,
      },
      create: {
        usuario_id: userId,
        dispositivo_push_token: pushToken,
        dispositivo_plataforma: platform,
        dispositivo_ativo: 1,
        dispositivo_ultima_utilizacao_em: now,
        dispositivo_data_criacao: now,
        dispositivo_data_modificacao: now,
      },
      select: publicDeviceSelect,
    });
  }

  static async disablePushToken(userId: number, pushToken: string) {
    const device = await prisma.tb_dispositivo.findFirst({
      where: {
        usuario_id: userId,
        dispositivo_push_token: pushToken,
      },
      select: { dispositivo_id: true },
    });

    if (!device) {
      throw new AppError('Dispositivo não encontrado', 404);
    }

    return prisma.tb_dispositivo.update({
      where: { dispositivo_id: device.dispositivo_id },
      data: {
        dispositivo_ativo: 0,
        dispositivo_data_modificacao: new Date(),
      },
      select: publicDeviceSelect,
    });
  }

  static async listActiveByUserId(userId: number) {
    return prisma.tb_dispositivo.findMany({
      where: {
        usuario_id: userId,
        dispositivo_ativo: 1,
      },
      orderBy: { dispositivo_ultima_utilizacao_em: 'desc' },
      select: {
        dispositivo_id: true,
        usuario_id: true,
        dispositivo_push_token: true,
        dispositivo_plataforma: true,
        dispositivo_ativo: true,
        dispositivo_ultimo_erro: true,
        dispositivo_ultima_tentativa_em: true,
        dispositivo_ultima_utilizacao_em: true,
        dispositivo_data_criacao: true,
        dispositivo_data_modificacao: true,
      },
    });
  }
}
