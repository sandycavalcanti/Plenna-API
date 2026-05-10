import { prisma } from '../../lib/prisma.js';
import { CreatePreferenciaCategoriaDTO, UpdatePreferenciaCategoriaDTO } from './preferencia.schemas.js';

export class PreferenciasCategoriaService {
  static async create(userId: number, data: CreatePreferenciaCategoriaDTO) {
    const now = new Date();

    return prisma.tb_preferencia.create({
      data: {
        usuario_id: userId,
        categoria_id: data.categoriaId,
        preferencia_meta: data.metaMensal,
      },
    });
  }

  static async createMany(userId: number, preferencias: CreatePreferenciaCategoriaDTO[]) {
    const now = new Date();

    return prisma.tb_preferencia.createMany({
      data: preferencias.map((data) => ({
        usuario_id: userId,
        categoria_id: data.categoriaId,
        preferencia_meta: data.metaMensal,
      })),
    });
  }

  static async replaceMany(userId: number, preferencias: CreatePreferenciaCategoriaDTO[]) {
    return prisma.$transaction(async (tx) => {
      const results: any[] = [];

      for (const pref of preferencias) {
        const existing = await tx.tb_preferencia.findFirst({ where: { usuario_id: userId, categoria_id: pref.categoriaId } });

        if (existing) {
          const updated = await tx.tb_preferencia.update({
            where: { preferencia_id: existing.preferencia_id },
            data: { preferencia_meta: pref.metaMensal },
          });
          results.push(updated);
        } else {
          const created = await tx.tb_preferencia.create({
            data: {
              usuario_id: userId,
              categoria_id: pref.categoriaId,
              preferencia_meta: pref.metaMensal,
            },
          });
          results.push(created);
        }
      }

      return results;
    });
  }

  static async findAllByUserId(userId: number) {
    const preferencias = await prisma.tb_preferencia.findMany({
      where: { usuario_id: userId },
      orderBy: { preferencia_data_criacao: 'desc' },
      include: {
        tb_categoria: {
          select: {
            categoria_nome: true,
          },
        },
      },
    });

    return preferencias.map(({ tb_categoria, ...preferencia }) => ({
      ...preferencia,
      categoria_nome: tb_categoria.categoria_nome,
    }));
  }

  static async findById(userId: number, preferenciaId: number) {
    const preferencia = await prisma.tb_preferencia.findFirst({
      where: {
        preferencia_id: preferenciaId,
        usuario_id: userId,
      },
    });

    if (!preferencia) throw new Error('Preferência de categoria não encontrada');

    return preferencia;
  }

  static async update(userId: number, preferenciaId: number, data: UpdatePreferenciaCategoriaDTO) {
    await this.findById(userId, preferenciaId);

    return prisma.tb_preferencia.update({
      where: { preferencia_id: preferenciaId },
      data: {
        categoria_id: data.categoriaId,
        preferencia_meta: data.metaMensal,
      },
    });
  }

  static async delete(userId: number, preferenciaId: number) {
    await this.findById(userId, preferenciaId);

    await prisma.tb_preferencia.delete({
      where: { preferencia_id: preferenciaId },
    });
  }
}
