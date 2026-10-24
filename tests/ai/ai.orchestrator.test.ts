import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { AIOrchestrator } from '../../src/modules/ai/ai.orchestrator.js';
import { AIOrchestrationError } from '../../src/modules/ai/ai.errors.js';
import { ToolRegistry } from '../../src/modules/ai/ai.registry.js';
import type { AIProvider } from '../../src/modules/email/ai-provider.js';

const context = { usuario_id: 42 };
const argsSchema = z.object({ valor: z.string().min(1) }).strict();
const resultSchema = z.object({ eco: z.string() }).strict();

function registryWithEcho(calls: unknown[] = []) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'test_echo',
    description: 'Tool de teste que apenas devolve o valor recebido.',
    argsSchema,
    resultSchema,
    execute: async (args, executionContext) => {
      calls.push({ args, usuario_id: executionContext.usuario_id });
      return { eco: args.valor };
    },
  });
  return registry;
}

function toolCall(id: string, name = 'test_echo', args: any = { valor: 'ok' }) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } };
}

function providerWithToolRounds(responses: any[]): AIProvider {
  let index = 0;
  return {
    classifyEmail: async () => ({ classificacao: 'IGNORAR' as const }),
    suggestCategory: async () => ({ categoryId: null }),
    chat: async () => 'fallback',
    chatWithTools: async () => responses[Math.min(index++, responses.length - 1)],
  };
}

test('executa uma tool pelo registry e preserva id no retorno ao provider', async () => {
  const calls: unknown[] = [];
  const providerCalls: any[] = [];
  const provider = providerWithToolRounds([
    { content: '', tool_calls: [toolCall('call-1')] },
    { content: 'Resposta baseada no resultado.', tool_calls: [] },
  ]);
  const original = provider.chatWithTools!;
  provider.chatWithTools = async (messages, tools) => {
    providerCalls.push({ messages, tools });
    return original(messages, tools);
  };

  const result = await new AIOrchestrator(registryWithEcho(calls), {
    maxCalls: 4, maxRounds: 3, timeoutMs: 1_000, toolTimeoutMs: 100, maxToolResultChars: 2_000,
  }).run(provider, [{ role: 'user', content: 'teste' }], context);

  assert.equal(result.text, 'Resposta baseada no resultado.');
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(calls, [{ args: { valor: 'ok' }, usuario_id: 42 }]);
  assert.equal(providerCalls[1].messages.at(-1).role, 'tool');
  assert.equal(providerCalls[1].messages.at(-1).tool_call_id, 'call-1');
  assert.equal(providerCalls[0].tools[0].function.name, 'test_echo');
  assert.equal(providerCalls[0].tools[0].function.parameters.additionalProperties, false);
});

test('permite múltiplas tools sequenciais e não envia identidade nos argumentos', async () => {
  const calls: unknown[] = [];
  const result = await new AIOrchestrator(registryWithEcho(calls), {
    maxCalls: 4, maxRounds: 3, timeoutMs: 1_000, toolTimeoutMs: 100, maxToolResultChars: 2_000,
  }).run(providerWithToolRounds([
    { content: '', tool_calls: [toolCall('a', 'test_echo', { valor: 'um' }), toolCall('b', 'test_echo', { valor: 'dois' })] },
    { content: 'Consolidei os dois resultados.', tool_calls: [] },
  ]), [{ role: 'user', content: 'duas consultas' }], context);

  assert.equal(result.toolCalls, 2);
  assert.deepEqual(calls, [
    { args: { valor: 'um' }, usuario_id: 42 },
    { args: { valor: 'dois' }, usuario_id: 42 },
  ]);
});

