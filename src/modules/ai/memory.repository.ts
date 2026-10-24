import type {
  MemoryRecord,
  MemorySavePersistence,
  MemoryStatus,
  MemoryOrigin,
} from './memory.contracts.js';

export type MemoryRepositoryUpdate = Partial<Pick<
  MemoryRecord,
  | 'conteudo'
  | 'origem'
  | 'evidencia'
  | 'status'
  | 'historico_id'
  | 'data_expiracao'
  | 'chave_dedupe'
>>;

export type MemoryRepositoryListFilters = {
  status?: MemoryStatus;
  origem?: MemoryOrigin;
};

export class MemoryRepositoryConflictError extends Error {
  readonly code = 'MEMORY_REPOSITORY_CONFLICT';

  constructor() {
    super('Conflito de persistência da memória.');
    this.name = 'MemoryRepositoryConflictError';
  }
}

export interface MemoryRepository {
  listByUsuario(
    usuarioId: number,
    filters?: MemoryRepositoryListFilters,
  ): Promise<MemoryRecord[]>;
  findById(memoriaId: number): Promise<MemoryRecord | null>;
  findByDedupeKey(usuarioId: number, chaveDedupe: string): Promise<MemoryRecord | null>;
  findHistoricoOwner(historicoId: number): Promise<number | null>;
  create(data: MemorySavePersistence): Promise<MemoryRecord>;
  update(memoriaId: number, data: MemoryRepositoryUpdate): Promise<MemoryRecord | null>;
  delete(memoriaId: number): Promise<boolean>;
}
