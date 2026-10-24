import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTool } from '../../src/modules/ai/ai.executor.js';
import { ToolRegistry } from '../../src/modules/ai/ai.registry.js';
import { MEMORY_ORIGINS, MEMORY_STATUS } from '../../src/modules/ai/memory.contracts.js';
import { createMemoryToolDefinitions, registerMemoryTools } from '../../src/modules/ai/memory.tools.js';
import type { MemoryService } from '../../src/modules/ai/memory.service.js';
import { consentimentoCodigoSchema } from '../../src/modules/consentimento/consentimento.schemas.js';

const record = {
  memoria_id: 1,
  usuario_id: 42,
  conteudo: 'Preferência declarada.',
  origem: MEMORY_ORIGINS.DECLARADA,
  status: MEMORY_STATUS.ATIVA,
  chave_dedupe: 'memory:v1:test',
  evidencia: null,
  historico_id: null,
  data_expiracao: null,
  data_criacao: new Date('2026-10-24T12:00:00.000Z'),
  data_atualizacao: new Date('2026-10-24T12:00:00.000Z'),
};

function fakeService(calls: Array<{ operation: string; userId: number; args: unknown }>) {
  return {
    list: async (context: { usuario_id: number }, args: unknown) => {
      calls.push({ operation: 'list', userId: context.usuario_id, args });
      return { itens: [], proximo_cursor: null };
    },
    save: async (context: { usuario_id: number }, args: unknown) => {
      calls.push({ operation: 'save', userId: context.usuario_id, args });
      return { memoria: record, deduplicada: false };
    },
    update: async (context: { usuario_id: number }, args: unknown) => {
      calls.push({ operation: 'update', userId: context.usuario_id, args });
      return { memoria: record };
    },
  } as unknown as MemoryService;
}

test('registra as três tools de memória uma única vez', () => {
  const registry = new ToolRegistry();
  const service = fakeService([]);
  const resolver = async () => ({
    usuario_id: 42,
    consentimento_memoria_ativo: true,
    pode_ler: true,
    pode_escrever: true,
    pode_excluir: true,
  });

  registerMemoryTools(registry, service, resolver);
  registerMemoryTools(registry, service, resolver);

  assert.deepEqual(registry.list().map((tool) => tool.name), [
    'memory_list',
    'memory_save',
    'memory_update',
  ]);
});

test('executa a tool com identidade e autorização resolvidas no backend', async () => {
  const calls: Array<{ operation: string; userId: number; args: unknown }> = [];
  const resolvedUsers: number[] = [];
  const registry = new ToolRegistry();
  registerMemoryTools(
    registry,
    fakeService(calls),
    async (userId) => {
      resolvedUsers.push(userId);
      return {
        usuario_id: userId,
        consentimento_memoria_ativo: true,
        pode_ler: true,
        pode_escrever: true,
        pode_excluir: true,
      };
    },
  );

  const result = await executeTool(
    registry,
    { name: 'memory_list', arguments: { limite: 5 } },
    { usuario_id: 42 },
  );

  assert.deepEqual(result.result, { itens: [], proximo_cursor: null });
  assert.deepEqual(resolvedUsers, [42]);
  assert.equal(calls[0]?.userId, 42);
});

test('rejeita identidade fornecida pelo modelo antes da execução', async () => {
  const registry = new ToolRegistry();
  registerMemoryTools(registry, fakeService([]), async () => ({
    usuario_id: 42,
    consentimento_memoria_ativo: true,
    pode_ler: true,
    pode_escrever: true,
    pode_excluir: true,
  }));

  await assert.rejects(
    () => executeTool(
      registry,
      { name: 'memory_save', arguments: {
        usuario_id: 99,
        conteudo: 'Não deve executar.',
        origem: MEMORY_ORIGINS.DECLARADA,
      } },
      { usuario_id: 42 },
    ),
    { code: 'TOOL_ARGUMENTS_INVALID' },
  );
});

test('valida argumentos pelo contrato Zod da tool', async () => {
  const registry = new ToolRegistry();
  registerMemoryTools(registry, fakeService([]), async () => ({
    usuario_id: 42,
    consentimento_memoria_ativo: true,
    pode_ler: true,
    pode_escrever: true,
    pode_excluir: true,
  }));

  await assert.rejects(
    () => executeTool(registry, { name: 'memory_list', arguments: { limite: 0 } }, { usuario_id: 42 }),
    { code: 'TOOL_ARGUMENTS_INVALID' },
  );
});

test('aceita IA_MEMORIA como consentimento específico', () => {
  assert.equal(consentimentoCodigoSchema.parse('IA_MEMORIA'), 'IA_MEMORIA');
});
