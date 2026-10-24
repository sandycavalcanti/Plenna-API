import { createHash } from 'node:crypto';
import {
  assertMemoryAuthorized,
  buildMemorySavePersistence,
  memoryRecordSchema,
  parseMemoryDeleteInput,
  parseMemoryInactivateInput,
  parseMemoryListInput,
  parseMemorySaveInput,
  parseMemoryUpdateInput,
  validateMemoryUpdateAgainstPersistedState,
  MemoryPolicyError,
  MEMORY_ORIGINS,
  MEMORY_STATUS,
} from './memory.contracts.js';
import type {
  MemoryAuthorizationContext,
  MemoryDeleteResult,
  MemoryInactivateResult,
  MemoryListInput,
  MemoryListResult,
  MemoryRecord,
  MemorySaveResult,
  MemoryUpdateInput,
  MemoryUpdateResult,
} from './memory.contracts.js';
import {
  MemoryRepositoryConflictError,
  type MemoryRepository,
  type MemoryRepositoryUpdate,
} from './memory.repository.js';

export type MemoryServiceErrorCode =
  | 'MEMORY_CURSOR_INVALID'
  | 'MEMORY_DUPLICATE'
  | 'MEMORY_DUPLICATE_INACTIVE_OR_EXPIRED'
  | 'MEMORY_HISTORY_NOT_FOUND'
  | 'MEMORY_HISTORY_OWNER_MISMATCH'
  | 'MEMORY_NOT_FOUND'
  | 'MEMORY_PERSISTENCE_FAILED';

export class MemoryServiceError extends Error {
  readonly code: MemoryServiceErrorCode;

  constructor(code: MemoryServiceErrorCode, message: string) {
    super(message);
    this.name = 'MemoryServiceError';
    this.code = code;
  }
}

export type MemoryServiceOptions = {
  now?: () => Date;
};

type MemoryDedupeSource = {
  usuario_id: number;
  conteudo: string;
  origem: string;
};

function createDeterministicDedupeKey(source: MemoryDedupeSource): string {
  const canonical = JSON.stringify({
    usuario_id: source.usuario_id,
    conteudo: source.conteudo,
    origem: source.origem,
  });
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `memory:v1:${digest}`;
}

