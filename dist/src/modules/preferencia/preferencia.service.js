import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/AppError.js';
export class PreferenciasCategoriaService {
    static async create(userId, data) {
        const now = new Date();
        return prisma.tb_preferencia.create({
            data: {
                usuario_id: userId,
                categoria_id: data.categoriaId,
                preferencia_meta: data.metaMensal,
            },
        });
    }
    static async createMany(userId, preferencias) {
        const now = new Date();
        return prisma.tb_preferencia.createMany({
            data: preferencias.map((data) => ({
                usuario_id: userId,
                categoria_id: data.categoriaId,
                preferencia_meta: data.metaMensal,
            })),
        });
    }
    static async replaceMany(userId, preferencias) {
        return prisma.$transaction(async (tx) => {
            const results = [];
            for (const pref of preferencias) {
                const existing = await tx.tb_preferencia.findFirst({ where: { usuario_id: userId, categoria_id: pref.categoriaId } });
                if (existing) {
                    const updated = await tx.tb_preferencia.update({
                        where: { preferencia_id: existing.preferencia_id },
                        data: { preferencia_meta: pref.metaMensal },
                    });
                    results.push(updated);
                }
                else {
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
    static async findAllByUserId(userId) {
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
    static async findById(userId, preferenciaId) {
        const preferencia = await prisma.tb_preferencia.findFirst({
            where: {
                preferencia_id: preferenciaId,
                usuario_id: userId,
            },
        });
        if (!preferencia)
            throw new AppError('Preferência de categoria não encontrada', 404);
        return preferencia;
    }
    static async update(userId, preferenciaId, data) {
        await this.findById(userId, preferenciaId);
        return prisma.tb_preferencia.update({
            where: { preferencia_id: preferenciaId },
            data: {
                categoria_id: data.categoriaId,
                preferencia_meta: data.metaMensal,
            },
        });
    }
    static async delete(userId, preferenciaId) {
        await this.findById(userId, preferenciaId);
        await prisma.tb_preferencia.delete({
            where: { preferencia_id: preferenciaId },
        });
    }
}
