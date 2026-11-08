export class MemoryRepositoryConflictError extends Error {
    constructor() {
        super('Conflito de persistência da memória.');
        this.code = 'MEMORY_REPOSITORY_CONFLICT';
        this.name = 'MemoryRepositoryConflictError';
    }
}
export class MemoryRepositoryError extends Error {
    constructor() {
        super('Falha controlada no repositório de memória.');
        this.code = 'MEMORY_REPOSITORY_FAILURE';
        this.name = 'MemoryRepositoryError';
    }
}