export class MemoryService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: MemoryRepository,
    options: MemoryServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async list(context: unknown, input: unknown = {}): Promise<MemoryListResult> {
    const authorization = assertMemoryAuthorized('memory_list', context);
    const filters = parseMemoryListInput(input);
    const offset = this.parseCursor(filters.cursor);
    const page = await this.repositoryCall(() => (
      this.repository.listByUsuario(authorization.usuario_id, {
        status: filters.status,
        origem: filters.origem,
        offset,
        limit: filters.limite,
        agora: this.currentTime(),
      })
    ));

    return {
      itens: page.itens.map((record) => this.assertOwnedRepositoryRecord(record, authorization)),
      proximo_cursor: page.proximo_cursor,
    };
  }

  async save(context: unknown, input: unknown): Promise<MemorySaveResult> {
    const authorization = assertMemoryAuthorized('memory_save', context);
    const parsedInput = parseMemorySaveInput(input, this.currentTime());
    await this.assertHistoryOwnership(authorization, parsedInput.historico_id);

    const dedupeKey = createDeterministicDedupeKey({
      usuario_id: authorization.usuario_id,
      conteudo: parsedInput.conteudo,
      origem: parsedInput.origem,
    });
    const existing = await this.repositoryCall(() => (
      this.repository.findByDedupeKey(authorization.usuario_id, dedupeKey)
    ));

    if (existing && existing.usuario_id === authorization.usuario_id) {
      return {
        memoria: this.assertUsableDuplicate(existing),
        deduplicada: true,
      };
    }

    const persistence = buildMemorySavePersistence(
      parsedInput,
      authorization,
      dedupeKey,
      this.currentTime(),
    );

    try {
      const created = await this.repository.create(persistence);
      return {
        memoria: this.assertOwnedRepositoryRecord(created, authorization),
        deduplicada: false,
      };
    } catch (error) {
      if (error instanceof MemoryServiceError) {
        throw error;
      }

      if (error instanceof MemoryRepositoryConflictError) {
        const concurrent = await this.repositoryCall(() => (
          this.repository.findByDedupeKey(authorization.usuario_id, dedupeKey)
        ));

        if (concurrent && concurrent.usuario_id === authorization.usuario_id) {
          return {
            memoria: this.assertUsableDuplicate(concurrent),
            deduplicada: true,
          };
        }

        throw new MemoryServiceError(
          'MEMORY_DUPLICATE',
          'A memória já possui um registro conflitante.',
        );
      }

      throw this.persistenceError(error);
    }
  }

  async update(context: unknown, input: unknown): Promise<MemoryUpdateResult> {
    const authorization = assertMemoryAuthorized('memory_update', context);
    const parsedInput = parseMemoryUpdateInput(input, this.currentTime());
    const current = await this.findOwnedMemory(parsedInput.memoria_id, authorization);
    const validatedInput = validateMemoryUpdateAgainstPersistedState(
      current,
      parsedInput,
      this.currentTime(),
    );
    await this.assertHistoryOwnership(authorization, validatedInput.historico_id);

    const patch = this.buildUpdatePatch(current, validatedInput, authorization);

    try {
      const updated = await this.repository.update(
        authorization.usuario_id,
        current.memoria_id,
        patch,
      );
      if (!updated) {
        throw new MemoryServiceError(
          'MEMORY_NOT_FOUND',
          'A memória solicitada não foi encontrada.',
        );
      }

      return { memoria: this.assertOwnedRepositoryRecord(updated, authorization) };
    } catch (error) {
      if (error instanceof MemoryServiceError) {
        throw error;
      }

      if (error instanceof MemoryRepositoryConflictError) {
        throw new MemoryServiceError(
          'MEMORY_DUPLICATE',
          'A atualização produziria uma memória duplicada.',
        );
      }

      throw this.persistenceError(error);
    }
  }

  async inactivate(context: unknown, input: unknown): Promise<MemoryInactivateResult> {
    const authorization = assertMemoryAuthorized('memory_inactivate', context);
    const parsedInput = parseMemoryInactivateInput(input);
    const current = await this.findOwnedMemory(parsedInput.memoria_id, authorization);

    try {
      const updated = await this.repository.update(authorization.usuario_id, current.memoria_id, {
        status: MEMORY_STATUS.INATIVA,
      });
      if (!updated) {
        throw new MemoryServiceError(
          'MEMORY_NOT_FOUND',
          'A memória solicitada não foi encontrada.',
        );
      }

      return { memoria: this.assertOwnedRepositoryRecord(updated, authorization) };
    } catch (error) {
      if (error instanceof MemoryServiceError) {
        throw error;
      }
      throw this.persistenceError(error);
    }
  }

  async delete(context: unknown, input: unknown): Promise<MemoryDeleteResult> {
    const authorization = assertMemoryAuthorized('memory_delete', context);
    const parsedInput = parseMemoryDeleteInput(input);
    const current = await this.findOwnedMemory(parsedInput.memoria_id, authorization);

    try {
      const deleted = await this.repository.delete(authorization.usuario_id, current.memoria_id);
      if (!deleted) {
        throw new MemoryServiceError(
          'MEMORY_NOT_FOUND',
          'A memória solicitada não foi encontrada.',
        );
      }

      return { memoria_id: current.memoria_id, excluida: true };
    } catch (error) {
      if (error instanceof MemoryServiceError) {
        throw error;
      }
      throw this.persistenceError(error);
    }
  }

  private currentTime(): Date {
    return new Date(this.now().getTime());
  }

  private parseCursor(cursor: MemoryListInput['cursor']): number {
    if (cursor === undefined) {
      return 0;
    }

    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new MemoryServiceError(
        'MEMORY_CURSOR_INVALID',
        'O cursor de memória é inválido.',
      );
    }

    return offset;
  }

  private async findOwnedMemory(
    memoriaId: number,
    authorization: MemoryAuthorizationContext,
  ): Promise<MemoryRecord> {
    const record = await this.repositoryCall(() => (
      this.repository.findById(authorization.usuario_id, memoriaId)
    ));
    if (!record) {
      throw new MemoryServiceError(
        'MEMORY_NOT_FOUND',
        'A memória solicitada não foi encontrada.',
      );
    }

    return this.assertOwnedRepositoryRecord(record, authorization);
  }

  private async assertHistoryOwnership(
    authorization: MemoryAuthorizationContext,
    historicoId: number | null | undefined,
  ): Promise<void> {
    if (historicoId === undefined || historicoId === null) {
      return;
    }

    const belongsToUser = await this.repositoryCall(() => (
      this.repository.hasHistoricoForUsuario(authorization.usuario_id, historicoId)
    ));
    if (!belongsToUser) {
      throw new MemoryServiceError(
        'MEMORY_HISTORY_OWNER_MISMATCH',
        'O histórico informado não pertence ao usuário autenticado.',
      );
    }
  }

  private buildUpdatePatch(
    current: MemoryRecord,
    input: MemoryUpdateInput,
    authorization: MemoryAuthorizationContext,
  ): MemoryRepositoryUpdate {
    const patch: MemoryRepositoryUpdate = {};

    if (input.conteudo !== undefined) {
      patch.conteudo = input.conteudo;
    }
    if (input.origem !== undefined) {
      patch.origem = input.origem;
    }
    if (input.evidencia !== undefined) {
      patch.evidencia = input.evidencia;
    }
    if (input.historico_id !== undefined) {
      patch.historico_id = input.historico_id;
    }
    if (input.data_expiracao !== undefined) {
      patch.data_expiracao = input.data_expiracao;
    }
    if (input.status !== undefined) {
      patch.status = input.status;
    }

    const changesDedupeIdentity = input.conteudo !== undefined
      || input.origem !== undefined;
    if (changesDedupeIdentity) {
      const nextOrigin = input.origem ?? current.origem;
      if (nextOrigin !== MEMORY_ORIGINS.DESCONHECIDA) {
        patch.chave_dedupe = createDeterministicDedupeKey({
          usuario_id: authorization.usuario_id,
          conteudo: input.conteudo ?? current.conteudo,
          origem: nextOrigin,
        });
      }
    }

    return patch;
  }

  private validateRepositoryRecord(record: MemoryRecord): MemoryRecord {
    const parsed = memoryRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new MemoryServiceError(
        'MEMORY_PERSISTENCE_FAILED',
        'O repositório retornou uma memória inválida.',
      );
    }

    return parsed.data;
  }

  private assertUsableDuplicate(record: MemoryRecord): MemoryRecord {
    const validated = this.validateRepositoryRecord(record);
    if (
      validated.status !== MEMORY_STATUS.ATIVA
      || this.isExpired(validated, this.currentTime())
    ) {
      throw new MemoryServiceError(
        'MEMORY_DUPLICATE_INACTIVE_OR_EXPIRED',
        'A memória equivalente já existe, mas não está disponível para deduplicação ativa.',
      );
    }

    return validated;
  }

  private isExpired(record: MemoryRecord, now: Date): boolean {
    return record.data_expiracao !== null
      && record.data_expiracao.getTime() <= now.getTime();
  }

  private assertOwnedRepositoryRecord(
    record: MemoryRecord,
    authorization: MemoryAuthorizationContext,
  ): MemoryRecord {
    const validated = this.validateRepositoryRecord(record);
    if (validated.usuario_id !== authorization.usuario_id) {
      throw new MemoryServiceError(
        'MEMORY_NOT_FOUND',
        'A memória solicitada não foi encontrada.',
      );
    }

    return validated;
  }

  private async repositoryCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MemoryPolicyError || error instanceof MemoryServiceError) {
        throw error;
      }
      throw this.persistenceError(error);
    }
  }

  private persistenceError(_error: unknown): MemoryServiceError {
    return new MemoryServiceError(
      'MEMORY_PERSISTENCE_FAILED',
      'Não foi possível concluir a operação de memória.',
    );
  }
}
