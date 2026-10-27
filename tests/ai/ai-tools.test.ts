import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { executeTool } from '../../src/modules/ai/ai.executor.js';
import { AIToolError, toPublicToolError } from '../../src/modules/ai/ai.errors.js';
import { ToolRegistry } from '../../src/modules/ai/ai.registry.js';

function createEchoRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo_text',
    description: 'Tool simulada para testes.',
    argsSchema: z.object({ texto: z.string().min(1) }).strict(),
    resultSchema: z.object({ usuario_id: z.number(), texto: z.string() }).strict(),
    execute: (args, context) => ({ usuario_id: context.usuario_id, texto: args.texto }),
  });
  return registry;
}

test('registra, localiza e lista somente metadados das tools', () => {
  const registry = createEchoRegistry();

  assert.equal(registry.has('echo_text'), true);
  assert.deepEqual(registry.list(), [{
    name: 'echo_text',
    description: 'Tool simulada para testes.',
  }]);
  assert.equal('execute' in (registry.list()[0] ?? {}), false);
});

test('executa com usuario_id do contexto, nunca dos argumentos', async () => {
  const registry = createEchoRegistry();
  const result = await executeTool(
    registry,
    { name: 'echo_text', arguments: { texto: 'ok' } },
    { usuario_id: 42, requestId: 'req-1' },
  );

  assert.deepEqual(result, { toolName: 'echo_text', result: { usuario_id: 42, texto: 'ok' } });
});

test('rejeita tool desconhecida e argumentos inválidos', async () => {
  const registry = createEchoRegistry();

  await assert.rejects(
    () => executeTool(registry, { name: 'missing_tool', arguments: {} }, { usuario_id: 1 }),
    (error: unknown) => error instanceof AIToolError && error.code === 'TOOL_NOT_FOUND',
  );

  await assert.rejects(
    () => executeTool(registry, { name: 'echo_text', arguments: { texto: 123 } }, { usuario_id: 1 }),
    (error: unknown) => error instanceof AIToolError && error.code === 'TOOL_ARGUMENTS_INVALID',
  );
});

test('bloqueia tentativa de sobrescrever identidade no payload', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'permissive_echo',
    description: 'Tool simulada permissiva.',
    argsSchema: z.object({ texto: z.string() }).passthrough(),
    resultSchema: z.string(),
    execute: (args) => args.texto,
  });

  await assert.rejects(
    () => executeTool(
      registry,
      { name: 'permissive_echo', arguments: { texto: 'ok', userId: 999 } },
      { usuario_id: 42 },
    ),
    (error: unknown) => error instanceof AIToolError && error.code === 'TOOL_ARGUMENTS_INVALID',
  );
});

test('rejeita contexto inválido e resultado fora do contrato', async () => {
  const registry = createEchoRegistry();

  await assert.rejects(
    () => executeTool(registry, { name: 'echo_text', arguments: { texto: 'ok' } }, { usuario_id: 0 }),
    (error: unknown) => error instanceof AIToolError && error.code === 'TOOL_CONTEXT_INVALID',
  );

  const invalidResultRegistry = new ToolRegistry();
  invalidResultRegistry.register({
    name: 'invalid_result',
    description: 'Tool simulada com resultado inválido.',
    argsSchema: z.object({}).strict(),
    resultSchema: z.string(),
    execute: () => ({ secret: 'não deve vazar' } as unknown as string),
  });

  await assert.rejects(
    () => executeTool(invalidResultRegistry, { name: 'invalid_result', arguments: {} }, { usuario_id: 1 }),
    (error: unknown) => error instanceof AIToolError && error.code === 'TOOL_RESULT_INVALID',
  );
});

test('sanitiza falhas internas sem expor detalhes sensíveis', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'failing_tool',
    description: 'Tool simulada com falha.',
    argsSchema: z.object({}).strict(),
    resultSchema: z.string(),
    execute: () => { throw new Error('token-super-secreto'); },
  });

  await assert.rejects(
    () => executeTool(registry, { name: 'failing_tool', arguments: {} }, { usuario_id: 1 }),
    (error: unknown) => {
      const publicError = toPublicToolError(error);
      assert.equal(publicError.code, 'TOOL_EXECUTION_FAILED');
      assert.equal(publicError.message.includes('token-super-secreto'), false);
      return true;
    },
  );
});
