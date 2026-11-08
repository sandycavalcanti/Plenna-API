import { z } from 'zod';
import { AIToolError } from './ai.errors.js';
import { toolNameSchema } from './ai.contracts.js';
const toolMetadataSchema = z.object({
    name: toolNameSchema,
    description: z.string().trim().min(1).max(240),
});
function isZodSchema(value) {
    return typeof value === 'object'
        && value !== null
        && typeof value.safeParse === 'function';
}
export class ToolRegistry {
    constructor() {
        this.tools = new Map();
    }
    register(definition) {
        const metadata = toolMetadataSchema.safeParse({
            name: definition?.name,
            description: definition?.description,
        });
        if (!metadata.success
            || !isZodSchema(definition?.argsSchema)
            || !isZodSchema(definition?.resultSchema)
            || typeof definition?.execute !== 'function') {
            throw new AIToolError('TOOL_REGISTRATION_INVALID');
        }
        if (this.tools.has(metadata.data.name)) {
            throw new AIToolError('TOOL_ALREADY_REGISTERED');
        }
        this.tools.set(metadata.data.name, Object.freeze({
            ...definition,
            name: metadata.data.name,
            description: metadata.data.description,
        }));
        return this;
    }
    get(name) {
        return this.tools.get(name);
    }
    has(name) {
        return this.tools.has(name);
    }
    list() {
        return [...this.tools.values()]
            .map(({ name, description }) => ({ name, description }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }
    /** Definições completas para adapters de provider; não é um contrato HTTP. */
    definitions() {
        return [...this.tools.values()]
            .sort((left, right) => left.name.localeCompare(right.name));
    }
}
/** Ponto único para o catálogo de tools autorizadas do backend. */
export const aiToolRegistry = new ToolRegistry();
