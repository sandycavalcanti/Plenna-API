import { prisma } from '../../lib/prisma.js';
import { CreatePreferenciaCategoriaDTO, UpdatePreferenciaCategoriaDTO } from './preferencias-categoria.schemas.js';

export class PreferenciasCategoriaService {
  static async create(userId: number, data: CreatePreferenciaCategoriaDTO) {
    const now = new Date();

    return prisma.tb_preferencias_categoria.create({
      data: {
        usuario_id: userId,
        categoria_id: data.categoriaId,
        preferencias_categoria_meta_mensal: data.metaMensal,
        preferencias_categoria_created_at: now,
        preferencias_categoria_updated_at: now,
      },
    });
  }

  static async createMany(userId: number, preferencias: CreatePreferenciaCategoriaDTO[]) {
    const now = new Date();

    return prisma.tb_preferencias_categoria.createMany({
      data: preferencias.map((data) => ({
        usuario_id: userId,
        categoria_id: data.categoriaId,
        preferencias_categoria_meta_mensal: data.metaMensal,
        preferencias_categoria_created_at: now,
        preferencias_categoria_updated_at: now,
      })),
    });
  }

  static async findAllByUserId(userId: number) {
    const preferencias = await prisma.tb_preferencias_categoria.findMany({
      where: { usuario_id: userId },
      orderBy: { preferencias_categoria_created_at: 'desc' },
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
    const preferencia = await prisma.tb_preferencias_categoria.findFirst({
      where: {
        preferencias_categoria_id: preferenciaId,
        usuario_id: userId,
      },
    });

    if (!preferencia) throw new Error('Preferência de categoria não encontrada');

    return preferencia;
  }

  static async update(userId: number, preferenciaId: number, data: UpdatePreferenciaCategoriaDTO) {
    await this.findById(userId, preferenciaId);

    return prisma.tb_preferencias_categoria.update({
      where: { preferencias_categoria_id: preferenciaId },
      data: {
        categoria_id: data.categoriaId,
        preferencias_categoria_meta_mensal: data.metaMensal,
        preferencias_categoria_updated_at: new Date(),
      },
    });
  }

  static async delete(userId: number, preferenciaId: number) {
    await this.findById(userId, preferenciaId);

    await prisma.tb_preferencias_categoria.delete({
      where: { preferencias_categoria_id: preferenciaId },
    });
  }
}
