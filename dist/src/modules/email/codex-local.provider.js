import { Codex } from '@openai/codex-sdk';
import { z } from 'zod';
import { env } from '../../lib/env.js';
import { isClassificationLabel } from './classification.engine.js';
import { buildClassificationInstructions, buildPurchaseExtractionInstructions, requestyCategorySchema, requestyClassificationSchema, requestyPurchaseExtractionSchema, } from './requesty.provider.js';
export class CodexLocalError extends Error {
    constructor(code, message, diagnostic) {
        super(message);
        this.code = code;
        this.diagnostic = diagnostic;
        this.name = 'CodexLocalError';
    }
}
function schemaToJson(schema) {
    return normalizeCodexSchema(z.toJSONSchema(schema, { target: 'draft-7' }));
}
const codexClassificationSchema = {
    type: 'object',
    properties: {
        classificacao: {
            type: 'string',
            enum: ['COMPRA', 'PROPAGANDA', 'IGNORAR'],
        },
        categoryId: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        purchase: {
            anyOf: [
                {
                    type: 'object',
                    properties: {
                        establishment: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                        amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                        paymentMethodName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    },
                    required: ['establishment', 'amount', 'paymentMethodName'],
                    additionalProperties: false,
                },
                { type: 'null' },
            ],
        },
    },
    required: ['classificacao', 'categoryId', 'purchase'],
    additionalProperties: false,
};
function normalizeCodexSchema(value) {
    const schema = { ...value };
    delete schema.$schema;
    delete schema.default;
    if (schema.type === 'object') {
        const properties = schema.properties ?? {};
        schema.properties = Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, normalizeCodexSchema(property)]));
        schema.required = Object.keys(schema.properties);
        schema.additionalProperties = false;
    }
    if (schema.items && typeof schema.items === 'object') {
        schema.items = normalizeCodexSchema(schema.items);
    }
    for (const key of ['anyOf']) {
        if (Array.isArray(schema[key])) {
            schema[key] = schema[key].map((item) => normalizeCodexSchema(item));
        }
    }
    return schema;
}
function validateCodexSchema(value, path = '$', root = true) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new CodexLocalError('invalid_json_schema', `Schema de saída inválido em ${path}`);
    }
    const schema = value;
    for (const forbidden of ['oneOf', 'allOf', 'not']) {
        if (forbidden in schema) {
            throw new CodexLocalError('invalid_json_schema', `Schema de saída incompatível com o Codex Structured Outputs: ${forbidden} em ${path}`);
        }
    }
    if (root && schema.type !== 'object') {
        throw new CodexLocalError('invalid_json_schema', 'Schema de saída do Codex deve ter raiz object');
    }
    if (schema.type === 'object') {
        const properties = schema.properties ?? {};
        if (schema.additionalProperties !== false) {
            throw new CodexLocalError('invalid_json_schema', `Schema de saída exige additionalProperties=false em ${path}`);
        }
        if (!Array.isArray(schema.required) || Object.keys(properties).some((key) => !schema.required.includes(key))) {
            throw new CodexLocalError('invalid_json_schema', `Schema de saída exige propriedades obrigatórias em ${path}`);
        }
        for (const [key, property] of Object.entries(properties)) {
            validateCodexSchema(property, `${path}.properties.${key}`, false);
        }
    }
    if (schema.items)
        validateCodexSchema(schema.items, `${path}.items`, false);
    if (Array.isArray(schema.anyOf)) {
        for (const [index, item] of schema.anyOf.entries()) {
            validateCodexSchema(item, `${path}.anyOf[${index}]`, false);
        }
    }
}
function errorRecord(error) {
    return typeof error === 'object' && error !== null ? error : undefined;
}
function errorMessage(error) {
    const record = errorRecord(error);
    return typeof record?.message === 'string' ? record.message : String(error);
}
function sanitizeText(value, maxLength = 2000) {
    if (typeof value !== 'string')
        return value;
    return value
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/(access_token|refresh_token|id_token|client_secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .slice(0, maxLength);
}
function diagnosticFor(error) {
    const record = errorRecord(error);
    const cause = errorRecord(record?.cause);
    const message = errorMessage(error);
    const stderr = message.match(/Codex Exec exited with (?:code \d+|signal [^:]+):\s*([\s\S]*)$/i)?.[1];
    return {
        name: typeof record?.name === 'string' ? record.name : undefined,
        message: sanitizeText(message),
        code: typeof record?.code === 'string' || typeof record?.code === 'number' ? record.code : undefined,
        errno: typeof record?.errno === 'string' || typeof record?.errno === 'number' ? record.errno : undefined,
        syscall: typeof record?.syscall === 'string' ? record.syscall : undefined,
        path: typeof record?.path === 'string' ? sanitizeText(record.path) : undefined,
        spawnargs: Array.isArray(record?.spawnargs) ? record.spawnargs.map((arg) => sanitizeText(arg, 500)) : undefined,
        stderr: sanitizeText(stderr),
        cause: {
            name: typeof cause?.name === 'string' ? cause.name : undefined,
            message: sanitizeText(cause?.message),
            code: typeof cause?.code === 'string' || typeof cause?.code === 'number' ? cause.code : undefined,
            errno: typeof cause?.errno === 'string' || typeof cause?.errno === 'number' ? cause.errno : undefined,
            syscall: typeof cause?.syscall === 'string' ? cause.syscall : undefined,
            path: typeof cause?.path === 'string' ? sanitizeText(cause.path) : undefined,
        },
    };
}
function isAuthenticationError(error) {
    return /not logged in|not authenticated|authentication|please.*login|required.*login|login required|unauthorized|401/i.test(errorMessage(error));
}
function isRateLimitError(error) {
    return /rate limit|too many requests|\b429\b|usage limit|quota/i.test(errorMessage(error));
}
function isInvalidJsonSchemaError(error) {
    return /invalid_json_schema|Invalid schema for response_format|text\.format\.schema/i.test(errorMessage(error));
}
function isUnavailableError(error) {
    const record = errorRecord(error);
    const message = errorMessage(error);
    const isSpawnEnoent = record?.code === 'ENOENT'
        && typeof record.syscall === 'string'
        && /^spawn(?:\s|$)/i.test(record.syscall);
    const isSdkBinaryResolutionFailure = /Unable to locate Codex CLI binaries(?: for [^.]*)?\./i.test(message);
    return isSpawnEnoent || isSdkBinaryResolutionFailure;
}
export class CodexLocalProvider {
    constructor(createCodex = () => new Codex()) {
        this.createCodex = createCodex;
    }
    async runStructured(operation, prompt, schema, instructions, outputSchema = schemaToJson(schema)) {
        const startedAt = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), env.codexLocalTimeoutMs);
        timeout.unref?.();
        console.info(`[AI] provider=codex_local operation=${operation} started`);
        try {
            validateCodexSchema(outputSchema);
            console.info(`[AI] provider=codex_local operation=${operation} schemaValidated=true`);
            const thread = this.createCodex().startThread({
                sandboxMode: 'read-only',
                approvalPolicy: 'never',
                networkAccessEnabled: false,
                workingDirectory: process.cwd(),
            });
            const result = await thread.run(`${instructions}\nResponda somente com JSON estrito, sem markdown ou texto adicional.\n\n${prompt}`, { outputSchema, signal: controller.signal });
            if (!result.finalResponse.trim()) {
                throw new CodexLocalError('empty', 'Codex local retornou uma resposta vazia');
            }
            let parsed;
            try {
                parsed = JSON.parse(result.finalResponse);
            }
            catch (error) {
                throw new CodexLocalError('invalid_json', 'Codex local retornou JSON inválido');
            }
            const validated = schema.safeParse(parsed);
            if (!validated.success) {
                throw new CodexLocalError('invalid_json', 'Codex local retornou uma resposta estruturada inválida');
            }
            console.info(`[AI] provider=codex_local operation=${operation} completed durationMs=${Date.now() - startedAt}`);
            return validated.data;
        }
        catch (error) {
            const diagnostic = diagnosticFor(error);
            console.error(`[AI] provider=codex_local operation=${operation} failed`, diagnostic);
            if (error instanceof CodexLocalError)
                throw error;
            if (controller.signal.aborted) {
                throw new CodexLocalError('timeout', `Timeout do Codex local após ${env.codexLocalTimeoutMs}ms`, diagnostic);
            }
            if (isAuthenticationError(error)) {
                throw new CodexLocalError('unauthenticated', 'Codex local não está autenticado. Execute `codex login` e tente novamente.', diagnostic);
            }
            if (isRateLimitError(error)) {
                throw new CodexLocalError('rate_limit', 'Codex local atingiu um limite de uso.', diagnostic);
            }
            if (isInvalidJsonSchemaError(error)) {
                throw new CodexLocalError('invalid_json_schema', 'Schema de saída incompatível com o Codex Structured Outputs.', diagnostic);
            }
            if (isUnavailableError(error)) {
                throw new CodexLocalError('unavailable', 'Codex local não está instalado ou não está disponível para execução.', diagnostic);
            }
            throw new CodexLocalError('execution', 'Falha ao executar Codex local.', diagnostic);
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async classifyEmail(prompt) {
        const result = await this.runStructured('email_classification', prompt, requestyClassificationSchema, buildClassificationInstructions(), codexClassificationSchema);
        if (!isClassificationLabel(result.classificacao)) {
            throw new CodexLocalError('invalid_json', 'Codex local retornou classificação inválida');
        }
        return result;
    }
    async suggestCategory(prompt, categories) {
        const categoryList = categories.map((category) => `${category.categoryId} - ${category.categoryName}`).join('\n');
        return this.runStructured('category_suggestion', `${prompt}\nCategorias permitidas:\n${categoryList}`, requestyCategorySchema, 'Escolha somente um categoryId da lista fornecida. NÃ£o invente IDs; retorne null quando nenhuma categoria for adequada.');
    }
    async extractPurchase(prompt) {
        return this.runStructured('purchase_extraction', prompt, requestyPurchaseExtractionSchema, buildPurchaseExtractionInstructions());
    }
}
