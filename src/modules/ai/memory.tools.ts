import type { ToolDefinition } from './ai.contracts.js';
import { AIToolError } from './ai.errors.js';
import { aiToolRegistry, ToolRegistry } from './ai.registry.js';
import type { MemoryAuthorizationContext } from './memory.contracts.js';
import {
  memoryToolContracts,
} from './memory.contracts.js';
import type { MemoryService } from './memory.service.js';
import type { AutomaticMemoryService } from './memory.automatic.js';

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

/**
 * Tool visível somente na composição do chatbot. Ela reaproveita a rodada
 * principal do provider; não inicia uma segunda chamada de IA.
 */
export function createAutomaticMemoryToolDefinition(
  service: AutomaticMemoryService,
): ToolDefinition {
  return {
    name: 'memory_automatic_candidate',
    description: 'Propõe uma memória duradoura baseada na mensagem atual. Use somente para preferências, objetivos ou hábitos úteis no futuro, com evidência curta; não use para comentários passageiros, compras isoladas, segredos ou mensagens inteiras.',
    argsSchema: memoryToolContracts.memory_automatic_candidate.inputSchema,
    resultSchema: memoryToolContracts.memory_automatic_candidate.resultSchema,
    execute: async (args, context) => {
      if (
        context.memory_automatic_enabled !== true
        || !context.historico_id
        || !context.mensagem_atual
      ) {
        return { status: 'SEM_CANDIDATO' as const };
      }

      const result = await service.saveCandidate({
        usuario_id: context.usuario_id,
        historico_id: context.historico_id,
        mensagem: context.mensagem_atual,
        candidato: args,
        explicitWriteIntent: context.memory_write_intent,
      });

      if (result.status === 'SALVA' || result.status === 'DUPLICADA') {
        return { status: result.status };
      }
      if (result.status === 'CONSENTIMENTO_INATIVO' || result.status === 'OPTOUT') {
        return { status: result.status };
      }
      if (result.status === 'FALHA') return { status: 'FALHA' as const };
      return { status: 'CANDIDATO_INVALIDO' as const };
    },
  };
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
