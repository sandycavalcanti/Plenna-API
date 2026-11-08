import { prisma } from '../../lib/prisma.js';
import { CheckMetaDTO, CreateMetaDTO, UpdateMetaDTO } from './meta.schemas.js';
import { MetaMovimentacaoService } from './meta-movimentacao.service.js';
import { parseMetaMoney, serializeMetaMoney } from './meta.money.js';
import { AppError } from '../../errors/AppError.js';

type MetaDatabase = {
  tb_meta: any;
  $transaction?: (callback: (database: MetaDatabase) => Promise<any>) => Promise<any>;
  $queryRaw?: any;
};

async function inTransaction<T>(database: MetaDatabase, callback: (transaction: MetaDatabase) => Promise<T>) {
  if (typeof database.$transaction === 'function') return database.$transaction(callback);
  // Keeps the service unit-testable with the small doubles used by this module.
  return callback(database);
}

export function serializeMeta(meta: any) {
  return {
    ...meta,
    meta_valor: serializeMetaMoney(meta.meta_valor),
    meta_valor_reservado: serializeMetaMoney(meta.meta_valor_reservado),
  };
}

export class MetaService {
  static async create(userId: number, data: CreateMetaDTO, database: MetaDatabase = prisma) {
    return database.tb_meta.create({
      data: {
        usuario_id: userId,
        meta_titulo: data.titulo,
        meta_descricao: data.descricao,
        meta_valor: parseMetaMoney(data.valor),
        meta_data: data.data,
      },
    });
  }

  static async findAllByUserId(userId: number, options: { includeSavings?: boolean } = {}, database: MetaDatabase = prisma) {
    const metas = await database.tb_meta.findMany({
      where: { usuario_id: userId },
      orderBy: { meta_data_criacao: 'desc' },
    });
    if (options.includeSavings !== true) return metas;
    return MetaMovimentacaoService.enrichMetas(metas, database);
  }

  static async checkMeta(userId: number, data: CheckMetaDTO, database: MetaDatabase = prisma) {
    return inTransaction(database, async (transaction) => {
      // The row lock makes retries of the explicit completion action
      // idempotent even when two requests arrive concurrently.
      if (typeof transaction.$queryRaw === 'function') {
        await transaction.$queryRaw`
          SELECT meta_id
          FROM public.tb_meta
          WHERE meta_id = ${data.meta_id}
            AND usuario_id = ${userId}
          FOR UPDATE
        `;
      }

      const meta = await transaction.tb_meta.findFirst({
        where: { meta_id: data.meta_id, usuario_id: userId },
      });
      if (!meta) throw new AppError('Meta não encontrada', 404);

      if (meta.meta_completado === data.completado) return meta;

      const effectiveAt = new Date();
      const updated = await transaction.tb_meta.update({
        where: { meta_id: data.meta_id },
        data: {
          meta_completado: data.completado,
          meta_data_conclusao: data.completado ? effectiveAt : null,
        },
      });

      return updated;
    });
  }

  static async update(userId: number, metaId: number, data: UpdateMetaDTO, database: MetaDatabase = prisma) {
    const meta = await database.tb_meta.findFirst({
      where: { meta_id: metaId, usuario_id: userId },
    });
    if (!meta) throw new AppError('Meta não encontrada', 404);

    const updateData: Record<string, unknown> = {
      ...(data.titulo !== undefined ? { meta_titulo: data.titulo } : {}),
      ...(data.descricao !== undefined ? { meta_descricao: data.descricao } : {}),
      ...(data.data !== undefined ? { meta_data: data.data } : {}),
      ...(data.valor !== undefined ? { meta_valor: parseMetaMoney(data.valor) } : {}),
    };

    return database.tb_meta.update({ where: { meta_id: metaId }, data: updateData });
  }

  static async delete(userId: number, metaId: number, database: MetaDatabase = prisma) {
    const meta = await database.tb_meta.findFirst({
      where: { meta_id: metaId, usuario_id: userId },
    });
    if (!meta) throw new AppError('Meta não encontrada', 404);
    await database.tb_meta.delete({ where: { meta_id: metaId } });
  }
}
