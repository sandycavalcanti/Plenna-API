import { z } from 'zod';
import { env } from '../../lib/env.js';
import type {
  AIChatToolCall,
  AIChatToolDefinition,
  AIChatToolResponse,
  AIMessage,
  AIProvider,
} from '../email/ai-provider.js';
import { AIOrchestrationError, AIToolError, toPublicToolError } from './ai.errors.js';
import type { ToolExecutionContext } from './ai.contracts.js';
import { executeTool } from './ai.executor.js';
import type { ToolRegistry } from './ai.registry.js';

const providerToolCallSchema = z.object({
  id: z.string().trim().min(1).max(128),
  type: z.literal('function'),
  function: z.object({
    name: z.string().trim().min(1).max(64),
    arguments: z.string().max(32_000),
  }).strict(),
}).strict();

const providerResponseSchema = z.object({
  content: z.string().max(100_000),
  tool_calls: z.array(providerToolCallSchema).max(32),
}).strict();

export type AIOrchestratorLimits = {
  maxCalls: number;
  maxRounds: number;
  timeoutMs: number;
  toolTimeoutMs: number;
  maxToolResultChars: number;
};

export type AIOrchestrationResult = {
  text: string;
  rounds: number;
  toolCalls: number;
  usedTools: boolean;
};

function toToolDefinition(definition: {
  name: string;
  description: string;
  argsSchema: z.ZodTypeAny;
}): AIChatToolDefinition {
  const schema = z.toJSONSchema(definition.argsSchema, { target: 'draft-7' }) as Record<string, unknown>;
  const { $schema: _schema, ...parameters } = schema;
  return {
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      parameters,
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorCode: 'AI_TOOL_TIMEOUT' | 'AI_TOOL_CALL_LIMIT') {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AIOrchestrationError(errorCode)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function safeJson(value: unknown, maxChars: number) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AIToolError('TOOL_RESULT_INVALID');
  }

  if (serialized.length > maxChars) {
    throw new AIToolError('TOOL_RESULT_INVALID');
  }
  return serialized;
}

function parseProviderResponse(value: unknown): AIChatToolResponse {
  const parsed = providerResponseSchema.safeParse(value);
  if (!parsed.success) throw new AIOrchestrationError('AI_RESPONSE_INVALID');
  return parsed.data as AIChatToolResponse;
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function executeCall(
  registry: ToolRegistry,
  call: AIChatToolCall,
  context: ToolExecutionContext,
  limits: AIOrchestratorLimits,
) {
  try {
    const result = await withTimeout(
      executeTool(registry, {
        name: call.function.name,
        arguments: parseToolArguments(call.function.arguments),
      }, context),
      limits.toolTimeoutMs,
      'AI_TOOL_TIMEOUT',
    );
    return {
      role: 'tool' as const,
      tool_call_id: call.id,
      name: result.toolName,
      content: safeJson({ ok: true, result: result.result }, limits.maxToolResultChars),
    } satisfies AIMessage;
  } catch (error) {
    const publicError = toPublicToolError(error);
    return {
      role: 'tool' as const,
      tool_call_id: call.id,
      name: call.function.name,
      content: JSON.stringify({ ok: false, error: publicError }),
    } satisfies AIMessage;
  }
}

export function getDefaultAIOrchestratorLimits(): AIOrchestratorLimits {
  return {
    maxCalls: env.aiToolMaxCalls,
    maxRounds: env.aiToolMaxRounds,
    timeoutMs: env.aiToolTimeoutMs,
    toolTimeoutMs: env.aiToolExecutionTimeoutMs,
    maxToolResultChars: env.aiToolResultMaxChars,
  };
}

export class AIOrchestrator {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly limits: AIOrchestratorLimits = getDefaultAIOrchestratorLimits(),
  ) {}

  async run(
    provider: AIProvider,
    initialMessages: AIMessage[],
    context: ToolExecutionContext,
  ): Promise<AIOrchestrationResult> {
    if (typeof provider.chatWithTools !== 'function') {
      const text = await withTimeout(provider.chat(initialMessages), this.limits.timeoutMs, 'AI_TOOL_TIMEOUT');
      return { text, rounds: 1, toolCalls: 0, usedTools: false };
    }

    const messages = [...initialMessages];
    const tools = this.registry.definitions().map(toToolDefinition);
    let toolCalls = 0;
    const completedCalls = new Map<string, AIMessage>();

    for (let round = 1; round <= this.limits.maxRounds; round += 1) {
      const response = parseProviderResponse(await withTimeout(
        provider.chatWithTools(messages, tools),
        this.limits.timeoutMs,
        'AI_TOOL_TIMEOUT',
      ));

      if (response.tool_calls.length === 0) {
        if (!response.content.trim()) throw new AIOrchestrationError('AI_RESPONSE_INVALID');
        return { text: response.content, rounds: round, toolCalls, usedTools: toolCalls > 0 };
      }

      if (round === this.limits.maxRounds) {
        throw new AIOrchestrationError('AI_TOOL_ROUND_LIMIT');
      }
      if (toolCalls + response.tool_calls.length > this.limits.maxCalls) {
        throw new AIOrchestrationError('AI_TOOL_CALL_LIMIT');
      }

      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls,
      });

      for (const call of response.tool_calls) {
        const signature = `${call.function.name}:${call.function.arguments}`;
        const cached = completedCalls.get(signature);
        const toolMessage = cached
          ? { ...cached, tool_call_id: call.id, name: call.function.name }
          : await executeCall(this.registry, call, context, this.limits);
        completedCalls.set(signature, toolMessage);
        messages.push(toolMessage);
        toolCalls += 1;
      }
    }

    throw new AIOrchestrationError('AI_TOOL_ROUND_LIMIT');
  }
}
