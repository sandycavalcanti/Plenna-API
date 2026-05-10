import { prisma } from '../../lib/prisma.js';
export class GoalService {
    // CREATE
    static async create(userId, data) {
        const now = new Date();
        const goal = await prisma.tb_meta.create({
            data: {
                usuario_id: userId,
                meta_titulo: data.titulo,
                meta_descricao: data.descricao,
                meta_valor: data.valor,
                meta_data: data.data,
            },
        });
        return goal;
    }
    // LIST BY USER ID
    static async findAllByUserId(userId) {
        const goals = await prisma.tb_meta.findMany({
            where: { usuario_id: userId },
            orderBy: { meta_data_criacao: 'desc' },
        });
        return goals;
    }
    // CHECK GOAL
    static async checkGoal(userId, data) {
        const goal = await prisma.tb_meta.findFirst({
            where: {
                meta_id: data.meta_id,
                usuario_id: userId,
            },
        });
        if (!goal)
            throw new Error('Meta não encontrada');
        const updatedGoal = await prisma.tb_meta.update({
            where: { meta_id: data.meta_id },
            data: {
                meta_completado: data.completado,
                meta_updated_at: new Date(),
            },
        });
        return updatedGoal;
    }
    // UPDATE
    static async update(userId, goalId, data) {
        const goal = await prisma.tb_meta.findFirst({
            where: {
                meta_id: goalId,
                usuario_id: userId,
            },
        });
        if (!goal)
            throw new Error('Meta não encontrada');
        return prisma.tb_meta.update({
            where: { meta_id: goalId },
            data: {
                meta_titulo: data.titulo,
                meta_descricao: data.descricao,
                meta_valor: data.valor,
                meta_data: data.data,
                meta_updated_at: new Date(),
            },
        });
    }
    // DELETE
    static async delete(userId, goalId) {
        const goal = await prisma.tb_meta.findFirst({
            where: {
                meta_id: goalId,
                usuario_id: userId,
            },
        });
        if (!goal)
            throw new Error('Meta não encontrada');
        await prisma.tb_meta.delete({
            where: { meta_id: goalId },
        });
    }
}
