import { prisma } from '../../lib/prisma.js';
import { CheckGoalDTO, CreateGoalDTO, UpdateGoalDTO } from './goal.schemas.js';

export class GoalService {
  // CREATE
  static async create(userId: number, data: CreateGoalDTO) {
    const now = new Date();
    const goal = await prisma.tb_meta.create({
      data: {
        usuario_id: userId,
        meta_titulo: data.titulo,
        meta_descricao: data.descricao,
        meta_valor: data.valor,
        meta_data: data.data,
        meta_created_at: now,
        meta_updated_at: now,
      },
    });
    return goal;
  }

  // LIST BY USER ID
  static async findAllByUserId(userId: number) {
    const goals = await prisma.tb_meta.findMany({
      where: { usuario_id: userId },
      orderBy: { meta_created_at: 'desc' },
    });
    return goals;
  }

  // CHECK GOAL
  static async checkGoal(userId: number, data: CheckGoalDTO) {
    const goal = await prisma.tb_meta.findFirst({
      where: {
        meta_id: data.meta_id,
        usuario_id: userId,
      },
    });
    if (!goal) throw new Error('Meta não encontrada');
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
  static async update(userId: number, goalId: number, data: UpdateGoalDTO) {
    const goal = await prisma.tb_meta.findFirst({
      where: {
        meta_id: goalId,
        usuario_id: userId,
      },
    });
    if (!goal) throw new Error('Meta não encontrada');

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
  static async delete(userId: number, goalId: number) {
    const goal = await prisma.tb_meta.findFirst({
      where: {
        meta_id: goalId,
        usuario_id: userId,
      },
    });
    if (!goal) throw new Error('Meta não encontrada');

    await prisma.tb_meta.delete({
      where: { meta_id: goalId },
    });
  }
}
