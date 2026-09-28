import { prisma } from '../../lib/prisma.js';

export class CategoryService {
  static async findAll() {
    return prisma.tb_categoria.findMany({
      orderBy: { categoria_nome: 'asc' },
    });
  }
}
