import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMORY_ORIGINS,
  MEMORY_STATUS,
  MemoryPolicyError,
  type MemoryRecord,
  type MemorySavePersistence,
} from '../../src/modules/ai/memory.contracts.js';
import {
  MemoryRepositoryConflictError,
  type MemoryRepository,
  type MemoryRepositoryListQuery,
  type MemoryRepositoryUpdate,
} from '../../src/modules/ai/memory.repository.js';
import {
  MemoryService,
  MemoryServiceError,
} from '../../src/modules/ai/memory.service.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');

const consentedUser = {
  usuario_id: 42,
  consentimento_memoria_ativo: true,
  pode_ler: true,
  pode_escrever: true,
  pode_excluir: true,
};

const otherUser = {
  usuario_id: 99,
  consentimento_memoria_ativo: true,
  pode_ler: true,
  pode_escrever: true,
  pode_excluir: true,
};

class FakeMemoryRepository implements MemoryRepository {
  private nextId = 1;
  private readonly memories = new Map<number, MemoryRecord>();
  private readonly histories = new Map<number, number>();
  conflictOnNextCreate = false;

  setHistoryOwner(historicoId: number, usuarioId: number): void {
    this.histories.set(historicoId, usuarioId);
  }

  seed(record: MemoryRecord): void {
    this.memories.set(record.memoria_id, this.clone(record));
    this.nextId = Math.max(this.nextId, record.memoria_id + 1);
  }

  count(): number {
    return this.memories.size;
  }

  async listByUsuario(usuarioId: number, query: MemoryRepositoryListQuery) {
    const records = [...this.memories.values()]
      .filter((memory) => memory.usuario_id === usuarioId)
      .filter((memory) => query.status === MEMORY_STATUS.ATIVA
        ? memory.status === MEMORY_STATUS.ATIVA || memory.status === undefined
        : memory.status === query.status)
      .filter((memory) => query.origem === undefined || memory.origem === query.origem)
      .filter((memory) => memory.data_expiracao === null || memory.data_expiracao > query.agora)
      .sort((left, right) => {
        const byDate = right.data_atualizacao.getTime() - left.data_atualizacao.getTime();
        return byDate || right.memoria_id - left.memoria_id;
      });
    const page = records.slice(query.offset, query.offset + query.limit + 1);
    const hasMore = page.length > query.limit;

    return {
      itens: page.slice(0, query.limit).map((memory) => this.clone(memory)),
      proximo_cursor: hasMore ? String(query.offset + query.limit) : null,
    };
  }

  async findById(usuarioId: number, memoriaId: number): Promise<MemoryRecord | null> {
    const memory = this.memories.get(memoriaId);
    return memory && memory.usuario_id === usuarioId ? this.clone(memory) : null;
  }

  async findByDedupeKey(usuarioId: number, chaveDedupe: string): Promise<MemoryRecord | null> {
    const memory = [...this.memories.values()].find(
      (candidate) => candidate.usuario_id === usuarioId
        && candidate.chave_dedupe === chaveDedupe,
    );
    return memory ? this.clone(memory) : null;
  }

  async hasHistoricoForUsuario(usuarioId: number, historicoId: number): Promise<boolean> {
    return this.histories.get(historicoId) === usuarioId;
  }

  async create(data: MemorySavePersistence): Promise<MemoryRecord> {
    const conflict = [...this.memories.values()].some(
      (memory) => memory.usuario_id === data.usuario_id
        && memory.chave_dedupe === data.chave_dedupe,
    );
    if (conflict || this.conflictOnNextCreate) {
      this.conflictOnNextCreate = false;
      if (!conflict) {
        this.seed(this.recordFromPersistence(data));
      }
      throw new MemoryRepositoryConflictError();
    }

    const created = this.recordFromPersistence(data);
    this.seed(created);
    return this.clone(created);
  }

  async update(
    usuarioId: number,
    memoriaId: number,
    data: MemoryRepositoryUpdate,
  ): Promise<MemoryRecord | null> {
    const current = this.memories.get(memoriaId);
    if (!current || current.usuario_id !== usuarioId) {
      return null;
    }

    const updated = { ...current, ...data, data_atualizacao: new Date(NOW) };
    const conflict = [...this.memories.values()].some(
      (memory) => memory.memoria_id !== memoriaId
        && memory.usuario_id === updated.usuario_id
        && updated.chave_dedupe !== null
        && memory.chave_dedupe === updated.chave_dedupe,
    );
    if (conflict) {
      throw new MemoryRepositoryConflictError();
    }

    this.memories.set(memoriaId, this.clone(updated));
    return this.clone(updated);
  }

