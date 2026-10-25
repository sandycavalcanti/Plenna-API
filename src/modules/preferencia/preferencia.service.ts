import { prisma } from '../../lib/prisma.js';
import { CreatePreferenciaCategoriaDTO, UpdatePreferenciaCategoriaDTO } from './preferencia.schemas.js';
import type { Prisma } from '@prisma/client';
import { capturarReferencias } from '../compra/referencias.legado.js';
import { AppError } from '../../errors/AppError.js';

export class PreferenciasCategoriaService {
  private static async withUserLock<T>(userId: number, operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<{ usuario_id: number }[]>`SELECT usuario_id FROM public.tb_usuario WHERE usuario_id = ${userId} FOR UPDATE`;
      if (users.length !== 1) throw new AppError('Usuário não encontrado', 404);
      const versioned=!!tx.tb_referencia_financeira;
      const before=versioned?await tx.tb_preferencia.findMany({where:{usuario_id:userId}}):[];
      const result=await operation(tx);
      if(versioned){
        const after=await tx.tb_preferencia.findMany({where:{usuario_id:userId}});
        const ids=new Set([...before,...after].map(p=>p.categoria_id));
        await capturarReferencias(tx,userId,[...ids].flatMap(categoriaId=>{const a=before.find(p=>p.categoria_id===categoriaId),b=after.find(p=>p.categoria_id===categoriaId);return String(a?.preferencia_meta)===String(b?.preferencia_meta)?[]:[{tipo:'CATEGORIA',categoriaId,valor:b?.preferencia_meta??null}];}));
      }
      return result;
    });
  }


  static async create(userId: number, data: CreatePreferenciaCategoriaDTO) {
    const now = new Date();

    return this.withUserLock(userId, (tx) => tx.tb_preferencia.create({
      data: {
        usuario_id: userId,
        categoria_id: data.categoriaId,
        preferencia_meta: data.metaMensal,
      },
    }));
  }

  static async createMany(userId: number, preferencias: CreatePreferenciaCategoriaDTO[]) {
    const now = new Date();

    return this.withUserLock(userId, (tx) => tx.tb_preferencia.createMany({
      data: preferencias.map((data) => ({
        usuario_id: userId,
        categoria_id: data.categoriaId,
        preferencia_meta: data.metaMensal,
      })),
    }));
  }

  static async replaceMany(userId: number, preferencias: CreatePreferenciaCategoriaDTO[]) {
    return this.withUserLock(userId, async (tx) => {
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

    if (!preferencia) throw new AppError('Preferência de categoria não encontrada', 404);

    return preferencia;
  }

  static async update(userId: number, preferenciaId: number, data: UpdatePreferenciaCategoriaDTO) {
    return this.withUserLock(userId, async (tx) => {
      const existing = await tx.tb_preferencia.findFirst({ where: { usuario_id: userId, preferencia_id: preferenciaId } });
      if (!existing) throw new AppError('Preferência de categoria não encontrada', 404);
      return tx.tb_preferencia.update({
        where: { preferencia_id: preferenciaId },
        data: {
          categoria_id: data.categoriaId,
          preferencia_meta: data.metaMensal,
        },
      });
    });
  }

  static async delete(userId: number, preferenciaId: number) {
    await this.withUserLock(userId, async (tx) => {
      const existing = await tx.tb_preferencia.findFirst({ where: { usuario_id: userId, preferencia_id: preferenciaId } });
      if (!existing) throw new AppError('Preferência de categoria não encontrada', 404);
      await tx.tb_preferencia.delete({
        where: { preferencia_id: preferenciaId },
      });
    });
  }
}
