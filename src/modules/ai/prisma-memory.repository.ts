import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  MEMORY_ORIGINS,
  MEMORY_STATUS,
  memoryRecordSchema,
} from './memory.contracts.js';
import type { MemoryRecord } from './memory.contracts.js';
import {
  MemoryRepositoryConflictError,
  MemoryRepositoryError,
} from './memory.repository.js';
import type {
  MemoryRepository,
  MemoryRepositoryListQuery,
  MemoryRepositoryListResult,
  MemoryRepositoryUpdate,
} from './memory.repository.js';
import type { MemorySavePersistence } from './memory.contracts.js';

type PrismaMemoryClient = Pick<PrismaClient, 'tb_ai_anotacao' | 'tb_historico'>;

const memorySelect = {
  ai_anotacao_id: true,
  usuario_id: true,
  ai_anotacao_texto: true,
  ai_anotacao_data_criacao: true,
  ai_anotacao_origem: true,
  ai_anotacao_status: true,
  ai_anotacao_chave_dedupe: true,
  ai_anotacao_evidencia: true,
  ai_anotacao_historico_id: true,
  ai_anotacao_data_expiracao: true,
  ai_anotacao_data_atualizacao: true,
} as const;

type PrismaMemoryRow = {
  ai_anotacao_id: number;
  usuario_id: number;
  ai_anotacao_texto: string;
  ai_anotacao_data_criacao: Date;
  ai_anotacao_origem: string | null;
  ai_anotacao_status: string | null;
  ai_anotacao_chave_dedupe: string | null;
  ai_anotacao_evidencia: string | null;
  ai_anotacao_historico_id: number | null;
  ai_anotacao_data_expiracao: Date | null;
  ai_anotacao_data_atualizacao: Date | null;
};

export class PrismaMemoryRepository implements MemoryRepository {
  constructor(private readonly db: PrismaMemoryClient) {}