  async delete(usuarioId: number, memoriaId: number): Promise<boolean> {
    const memory = this.memories.get(memoriaId);
    if (!memory || memory.usuario_id !== usuarioId) {
      return false;
    }
    return this.memories.delete(memoriaId);
  }

  private recordFromPersistence(data: MemorySavePersistence): MemoryRecord {
    const now = new Date(NOW);
    return {
      memoria_id: this.nextId++,
      usuario_id: data.usuario_id,
      conteudo: data.conteudo,
      origem: data.origem,
      status: MEMORY_STATUS.ATIVA,
      chave_dedupe: data.chave_dedupe,
      evidencia: data.evidencia,
      historico_id: data.historico_id,
      data_expiracao: data.data_expiracao,
      data_criacao: now,
      data_atualizacao: now,
    };
  }

  private clone(memory: MemoryRecord): MemoryRecord {
    return {
      ...memory,
      data_criacao: new Date(memory.data_criacao),
      data_atualizacao: new Date(memory.data_atualizacao),
      data_expiracao: memory.data_expiracao ? new Date(memory.data_expiracao) : null,
    };
  }
}

function createService(repository: FakeMemoryRepository): MemoryService {
  return new MemoryService(repository, { now: () => new Date(NOW) });
}

function legacyMemory(memoriaId: number): MemoryRecord {
  return {
    memoria_id: memoriaId,
    usuario_id: 42,
    conteudo: 'Registro anterior ao contrato de proveniência.',
    origem: MEMORY_ORIGINS.DESCONHECIDA,
    status: MEMORY_STATUS.ATIVA,
    chave_dedupe: null,
    evidencia: null,
    historico_id: null,
    data_expiracao: null,
    data_criacao: new Date('2025-01-01T00:00:00.000Z'),
    data_atualizacao: new Date('2025-01-01T00:00:00.000Z'),
  };
}

test('salva e identifica duplicatas com chave determinística por usuário', async () => {
  const repository = new FakeMemoryRepository();
  const service = createService(repository);
  const input = {
    conteudo: 'Prefere revisar o orçamento aos domingos.',
    origem: MEMORY_ORIGINS.DECLARADA,
  };

  const first = await service.save(consentedUser, input);
  const second = await service.save(consentedUser, input);

  assert.equal(first.deduplicada, false);
  assert.equal(second.deduplicada, true);
  assert.equal(first.memoria.chave_dedupe, second.memoria.chave_dedupe);
  assert.equal(repository.count(), 1);
});

test('deduplica memórias idênticas do mesmo usuário em históricos diferentes', async () => {
  const repository = new FakeMemoryRepository();
  repository.setHistoryOwner(10, 42);
  repository.setHistoryOwner(11, 42);
  const service = createService(repository);
  const input = {
    conteudo: 'Prefere receber um resumo semanal.',
    origem: MEMORY_ORIGINS.DECLARADA,
  };

  const first = await service.save(consentedUser, { ...input, historico_id: 10 });
  const second = await service.save(consentedUser, { ...input, historico_id: 11 });

  assert.equal(first.deduplicada, false);
  assert.equal(second.deduplicada, true);
  assert.equal(second.memoria.memoria_id, first.memoria.memoria_id);
  assert.equal(repository.count(), 1);
});

