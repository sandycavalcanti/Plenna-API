import { prisma } from '../../lib/prisma.js';
import { CreateTempoUsoDTO, UpdateTempoUsoDTO } from './tempo-uso.schemas.js';

export class TempoUsoService {
  static async create(userId: number, data: CreateTempoUsoDTO) {
    const now = new Date();
    const tempo = await prisma.tb_tempo_uso.create({
      data: {
        usuario_id: userId,
        tempo_uso_nome: data.nome,
        tempo_uso_minutos: data.minutos,
        tempo_uso_data: data.data,
        tempo_uso_data_criacao: now,
      },
    });
    return tempo;
  }

  static async findAllByUserId(userId: number) {
    return prisma.tb_tempo_uso.findMany({
      where: { usuario_id: userId },
      orderBy: { tempo_uso_data_criacao: 'desc' },
    });
  }

  static async findById(userId: number, id: number) {
    const tempo = await prisma.tb_tempo_uso.findFirst({
      where: { tempo_uso_id: id, usuario_id: userId },
    });
    if (!tempo) throw new Error('Registro de tempo não encontrado');
    return tempo;
  }

  static async update(userId: number, id: number, data: UpdateTempoUsoDTO) {
    const tempo = await prisma.tb_tempo_uso.findFirst({
      where: { tempo_uso_id: id, usuario_id: userId },
    });
    if (!tempo) throw new Error('Registro de tempo não encontrado');

    return prisma.tb_tempo_uso.update({
      where: { tempo_uso_id: id },
      data: {
        tempo_uso_nome: data.nome,
        tempo_uso_minutos: data.minutos,
        tempo_uso_data: data.data,
      },
    });
  }

  static async delete(userId: number, id: number) {
    const tempo = await prisma.tb_tempo_uso.findFirst({
      where: { tempo_uso_id: id, usuario_id: userId },
    });
    if (!tempo) throw new Error('Registro de tempo não encontrado');

    await prisma.tb_tempo_uso.delete({ where: { tempo_uso_id: id } });
  }
}
