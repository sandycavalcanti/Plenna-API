import { prisma } from '../../lib/prisma.js';
import { CheckMetaDTO, CreateMetaDTO, UpdateMetaDTO } from './meta.schemas.js';
import { MetaMovimentacaoService } from './meta-movimentacao.service.js';
import { parseMetaMoney, serializeMetaMoney } from './meta.money.js';
import { AppError } from '../../errors/AppError.js';

type MetaDatabase = {
  tb_meta: any;
};

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
    const meta = await database.tb_meta.findFirst({
      where: { meta_id: data.meta_id, usuario_id: userId },
    });
    if (!meta) throw new AppError('Meta não encontrada', 404);
    return database.tb_meta.update({
      where: { meta_id: data.meta_id },
      data: { meta_completado: data.completado },
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