test('converte tool desconhecida e JSON inválido em resultados seguros para o modelo', async () => {
  const provider = providerWithToolRounds([
    { content: '', tool_calls: [toolCall('unknown', 'not_registered'), { id: 'bad-json', type: 'function', function: { name: 'test_echo', arguments: '{' } }] },
    { content: 'Não foi possível consultar esses dados.', tool_calls: [] },
  ]);
  const seen: any[] = [];
  const original = provider.chatWithTools!;
  provider.chatWithTools = async (messages, tools) => {
    const response = await original(messages, tools);
    seen.push(messages);
    return response;
  };

  await new AIOrchestrator(registryWithEcho(), {
    maxCalls: 4, maxRounds: 3, timeoutMs: 1_000, toolTimeoutMs: 100, maxToolResultChars: 2_000,
  }).run(provider, [{ role: 'user', content: 'consulta' }], context);

  const toolMessages = seen[1].filter((message: any) => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.match(toolMessages[0].content, /TOOL_NOT_FOUND/);
  assert.match(toolMessages[1].content, /TOOL_ARGUMENTS_INVALID/);
});

test('impõe limites de chamadas e rodadas', async () => {
  await assert.rejects(
    () => new AIOrchestrator(registryWithEcho(), { maxCalls: 1, maxRounds: 3, timeoutMs: 1_000, toolTimeoutMs: 100, maxToolResultChars: 2_000 }).run(
      providerWithToolRounds([{ content: '', tool_calls: [toolCall('a'), toolCall('b')] }]),
      [{ role: 'user', content: 'limite' }], context,
    ),
    (error: any) => error instanceof AIOrchestrationError && error.code === 'AI_TOOL_CALL_LIMIT',
  );

  await assert.rejects(
    () => new AIOrchestrator(registryWithEcho(), { maxCalls: 8, maxRounds: 2, timeoutMs: 1_000, toolTimeoutMs: 100, maxToolResultChars: 2_000 }).run(
      providerWithToolRounds([{ content: '', tool_calls: [toolCall('loop')] }]),
      [{ role: 'user', content: 'loop' }], context,
    ),
    (error: any) => error instanceof AIOrchestrationError && error.code === 'AI_TOOL_ROUND_LIMIT',
  );
});

test('interrompe provider ou tool que excede o timeout e limita resultados', async () => {
  const slowRegistry = new ToolRegistry();
  slowRegistry.register({
    name: 'slow_tool',
    description: 'Tool lenta de teste.',
    argsSchema: z.object({}).strict(),
    resultSchema: z.object({ ok: z.boolean() }).strict(),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ok: true };
    },
  });

  const slowMessages: any[] = [];
  const slowProvider = providerWithToolRounds([
    { content: '', tool_calls: [toolCall('slow', 'slow_tool', {})] },
    { content: 'Tool lenta tratada com segurança.', tool_calls: [] },
  ]);
  const slowChatWithTools = slowProvider.chatWithTools!;
  slowProvider.chatWithTools = async (messages, tools) => {
    slowMessages.push(messages);
    return slowChatWithTools(messages, tools);
  };
  const slowResult = await new AIOrchestrator(slowRegistry, {
    maxCalls: 1, maxRounds: 2, timeoutMs: 100, toolTimeoutMs: 5, maxToolResultChars: 100,
  }).run(slowProvider, [{ role: 'user', content: 'timeout' }], context);
  assert.equal(slowResult.text, 'Tool lenta tratada com segurança.');
  assert.match(slowMessages[1].at(-1).content, /TOOL_EXECUTION_FAILED/);

  const providerTimeout: AIProvider = {
    ...providerWithToolRounds([]),
    chatWithTools: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { content: 'tarde demais', tool_calls: [] };
    },
  };
  await assert.rejects(
    () => new AIOrchestrator(slowRegistry, {
      maxCalls: 1, maxRounds: 2, timeoutMs: 5, toolTimeoutMs: 50, maxToolResultChars: 100,
    }).run(providerTimeout, [{ role: 'user', content: 'provider timeout' }], context),
    (error: any) => error instanceof AIOrchestrationError && error.code === 'AI_TOOL_TIMEOUT',
  );

  const largeRegistry = new ToolRegistry();
  largeRegistry.register({
    name: 'large_tool',
    description: 'Tool com resultado grande de teste.',
    argsSchema: z.object({}).strict(),
    resultSchema: z.object({ texto: z.string() }).strict(),
    execute: async () => ({ texto: 'x'.repeat(200) }),
  });
  const seen: any[] = [];
  const provider = providerWithToolRounds([
    { content: '', tool_calls: [toolCall('large', 'large_tool', {})] },
    { content: 'Resultado grande rejeitado.', tool_calls: [] },
  ]);
  const original = provider.chatWithTools!;
  provider.chatWithTools = async (messages, tools) => {
    seen.push(messages);
    return original(messages, tools);
  };
  await new AIOrchestrator(largeRegistry, {
    maxCalls: 1, maxRounds: 2, timeoutMs: 100, toolTimeoutMs: 50, maxToolResultChars: 20,
  }).run(provider, [{ role: 'user', content: 'resultado grande' }], context);
  assert.match(seen[1].at(-1).content, /TOOL_RESULT_INVALID/);
});

test('usa fallback textual quando o provider não oferece tool calling', async () => {
  let chatCalls = 0;
  let toolCalls = 0;
  const provider: AIProvider = {
    classifyEmail: async () => ({ classificacao: 'IGNORAR' as const }),
    suggestCategory: async () => ({ categoryId: null }),
    chat: async () => { chatCalls += 1; return 'fallback honesto'; },
    chatWithTools: undefined,
  };
  const result = await new AIOrchestrator(registryWithEcho(), { maxCalls: 1, maxRounds: 1, timeoutMs: 100, toolTimeoutMs: 100, maxToolResultChars: 100 }).run(provider, [{ role: 'user', content: 'x' }], context);
  toolCalls += result.toolCalls;
  assert.equal(result.text, 'fallback honesto');
  assert.equal(chatCalls, 1);
  assert.equal(toolCalls, 0);
  assert.equal(result.usedTools, false);
});
