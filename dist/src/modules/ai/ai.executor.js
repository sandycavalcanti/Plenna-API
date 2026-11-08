import { z } from 'zod';
import { AIToolError } from './ai.errors.js';
import { toolExecutionContextSchema, toolNameSchema, } from './ai.contracts.js';
const toolCallSchema = z.object({
    name: toolNameSchema,
    arguments: z.unknown(),
}).strict();
const reservedIdentityKeys = new Set(['usuario_id', 'usuarioId', 'userId']);
function containsReservedIdentity(value, visited = new WeakSet()) {
    if (value === null || typeof value !== 'object')
        return false;
    if (visited.has(value))
        return false;
    visited.add(value);
    if (Array.isArray(value)) {
        return value.some((item) => containsReservedIdentity(item, visited));
    }
    return Object.entries(value).some(([key, nested]) => (reservedIdentityKeys.has(key) || containsReservedIdentity(nested, visited)));
}
function parseContext(context) {
    const parsed = toolExecutionContextSchema.safeParse(context);
    if (!parsed.success)
        throw new AIToolError('TOOL_CONTEXT_INVALID');
    return Object.freeze(parsed.data);
}
export async function executeTool(registry, call, context) {
    const executionContext = parseContext(context);
    const parsedCall = toolCallSchema.safeParse(call);
    if (!parsedCall.success || containsReservedIdentity(parsedCall.data?.arguments)) {
        throw new AIToolError('TOOL_ARGUMENTS_INVALID');
    }
    const tool = registry.get(parsedCall.data.name);
    if (!tool)
        throw new AIToolError('TOOL_NOT_FOUND');
    const parsedArguments = tool.argsSchema.safeParse(parsedCall.data.arguments);
    if (!parsedArguments.success) {
        throw new AIToolError('TOOL_ARGUMENTS_INVALID');
    }
    let rawResult;
    try {
        rawResult = await tool.execute(parsedArguments.data, executionContext);
    }
    catch (error) {
        if (error instanceof AIToolError)
            throw error;
        throw new AIToolError('TOOL_EXECUTION_FAILED');
    }
    const parsedResult = tool.resultSchema.safeParse(rawResult);
    if (!parsedResult.success) {
        throw new AIToolError('TOOL_RESULT_INVALID');
    }
    return {
        toolName: tool.name,
        result: parsedResult.data,
    };
}