  async listByUsuario(
    usuarioId: number,
    query: MemoryRepositoryListQuery,
  ): Promise<MemoryRepositoryListResult> {
    try {
      const statusWhere: Prisma.tb_ai_anotacaoWhereInput = query.status === MEMORY_STATUS.ATIVA
        ? {
            OR: [
              { ai_anotacao_status: MEMORY_STATUS.ATIVA },
              { ai_anotacao_status: null },
            ],
          }
        : { ai_anotacao_status: query.status };

      const where: Prisma.tb_ai_anotacaoWhereInput = {
        usuario_id: usuarioId,
        AND: [
          statusWhere,
          query.origem ? { ai_anotacao_origem: query.origem } : {},
          {
            OR: [
              { ai_anotacao_data_expiracao: null },
              { ai_anotacao_data_expiracao: { gt: query.agora } },
            ],
          },
        ],
      };

      const rows = await this.db.tb_ai_anotacao.findMany({
        where,
        orderBy: [
          { ai_anotacao_data_atualizacao: 'desc' },
          { ai_anotacao_data_criacao: 'desc' },
          { ai_anotacao_id: 'desc' },
        ],
        skip: query.offset,
        take: query.limit + 1,
        select: memorySelect,
      });
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit).map((row) => this.mapRow(row));

      return {
        itens: items,
        proximo_cursor: hasMore ? String(query.offset + query.limit) : null,
      };
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async findById(usuarioId: number, memoriaId: number): Promise<MemoryRecord | null> {
    try {
      const row = await this.db.tb_ai_anotacao.findFirst({
        where: { usuario_id: usuarioId, ai_anotacao_id: memoriaId },
        select: memorySelect,
      });
      return row ? this.mapRow(row) : null;
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async findByDedupeKey(usuarioId: number, chaveDedupe: string): Promise<MemoryRecord | null> {
    try {
      const row = await this.db.tb_ai_anotacao.findFirst({
        where: { usuario_id: usuarioId, ai_anotacao_chave_dedupe: chaveDedupe },
        select: memorySelect,
      });
      return row ? this.mapRow(row) : null;
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async hasHistoricoForUsuario(usuarioId: number, historicoId: number): Promise<boolean> {
    try {
      const row = await this.db.tb_historico.findFirst({
        where: { usuario_id: usuarioId, historico_id: historicoId },
        select: { historico_id: true },
      });
      return row !== null;
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async create(data: MemorySavePersistence): Promise<MemoryRecord> {
    try {
      const row = await this.db.tb_ai_anotacao.create({
        data: {
          usuario_id: data.usuario_id,
          ai_anotacao_texto: data.conteudo,
          ai_anotacao_origem: data.origem,
          ai_anotacao_status: MEMORY_STATUS.ATIVA,
          ai_anotacao_chave_dedupe: data.chave_dedupe,
          ai_anotacao_evidencia: data.evidencia,
          ai_anotacao_historico_id: data.historico_id,
          ai_anotacao_data_expiracao: data.data_expiracao,
          ai_anotacao_data_atualizacao: new Date(),
        },
        select: memorySelect,
      });
      return this.mapRow(row);
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async update(
    usuarioId: number,
    memoriaId: number,
    data: MemoryRepositoryUpdate,
  ): Promise<MemoryRecord | null> {
    try {
      const updateData: Prisma.tb_ai_anotacaoUncheckedUpdateManyInput = {
        ai_anotacao_data_atualizacao: new Date(),
      };

      if (data.conteudo !== undefined) updateData.ai_anotacao_texto = data.conteudo;
      if (data.origem !== undefined) updateData.ai_anotacao_origem = data.origem;
      if (data.status !== undefined) updateData.ai_anotacao_status = data.status;
      if (data.chave_dedupe !== undefined) updateData.ai_anotacao_chave_dedupe = data.chave_dedupe;
      if (data.evidencia !== undefined) updateData.ai_anotacao_evidencia = data.evidencia;
      if (data.historico_id !== undefined) updateData.ai_anotacao_historico_id = data.historico_id;
      if (data.data_expiracao !== undefined) updateData.ai_anotacao_data_expiracao = data.data_expiracao;

      const result = await this.db.tb_ai_anotacao.updateMany({
        where: { usuario_id: usuarioId, ai_anotacao_id: memoriaId },
        data: updateData,
      });
      if (result.count === 0) {
        return null;
      }

      return this.findById(usuarioId, memoriaId);
    } catch (error) {
      throw this.translateError(error);
    }
  }

  async delete(usuarioId: number, memoriaId: number): Promise<boolean> {
    try {
      const result = await this.db.tb_ai_anotacao.deleteMany({
        where: { usuario_id: usuarioId, ai_anotacao_id: memoriaId },
      });
      return result.count > 0;
    } catch (error) {
      throw this.translateError(error);
    }
  }

  private mapRow(row: PrismaMemoryRow): MemoryRecord {
    const origem = row.ai_anotacao_origem === MEMORY_ORIGINS.DECLARADA
      ? MEMORY_ORIGINS.DECLARADA
      : row.ai_anotacao_origem === MEMORY_ORIGINS.INFERIDA
        ? MEMORY_ORIGINS.INFERIDA
        : row.ai_anotacao_origem === null
          ? MEMORY_ORIGINS.DESCONHECIDA
          : null;
    const status = row.ai_anotacao_status === null
      ? MEMORY_STATUS.ATIVA
      : row.ai_anotacao_status === MEMORY_STATUS.ATIVA || row.ai_anotacao_status === MEMORY_STATUS.INATIVA
        ? row.ai_anotacao_status
        : null;

    const parsed = memoryRecordSchema.safeParse({
      memoria_id: row.ai_anotacao_id,
      usuario_id: row.usuario_id,
      conteudo: row.ai_anotacao_texto,
      origem,
      status,
      chave_dedupe: row.ai_anotacao_chave_dedupe,
      evidencia: row.ai_anotacao_evidencia,
      historico_id: row.ai_anotacao_historico_id,
      data_expiracao: row.ai_anotacao_data_expiracao,
      data_criacao: row.ai_anotacao_data_criacao,
      data_atualizacao: row.ai_anotacao_data_atualizacao ?? row.ai_anotacao_data_criacao,
    });
    if (!parsed.success) {
      throw new MemoryRepositoryError();
    }

    return parsed.data;
  }

  private translateError(error: unknown): Error {
    if (error instanceof MemoryRepositoryConflictError || error instanceof MemoryRepositoryError) {
      return error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new MemoryRepositoryConflictError();
    }

    return new MemoryRepositoryError();
  }
}