test('não devolve duplicata inativa ou expirada como criação bem-sucedida', async () => {
  const inactiveRepository = new FakeMemoryRepository();
  const inactiveService = createService(inactiveRepository);
  const inactiveInput = {
    conteudo: 'Memória desativada não deve ser reutilizada silenciosamente.',
    origem: MEMORY_ORIGINS.DECLARADA,
  };
  const inactive = await inactiveService.save(consentedUser, inactiveInput);
  await inactiveService.inactivate(consentedUser, { memoria_id: inactive.memoria.memoria_id });

  await assert.rejects(
    () => inactiveService.save(consentedUser, inactiveInput),
    (error: unknown) => error instanceof MemoryServiceError
      && error.code === 'MEMORY_DUPLICATE_INACTIVE_OR_EXPIRED',
  );

  const expiredRepository = new FakeMemoryRepository();
  const expiredService = createService(expiredRepository);
  const expiredInput = {
    conteudo: 'Memória expirada não deve ser reutilizada silenciosamente.',
    origem: MEMORY_ORIGINS.DECLARADA,
  };
  const expired = await expiredService.save(consentedUser, expiredInput);
  await expiredRepository.update(consentedUser.usuario_id, expired.memoria.memoria_id, {
    data_expiracao: new Date('2026-10-23T00:00:00.000Z'),
  });

  await assert.rejects(
    () => expiredService.save(consentedUser, expiredInput),
    (error: unknown) => error instanceof MemoryServiceError
      && error.code === 'MEMORY_DUPLICATE_INACTIVE_OR_EXPIRED',
  );
});

