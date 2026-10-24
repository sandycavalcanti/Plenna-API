import type { ToolDefinition } from './ai.contracts.js';
import { AIToolError } from './ai.errors.js';
import { aiToolRegistry, ToolRegistry } from './ai.registry.js';
import type { MemoryAuthorizationContext } from './memory.contracts.js';
import {
  memoryToolContracts,
} from './memory.contracts.js';
import type { MemoryService } from './memory.service.js';

export type MemoryAuthorizationResolver = (
  usuarioId: number,
) => Promise<MemoryAuthorizationContext>;

function requireExplicitWriteIntent(context: { memory_write_intent?: boolean }) {
  if (context.memory_write_intent !== true) {
    throw new AIToolError('TOOL_EXECUTION_FAILED');
  }
}

export function createMemoryToolDefinitions(
  service: MemoryService,
  resolveAuthorization: MemoryAuthorizationResolver,
): ToolDefinition[] {
  return [
    {
      name: 'memory_list',
      description: 'Lista memórias vigentes do usuário autenticado.',
      argsSchema: memoryToolContracts.memory_list.inputSchema,
      resultSchema: memoryToolContracts.memory_list.resultSchema,
      execute: async (args, context) => service.list(
        await resolveAuthorization(context.usuario_id),
        args,
      ),
    },
    {
      name: 'memory_save',
      description: 'Salva uma memória explicitamente autorizada pelo fluxo.',
      argsSchema: memoryToolContracts.memory_save.inputSchema,
      resultSchema: memoryToolContracts.memory_save.resultSchema,
      execute: async (args, context) => {
        requireExplicitWriteIntent(context);
        return service.save(await resolveAuthorization(context.usuario_id), args);
      },
    },
    {
      name: 'memory_update',
      description: 'Atualiza uma memória própria respeitando sua proveniência.',
      argsSchema: memoryToolContracts.memory_update.inputSchema,
      resultSchema: memoryToolContracts.memory_update.resultSchema,
      execute: async (args, context) => {
        requireExplicitWriteIntent(context);
        return service.update(await resolveAuthorization(context.usuario_id), args);
      },
    },
  ];
}

export function registerMemoryTools(
  registry: ToolRegistry = aiToolRegistry,
  service: MemoryService,
  resolveAuthorization: MemoryAuthorizationResolver,
): ToolRegistry {
  for (const definition of createMemoryToolDefinitions(service, resolveAuthorization)) {
    if (!registry.has(definition.name)) {
      registry.register(definition);
    }
  }

  return registry;
}
