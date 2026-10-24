import { z } from 'zod';
import { AIToolError } from './ai.errors.js';
import type { AnyToolDefinition, ToolDefinition, ToolMetadata } from './ai.contracts.js';
import { toolNameSchema } from './ai.contracts.js';

const toolMetadataSchema = z.object({
  name: toolNameSchema,
  description: z.string().trim().min(1).max(240),
});

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { safeParse?: unknown }).safeParse === 'function';
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register<TArguments extends z.ZodTypeAny, TResult>(
    definition: ToolDefinition<TArguments, TResult>,
  ) {
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

  get(name: string) {
    return this.tools.get(name);
  }

  has(name: string) {
    return this.tools.has(name);
  }

  list(): readonly ToolMetadata[] {
    return [...this.tools.values()]
      .map(({ name, description }) => ({ name, description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

/** Ponto único para o catálogo de tools autorizadas do backend. */
export const aiToolRegistry = new ToolRegistry();
