import { prisma } from "../../lib/prisma.js";
import { CreateGoalDTO, UpdateGoalDTO } from "./goal.schemas.js";

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
            orderBy: { meta_created_at: "desc" }
        });
        return goals;
    }
}