test('não aceita identidade do modelo e não mistura deduplicação entre usuários', async () => {
  const repository = new FakeMemoryRepository();
  const service = createService(repository);
  const input = {
    conteudo: 'Mesma preferência em contas diferentes.',
    origem: MEMORY_ORIGINS.DECLARADA,
  };

  await service.save(consentedUser, input);
  await service.save(otherUser, input);
  assert.equal(repository.count(), 2);

  await assert.rejects(
    () => service.save(consentedUser, { ...input, usuario_id: 99 }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_IDENTITY_FORBIDDEN',
  );
});

test('lista somente o dono, aplica filtros, paginação e remove memórias expiradas', async () => {
  const repository = new FakeMemoryRepository();
  const service = createService(repository);
  repository.seed({
    ...legacyMemory(1),
    conteudo: 'Visível 1',
    origem: MEMORY_ORIGINS.DECLARADA,
    chave_dedupe: 'key-1',
    data_criacao: new Date('2026-10-20T00:00:00.000Z'),
    data_atualizacao: new Date('2026-10-20T00:00:00.000Z'),
  });
  repository.seed({
    ...legacyMemory(2),
    conteudo: 'Expirada',
    origem: MEMORY_ORIGINS.DECLARADA,
    chave_dedupe: 'key-2',
    data_expiracao: new Date('2026-10-23T00:00:00.000Z'),
  });
  repository.seed({
    ...legacyMemory(3),
    conteudo: 'Visível 2',
    origem: MEMORY_ORIGINS.DECLARADA,
    chave_dedupe: 'key-3',
    data_criacao: new Date('2026-10-21T00:00:00.000Z'),
    data_atualizacao: new Date('2026-10-21T00:00:00.000Z'),
  });
  repository.seed({ ...legacyMemory(4), usuario_id: 99, conteudo: 'Outro usuário' });

  const firstPage = await service.list(consentedUser, { limite: 1 });
  const secondPage = await service.list(consentedUser, {
    limite: 1,
    cursor: firstPage.proximo_cursor ?? undefined,
  });

  assert.deepEqual(firstPage.itens.map((item) => item.conteudo), ['Visível 2']);
  assert.deepEqual(secondPage.itens.map((item) => item.conteudo), ['Visível 1']);
  assert.equal(secondPage.proximo_cursor, null);
});

test('valida ownership do histórico antes de criar ou atualizar', async () => {
  const repository = new FakeMemoryRepository();
  repository.setHistoryOwner(10, 42);
  repository.setHistoryOwner(11, 42);
  repository.setHistoryOwner(20, 99);
  const service = createService(repository);

  await assert.rejects(
    () => service.save(consentedUser, {
      conteudo: 'Histórico de outro usuário.',
      origem: MEMORY_ORIGINS.DECLARADA,
      historico_id: 20,
    }),
    (error: unknown) => error instanceof MemoryServiceError && error.code === 'MEMORY_HISTORY_OWNER_MISMATCH',
  );

  const saved = await service.save(consentedUser, {
    conteudo: 'Histórico próprio.',
    origem: MEMORY_ORIGINS.DECLARADA,
    historico_id: 10,
  });
  const duplicateFromAnotherHistory = await service.save(consentedUser, {
    conteudo: 'Histórico próprio.',
    origem: MEMORY_ORIGINS.DECLARADA,
    historico_id: 11,
  });
  assert.equal(duplicateFromAnotherHistory.deduplicada, true);
  await assert.rejects(
    () => service.update(consentedUser, {
      memoria_id: saved.memoria.memoria_id,
      historico_id: 20,
    }),
    (error: unknown) => error instanceof MemoryServiceError && error.code === 'MEMORY_HISTORY_OWNER_MISMATCH',
  );
});

test('exige consentimento para leitura e escrita, mas permite exclusão própria após revogação', async () => {
  const repository = new FakeMemoryRepository();
  const service = createService(repository);
  const saved = await service.save(consentedUser, {
    conteudo: 'Memória para exclusão.',
    origem: MEMORY_ORIGINS.DECLARADA,
  });
  const revoked = {
    ...consentedUser,
    consentimento_memoria_ativo: false,
    pode_ler: false,
    pode_escrever: false,
    pode_excluir: true,
  };

  await assert.rejects(
    () => service.list(revoked, {}),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_CONSENT_REQUIRED',
  );
  await assert.rejects(
    () => service.update(revoked, { memoria_id: saved.memoria.memoria_id, status: MEMORY_STATUS.INATIVA }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_CONSENT_REQUIRED',
  );

  const deleted = await service.delete(revoked, { memoria_id: saved.memoria.memoria_id });
  assert.deepEqual(deleted, { memoria_id: saved.memoria.memoria_id, excluida: true });
  assert.equal(repository.count(), 0);
});

test('preserva evidência de inferências e trata atualização de legado explicitamente', async () => {
  const repository = new FakeMemoryRepository();
  const service = createService(repository);
  const saved = await service.save(consentedUser, {
    conteudo: 'Preferência inferida com base declarada.',
    origem: MEMORY_ORIGINS.INFERIDA,
    evidencia: 'Declaração explícita registrada no contexto permitido.',
  });

  await assert.rejects(
    () => service.update(consentedUser, {
      memoria_id: saved.memoria.memoria_id,
      conteudo: 'Novo conteúdo incompatível.',
    }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_INFERRED_CONTENT_IMMUTABLE',
  );

  const inactive = await service.inactivate(consentedUser, {
    memoria_id: saved.memoria.memoria_id,
  });
  assert.equal(inactive.memoria.evidencia, saved.memoria.evidencia);

  const legacy = legacyMemory(50);
  repository.seed(legacy);
  await assert.rejects(
    () => service.update(consentedUser, {
      memoria_id: legacy.memoria_id,
      conteudo: 'Alteração sem origem.',
    }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_LEGACY_PROVENANCE_REQUIRED',
  );

  const declared = await service.update(consentedUser, {
    memoria_id: legacy.memoria_id,
    origem: MEMORY_ORIGINS.DECLARADA,
    conteudo: 'Alteração declarada.',
  });
  assert.equal(declared.memoria.origem, MEMORY_ORIGINS.DECLARADA);
  assert.notEqual(declared.memoria.chave_dedupe, null);
});

test('trata conflito concorrente como deduplicação após índice único', async () => {
  const repository = new FakeMemoryRepository();
  repository.conflictOnNextCreate = true;
  const service = createService(repository);

  const result = await service.save(consentedUser, {
    conteudo: 'Memória concorrente.',
    origem: MEMORY_ORIGINS.DECLARADA,
  });

  assert.equal(result.deduplicada, true);
  assert.equal(repository.count(), 1);
});

test('não permite acesso, alteração ou exclusão de memória de outro usuário', async () => {
  const repository = new FakeMemoryRepository();
  const service = createService(repository);
  const saved = await service.save(otherUser, {
    conteudo: 'Privado de outro usuário.',
    origem: MEMORY_ORIGINS.DECLARADA,
  });

  for (const operation of [
    () => service.update(consentedUser, { memoria_id: saved.memoria.memoria_id, status: MEMORY_STATUS.INATIVA }),
    () => service.delete(consentedUser, { memoria_id: saved.memoria.memoria_id }),
  ]) {
    await assert.rejects(
      operation,
      (error: unknown) => error instanceof MemoryServiceError && error.code === 'MEMORY_NOT_FOUND',
    );
  }
});

