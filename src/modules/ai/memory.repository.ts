import type { MemoryRecord, MemorySavePersistence, MemoryOrigin, MemoryStatus } from './memory.contracts.js';

export type MemoryRepositoryListQuery = {
  status: MemoryStatus;
  origem?: MemoryOrigin;
  offset: number;
  limit: number;
  agora: Date;
};

export type MemoryRepositoryListResult = {
  itens: MemoryRecord[];
  proximo_cursor: string | null;
};

export type MemoryRepositoryUpdate = Partial<Pick<MemoryRecord, 'conteudo' | 'origem' | 'evidencia' | 'status' | 'historico_id' | 'data_expiracao' | 'chave_dedupe'>>;

export class MemoryRepositoryConflictError extends Error {
  readonly code = 'MEMORY_REPOSITORY_CONFLICT';

  constructor() {
    super('Conflito de persistência da memória.');
    this.name = 'MemoryRepositoryConflictError';
  }
}

export class MemoryRepositoryError extends Error {
  readonly code = 'MEMORY_REPOSITORY_FAILURE';

  constructor() {
    super('Falha controlada no repositório de memória.');
    this.name = 'MemoryRepositoryError';
  }
}

export interface MemoryRepository {
  listByUsuario(usuarioId: number, query: MemoryRepositoryListQuery): Promise<MemoryRepositoryListResult>;
  findById(usuarioId: number, memoriaId: number): Promise<MemoryRecord | null>;
  findByDedupeKey(usuarioId: number, chaveDedupe: string): Promise<MemoryRecord | null>;
  hasHistoricoForUsuario(usuarioId: number, historicoId: number): Promise<boolean>;
  create(data: MemorySavePersistence): Promise<MemoryRecord>;
  update(usuarioId: number, memoriaId: number, data: MemoryRepositoryUpdate): Promise<MemoryRecord | null>;
  delete(usuarioId: number, memoriaId: number): Promise<boolean>;
}
