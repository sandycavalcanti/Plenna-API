import { createHash } from 'node:crypto';
import { assertMemoryAuthorized, buildMemorySavePersistence, memoryRecordSchema, parseMemoryDeleteInput, parseMemoryInactivateInput, parseMemoryListInput, parseMemorySaveInput, parseMemoryUpdateInput, validateMemoryUpdateAgainstPersistedState, MemoryPolicyError, MEMORY_ORIGINS, MEMORY_STATUS, } from './memory.contracts.js';
import { MemoryRepositoryConflictError } from './memory.repository.js';
export class MemoryServiceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'MemoryServiceError';
        this.code = code;
    }
}
function createLegacyDedupeKey(source) {
    const canonical = JSON.stringify({
        usuario_id: source.usuario_id,
        conteudo: source.conteudo,
        origem: source.origem,
    });
    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
    return `memory:v1:${digest}`;
}
function normalizeDedupeContent(content) {
    return content
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}
function createDeterministicDedupeKey(source) {
    // A origem e o histórico são proveniência, não identidade do mesmo fato.
    // A normalização é deliberadamente conservadora: não faz similaridade
    // semântica aproximada, evitando fundir memórias distintas.
    const canonical = JSON.stringify({
        usuario_id: source.usuario_id,
        conteudo: normalizeDedupeContent(source.conteudo),
    });
    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
    return `memory:v2:${digest}`;
}
function createDedupeLookupKeys(source) {
    return [createDeterministicDedupeKey(source), createLegacyDedupeKey(source)];
}
export class MemoryService {
    constructor(repository, options = {}) {
        this.repository = repository;
        this.now = options.now ?? (() => new Date());
    }
    async list(context, input = {}) {
        const authorization = assertMemoryAuthorized('memory_list', context);
        const filters = parseMemoryListInput(input);
        const offset = this.parseCursor(filters.cursor);
        const page = await this.repositoryCall(() => this.repository.listByUsuario(authorization.usuario_id, {
            status: filters.status,
            origem: filters.origem,
            offset,
            limit: filters.limite,
            agora: this.currentTime(),
        }));
        return {
            itens: page.itens.map((record) => this.assertOwnedRepositoryRecord(record, authorization)),
            proximo_cursor: page.proximo_cursor,
        };
    }
    async save(context, input) {
        const authorization = assertMemoryAuthorized('memory_save', context);
        const parsedInput = parseMemorySaveInput(input, this.currentTime());
        await this.assertHistoryOwnership(authorization, parsedInput.historico_id);
        const dedupeSource = {
            usuario_id: authorization.usuario_id,
            conteudo: parsedInput.conteudo,
            origem: parsedInput.origem,
        };
        const dedupeKey = createDeterministicDedupeKey(dedupeSource);
        let existing = null;
        for (const lookupKey of createDedupeLookupKeys(dedupeSource)) {
            existing = await this.repositoryCall(() => this.repository.findByDedupeKey(authorization.usuario_id, lookupKey));
            if (existing)
                break;
        }
        if (existing && existing.usuario_id === authorization.usuario_id) {
            return {
                memoria: this.assertUsableDuplicate(existing),
                deduplicada: true,
            };
        }
        const persistence = buildMemorySavePersistence(parsedInput, authorization, dedupeKey, this.currentTime());
        try {
            const created = await this.repository.create(persistence);
            return {
                memoria: this.assertOwnedRepositoryRecord(created, authorization),
                deduplicada: false,
            };
        }
        catch (error) {
            if (error instanceof MemoryServiceError) {
                throw error;
            }
            if (error instanceof MemoryRepositoryConflictError) {
                const concurrent = await this.repositoryCall(() => this.repository.findByDedupeKey(authorization.usuario_id, dedupeKey));
                if (concurrent && concurrent.usuario_id === authorization.usuario_id) {
                    return {
                        memoria: this.assertUsableDuplicate(concurrent),
                        deduplicada: true,
                    };
                }
                throw new MemoryServiceError('MEMORY_DUPLICATE', 'A memória já possui um registro conflitante.');
            }
            throw this.persistenceError(error);
        }
    }
    /**
     * Caminho exclusivo do backend para uma decisão automática já validada.
     * As tools continuam exigindo intenção explícita; este método não é
     * exposto ao modelo e exige uma autorização adicional construída pelo
     * serviço de memória automática.
     */
    async saveAutomatic(context, input) {
        const authorization = assertMemoryAuthorized('memory_save', context);
        if (!authorization.pode_escrever_automaticamente) {
            throw new MemoryPolicyError('MEMORY_OPERATION_FORBIDDEN', 'A gravação automática de memória não está autorizada.');
        }
        return this.save(authorization, input);
    }
    async update(context, input) {
        const authorization = assertMemoryAuthorized('memory_update', context);
        const parsedInput = parseMemoryUpdateInput(input, this.currentTime());
        const current = await this.findOwnedMemory(parsedInput.memoria_id, authorization);
        const validatedInput = validateMemoryUpdateAgainstPersistedState(current, parsedInput, this.currentTime());
        await this.assertHistoryOwnership(authorization, validatedInput.historico_id);
        const patch = this.buildUpdatePatch(current, validatedInput, authorization);
        try {
            const updated = await this.repository.update(authorization.usuario_id, current.memoria_id, patch);
            if (!updated) {
                throw new MemoryServiceError('MEMORY_NOT_FOUND', 'A memória solicitada não foi encontrada.');
            }
            return { memoria: this.assertOwnedRepositoryRecord(updated, authorization) };
        }
        catch (error) {
            if (error instanceof MemoryServiceError) {
                throw error;
            }
            if (error instanceof MemoryRepositoryConflictError) {
                throw new MemoryServiceError('MEMORY_DUPLICATE', 'A atualização produziria uma memória duplicada.');
            }
            throw this.persistenceError(error);
        }
    }
    async inactivate(context, input) {
        const authorization = assertMemoryAuthorized('memory_inactivate', context);
        const parsedInput = parseMemoryInactivateInput(input);
        const current = await this.findOwnedMemory(parsedInput.memoria_id, authorization);
        try {
            const updated = await this.repository.update(authorization.usuario_id, current.memoria_id, {
                status: MEMORY_STATUS.INATIVA,
            });
            if (!updated) {
                throw new MemoryServiceError('MEMORY_NOT_FOUND', 'A memória solicitada não foi encontrada.');
            }
            return { memoria: this.assertOwnedRepositoryRecord(updated, authorization) };
        }
        catch (error) {
            if (error instanceof MemoryServiceError) {
                throw error;
            }
            throw this.persistenceError(error);
        }
    }
    async delete(context, input) {
        const authorization = assertMemoryAuthorized('memory_delete', context);
        const parsedInput = parseMemoryDeleteInput(input);
        const current = await this.findOwnedMemory(parsedInput.memoria_id, authorization);
        try {
            const deleted = await this.repository.delete(authorization.usuario_id, current.memoria_id);
            if (!deleted) {
                throw new MemoryServiceError('MEMORY_NOT_FOUND', 'A memória solicitada não foi encontrada.');
            }
            return { memoria_id: current.memoria_id, excluida: true };
        }
        catch (error) {
            if (error instanceof MemoryServiceError) {
                throw error;
            }
            throw this.persistenceError(error);
        }
    }
    currentTime() {
        return new Date(this.now().getTime());
    }
    parseCursor(cursor) {
        if (cursor === undefined) {
            return 0;
        }
        const offset = Number(cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) {
            throw new MemoryServiceError('MEMORY_CURSOR_INVALID', 'O cursor de memória é inválido.');
        }
        return offset;
    }
    async findOwnedMemory(memoriaId, authorization) {
        const record = await this.repositoryCall(() => this.repository.findById(authorization.usuario_id, memoriaId));
        if (!record) {
            throw new MemoryServiceError('MEMORY_NOT_FOUND', 'A memória solicitada não foi encontrada.');
        }
        return this.assertOwnedRepositoryRecord(record, authorization);
    }
    async assertHistoryOwnership(authorization, historicoId) {
        if (historicoId === undefined || historicoId === null) {
            return;
        }
        const belongsToUser = await this.repositoryCall(() => this.repository.hasHistoricoForUsuario(authorization.usuario_id, historicoId));
        if (!belongsToUser) {
            throw new MemoryServiceError('MEMORY_HISTORY_OWNER_MISMATCH', 'O histórico informado não pertence ao usuário autenticado.');
        }
    }
    buildUpdatePatch(current, input, authorization) {
        const patch = {};
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
        const changesDedupeIdentity = input.conteudo !== undefined || input.origem !== undefined;
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
    validateRepositoryRecord(record) {
        const parsed = memoryRecordSchema.safeParse(record);
        if (!parsed.success) {
            throw new MemoryServiceError('MEMORY_PERSISTENCE_FAILED', 'O repositório retornou uma memória inválida.');
        }
        return parsed.data;
    }
    assertUsableDuplicate(record) {
        const validated = this.validateRepositoryRecord(record);
        if (validated.status !== MEMORY_STATUS.ATIVA || this.isExpired(validated, this.currentTime())) {
            throw new MemoryServiceError('MEMORY_DUPLICATE_INACTIVE_OR_EXPIRED', 'A memória equivalente já existe, mas não está disponível para deduplicação ativa.');
        }
        return validated;
    }
    isExpired(record, now) {
        return record.data_expiracao !== null && record.data_expiracao.getTime() <= now.getTime();
    }
    assertOwnedRepositoryRecord(record, authorization) {
        const validated = this.validateRepositoryRecord(record);
        if (validated.usuario_id !== authorization.usuario_id) {
            throw new MemoryServiceError('MEMORY_NOT_FOUND', 'A memória solicitada não foi encontrada.');
        }
        return validated;
    }
    async repositoryCall(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof MemoryPolicyError || error instanceof MemoryServiceError) {
                throw error;
            }
            throw this.persistenceError(error);
        }
    }
    persistenceError(_error) {
        return new MemoryServiceError('MEMORY_PERSISTENCE_FAILED', 'Não foi possível concluir a operação de memória.');
    }
}
