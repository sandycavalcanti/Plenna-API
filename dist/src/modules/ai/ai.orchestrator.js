import { z } from 'zod';
import { env } from '../../lib/env.js';
import { AIOrchestrationError, AIToolError, toPublicToolError } from './ai.errors.js';
import { executeTool } from './ai.executor.js';
const providerToolCallSchema = z.object({
    id: z.string().trim().min(1).max(128),
    type: z.literal('function'),
    function: z.object({
        name: z.string().trim().min(1).max(64),
        arguments: z.string().max(32000),
    }).strict(),
}).strict();
const providerResponseSchema = z.object({
    content: z.string().max(100000),
    tool_calls: z.array(providerToolCallSchema).max(32),
}).strict();
function toToolDefinition(definition) {
    const schema = z.toJSONSchema(definition.argsSchema, { target: 'draft-7' });
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
function withTimeout(promise, timeoutMs, errorCode) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new AIOrchestrationError(errorCode)), timeoutMs);
        timer.unref?.();
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}
function safeJson(value, maxChars) {
    let serialized;
    try {
        serialized = JSON.stringify(value);
    }
    catch {
        throw new AIToolError('TOOL_RESULT_INVALID');
    }
    if (serialized.length > maxChars) {
        throw new AIToolError('TOOL_RESULT_INVALID');
    }
    return serialized;
}
function parseProviderResponse(value) {
    const parsed = providerResponseSchema.safeParse(value);
    if (!parsed.success)
        throw new AIOrchestrationError('AI_RESPONSE_INVALID');
    return parsed.data;
}
function parseToolArguments(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
function canonicalizeToolArguments(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalizeToolArguments).join(',')}]`;
    const object = value;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeToolArguments(object[key])}`).join(',')}}`;
}
async function executeCall(registry, call, context, limits) {
    try {
        const result = await withTimeout(executeTool(registry, {
            name: call.function.name,
            arguments: parseToolArguments(call.function.arguments),
        }, context), limits.toolTimeoutMs, 'AI_TOOL_TIMEOUT');
        return {
            role: 'tool',
            tool_call_id: call.id,
            name: result.toolName,
            content: safeJson({ ok: true, result: result.result }, limits.maxToolResultChars),
        };
    }
    catch (error) {
        const publicError = toPublicToolError(error);
        return {
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify({ ok: false, error: publicError }),
        };
    }
}
export function getDefaultAIOrchestratorLimits() {
    return {
        maxCalls: env.aiToolMaxCalls,
        maxRounds: env.aiToolMaxRounds,
        timeoutMs: env.aiToolTimeoutMs,
        toolTimeoutMs: env.aiToolExecutionTimeoutMs,
        maxToolResultChars: env.aiToolResultMaxChars,
    };
}
export class AIOrchestrator {
    constructor(registry, limits = getDefaultAIOrchestratorLimits()) {
        this.registry = registry;
        this.limits = limits;
    }
    async run(provider, initialMessages, context) {
        if (typeof provider.chatWithTools !== 'function') {
            const text = await withTimeout(provider.chat(initialMessages), this.limits.timeoutMs, 'AI_TOOL_TIMEOUT');
            return { text, rounds: 1, toolCalls: 0, usedTools: false };
        }
        const messages = [...initialMessages];
        const tools = this.registry.definitions().map(toToolDefinition);
        let toolCalls = 0;
        const completedCalls = new Map();
        for (let round = 1; round <= this.limits.maxRounds; round += 1) {
            const response = parseProviderResponse(await withTimeout(provider.chatWithTools(messages, tools), this.limits.timeoutMs, 'AI_TOOL_TIMEOUT'));
            if (response.tool_calls.length === 0) {
                if (!response.content.trim())
                    throw new AIOrchestrationError('AI_RESPONSE_INVALID');
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
                const signature = `${call.function.name}:${canonicalizeToolArguments(parseToolArguments(call.function.arguments))}`;
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
