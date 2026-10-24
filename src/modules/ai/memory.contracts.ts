import { z } from 'zod';

export const MEMORY_ORIGINS = {
  DECLARADA: 'DECLARADA',
  INFERIDA: 'INFERIDA',
  DESCONHECIDA: 'DESCONHECIDA',
} as const;

export const MEMORY_STATUS = {
  ATIVA: 'ATIVA',
  INATIVA: 'INATIVA',
} as const;

export const MEMORY_CONTENT_MAX_LENGTH = 1_000;
export const MEMORY_EVIDENCE_MAX_LENGTH = 500;
export const MEMORY_DEDUPE_KEY_MAX_LENGTH = 160;
export const MEMORY_LIST_DEFAULT_LIMIT = 20;
export const MEMORY_LIST_MAX_LIMIT = 50;

export const memoryIdSchema = z.number().int().positive();

export const memoryContentSchema = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_CONTENT_MAX_LENGTH);

export const memoryEvidenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_EVIDENCE_MAX_LENGTH);

export const memoryOriginSchema = z.enum([
  MEMORY_ORIGINS.DECLARADA,
  MEMORY_ORIGINS.INFERIDA,
]);

export const memoryPersistedOriginSchema = z.enum([
  MEMORY_ORIGINS.DECLARADA,
  MEMORY_ORIGINS.INFERIDA,
  MEMORY_ORIGINS.DESCONHECIDA,
]);

export const memoryStatusSchema = z.enum([
  MEMORY_STATUS.ATIVA,
  MEMORY_STATUS.INATIVA,
]);

export const memoryTimestampSchema = z.coerce.date();

/**
 * Schema exposto ao provider: datas chegam como ISO-8601 e são convertidas
 * novamente pelo MemoryService antes da persistência.
 */
export const memoryToolTimestampSchema = z.string().datetime({ offset: true });

export const memoryDedupeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_DEDUPE_KEY_MAX_LENGTH)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), {
    message: 'A chave de deduplicação não pode conter caracteres de controle.',
  });

const memoryWriteFields = {
  conteudo: memoryContentSchema,
  origem: memoryOriginSchema,
  evidencia: memoryEvidenceSchema.optional(),
  historico_id: memoryIdSchema.nullable().optional(),
  data_expiracao: memoryTimestampSchema.nullable().optional(),
};

function requireEvidenceForInferredMemory(
  value: { origem?: string; evidencia?: string | null },
  context: z.RefinementCtx,
): void {
  if (value.origem === MEMORY_ORIGINS.INFERIDA && !value.evidencia) {
    context.addIssue({
      code: 'custom',
      path: ['evidencia'],
      message: 'Memórias inferidas exigem evidência explícita.',
    });
  }
}

export const memorySaveInputSchema = z
  .object(memoryWriteFields)
  .strict()
  .superRefine(requireEvidenceForInferredMemory);

const memorySavePersistenceFields = {
  usuario_id: memoryIdSchema,
  conteudo: memoryContentSchema,
  origem: memoryOriginSchema,
  evidencia: memoryEvidenceSchema.nullable(),
  chave_dedupe: memoryDedupeKeySchema,
  historico_id: memoryIdSchema.nullable(),
  data_expiracao: memoryTimestampSchema.nullable(),
};

export const memorySavePersistenceSchema = z
  .object(memorySavePersistenceFields)
  .strict()
  .superRefine(requireEvidenceForInferredMemory);

export const memoryListInputSchema = z
  .object({
    status: memoryStatusSchema.default(MEMORY_STATUS.ATIVA),
    origem: memoryOriginSchema.optional(),
    limite: z.number().int().min(1).max(MEMORY_LIST_MAX_LIMIT).default(MEMORY_LIST_DEFAULT_LIMIT),
    cursor: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export const memoryUpdateInputSchema = z
  .object({
    memoria_id: memoryIdSchema,
    conteudo: memoryContentSchema.optional(),
    origem: memoryOriginSchema.optional(),
    evidencia: memoryEvidenceSchema.optional(),
    historico_id: memoryIdSchema.nullable().optional(),
    data_expiracao: memoryTimestampSchema.nullable().optional(),
    status: memoryStatusSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasChange = [
      value.conteudo,
      value.origem,
      value.evidencia,
      value.historico_id,
      value.data_expiracao,
      value.status,
    ].some((field) => field !== undefined);

    if (!hasChange) {
      context.addIssue({
        code: 'custom',
        message: 'A atualização precisa informar ao menos um campo alterável.',
      });
    }

    requireEvidenceForInferredMemory(value, context);
  });

const memorySaveToolInputSchema = z
  .object({
    conteudo: memoryContentSchema,
    origem: memoryOriginSchema,
    evidencia: memoryEvidenceSchema.optional(),
    historico_id: memoryIdSchema.nullable().optional(),
    data_expiracao: memoryToolTimestampSchema.nullable().optional(),
  })
  .strict()
  .superRefine(requireEvidenceForInferredMemory);

const memoryUpdateToolInputSchema = z
  .object({
    memoria_id: memoryIdSchema,
    conteudo: memoryContentSchema.optional(),
    origem: memoryOriginSchema.optional(),
    evidencia: memoryEvidenceSchema.optional(),
    historico_id: memoryIdSchema.nullable().optional(),
    data_expiracao: memoryToolTimestampSchema.nullable().optional(),
    status: memoryStatusSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasChange = [
      value.conteudo,
      value.origem,
      value.evidencia,
      value.historico_id,
      value.data_expiracao,
      value.status,
    ].some((field) => field !== undefined);

    if (!hasChange) {
      context.addIssue({
        code: 'custom',
        message: 'A atualizaÃ§Ã£o precisa informar ao menos um campo alterÃ¡vel.',
      });
    }

    requireEvidenceForInferredMemory(value, context);
  });

export const memoryInactivateInputSchema = z
  .object({ memoria_id: memoryIdSchema })
  .strict();

export const memoryDeleteInputSchema = z
  .object({ memoria_id: memoryIdSchema })
  .strict();

const memoryRecordFields = {
    memoria_id: memoryIdSchema,
    usuario_id: memoryIdSchema,
    conteudo: memoryContentSchema,
    origem: memoryPersistedOriginSchema,
    status: memoryStatusSchema,
    chave_dedupe: memoryDedupeKeySchema.nullable(),
    evidencia: memoryEvidenceSchema.nullable(),
    historico_id: memoryIdSchema.nullable(),
    data_expiracao: memoryTimestampSchema.nullable(),
    data_criacao: memoryTimestampSchema,
    data_atualizacao: memoryTimestampSchema,
};

export const memoryRecordSchema = z
  .object(memoryRecordFields)
  .strict()
  .superRefine((value, context) => {
    if (value.origem !== MEMORY_ORIGINS.DESCONHECIDA && !value.chave_dedupe) {
      context.addIssue({
        code: 'custom',
        path: ['chave_dedupe'],
        message: 'Memórias com origem conhecida exigem chave de deduplicação.',
      });
    }

    requireEvidenceForInferredMemory(value, context);
  });

export const memoryLegacyRecordSchema = z
  .object({
    memoria_id: memoryIdSchema,
    usuario_id: memoryIdSchema,
    conteudo: memoryContentSchema,
    data_criacao: memoryTimestampSchema,
  })
  .strict();

export const memoryListResultSchema = z
  .object({
    itens: z.array(memoryRecordSchema).max(MEMORY_LIST_MAX_LIMIT),
    proximo_cursor: z.string().nullable(),
  })
  .strict();

export const memorySaveResultSchema = z
  .object({
    memoria: memoryRecordSchema,
    deduplicada: z.boolean(),
  })
  .strict();

export const memoryUpdateResultSchema = z
  .object({ memoria: memoryRecordSchema })
  .strict();

export const memoryInactivateResultSchema = z
  .object({ memoria: memoryRecordSchema })
  .strict();

export const memoryDeleteResultSchema = z
  .object({ memoria_id: memoryIdSchema, excluida: z.boolean() })
  .strict();

export const memoryToolContracts = {
  memory_list: {
    inputSchema: memoryListInputSchema,
    resultSchema: memoryListResultSchema,
  },
  memory_save: {
    inputSchema: memorySaveToolInputSchema,
    resultSchema: memorySaveResultSchema,
  },
  memory_update: {
    inputSchema: memoryUpdateToolInputSchema,
    resultSchema: memoryUpdateResultSchema,
  },
} as const;

export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;
export type MemoryPersistedOrigin = z.infer<typeof memoryPersistedOriginSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type MemoryListInput = z.infer<typeof memoryListInputSchema>;
export type MemorySaveInput = z.infer<typeof memorySaveInputSchema>;
export type MemorySavePersistence = z.infer<typeof memorySavePersistenceSchema>;
export type MemoryUpdateInput = z.infer<typeof memoryUpdateInputSchema>;
export type MemoryInactivateInput = z.infer<typeof memoryInactivateInputSchema>;
export type MemoryDeleteInput = z.infer<typeof memoryDeleteInputSchema>;
export type MemoryLegacyRecord = z.infer<typeof memoryLegacyRecordSchema>;
export type MemoryListResult = z.infer<typeof memoryListResultSchema>;
export type MemorySaveResult = z.infer<typeof memorySaveResultSchema>;
export type MemoryUpdateResult = z.infer<typeof memoryUpdateResultSchema>;
export type MemoryInactivateResult = z.infer<typeof memoryInactivateResultSchema>;
export type MemoryDeleteResult = z.infer<typeof memoryDeleteResultSchema>;

export const memoryOperationSchema = z.enum([
  'memory_list',
  'memory_save',
  'memory_update',
  'memory_inactivate',
  'memory_delete',
]);

export type MemoryOperation = z.infer<typeof memoryOperationSchema>;

export const memoryAuthorizationContextSchema = z
  .object({
    usuario_id: memoryIdSchema,
    consentimento_memoria_ativo: z.boolean(),
    pode_ler: z.boolean(),
    pode_escrever: z.boolean(),
    pode_excluir: z.boolean(),
  })
  .strict();

export type MemoryAuthorizationContext = z.infer<typeof memoryAuthorizationContextSchema>;

export type MemoryPolicyErrorCode =
  | 'MEMORY_AUTHORIZATION_INVALID'
  | 'MEMORY_CONSENT_REQUIRED'
  | 'MEMORY_IDENTITY_FORBIDDEN'
  | 'MEMORY_OWNER_MISMATCH'
  | 'MEMORY_OPERATION_FORBIDDEN'
  | 'MEMORY_SENSITIVE_CONTENT'
  | 'MEMORY_EXPIRATION_INVALID'
  | 'MEMORY_INFERRED_CONTENT_IMMUTABLE'
  | 'MEMORY_INFERRED_EVIDENCE_INCOMPATIBLE'
  | 'MEMORY_LEGACY_PROVENANCE_REQUIRED'
  | 'MEMORY_VALIDATION_FAILED';

export class MemoryPolicyError extends Error {
  readonly code: MemoryPolicyErrorCode;

  constructor(code: MemoryPolicyErrorCode, message: string) {
    super(message);
    this.name = 'MemoryPolicyError';
    this.code = code;
  }
}

export function normalizeLegacyMemoryRecord(input: unknown): MemoryRecord {
  const parsed = memoryLegacyRecordSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryPolicyError(
      'MEMORY_VALIDATION_FAILED',
      'O registro legado de memória é inválido.',
    );
  }

  return {
    memoria_id: parsed.data.memoria_id,
    usuario_id: parsed.data.usuario_id,
    conteudo: parsed.data.conteudo,
    origem: MEMORY_ORIGINS.DESCONHECIDA,
    status: MEMORY_STATUS.ATIVA,
    chave_dedupe: null,
    evidencia: null,
    historico_id: null,
    data_expiracao: null,
    data_criacao: parsed.data.data_criacao,
    data_atualizacao: parsed.data.data_criacao,
  };
}

const identityKeys = new Set([
  'usuario_id',
  'usuarioId',
  'user_id',
  'userId',
  'owner_id',
  'ownerId',
]);

const sensitiveContentPattern = /\b(?:senha|password|token|secret|segredo|credential|credencial|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|authorization|bearer|cookie|private[ _-]?key)\b/i;
const jwtPattern = /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/;

function walkObject(value: unknown, visitString: (value: string) => void): void {
  if (typeof value === 'string') {
    visitString(value);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => walkObject(item, visitString));
    return;
  }

  if (value !== null && typeof value === 'object') {
    Object.entries(value).forEach(([key, nestedValue]) => {
      visitString(key);
      walkObject(nestedValue, visitString);
    });
  }
}

function rejectIdentityFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectIdentityFields);
    return;
  }

  if (value !== null && typeof value === 'object') {
    Object.entries(value).forEach(([key, nestedValue]) => {
      if (identityKeys.has(key)) {
        throw new MemoryPolicyError(
          'MEMORY_IDENTITY_FORBIDDEN',
          'A identidade da memória deve ser obtida do contexto autenticado.',
        );
      }

      rejectIdentityFields(nestedValue);
    });
  }
}

function rejectSensitiveContent(value: unknown): void {
  let foundSensitiveContent = false;

  walkObject(value, (item) => {
    if (sensitiveContentPattern.test(item) || jwtPattern.test(item)) {
      foundSensitiveContent = true;
    }
  });

  if (foundSensitiveContent) {
    throw new MemoryPolicyError(
      'MEMORY_SENSITIVE_CONTENT',
      'O conteúdo não pode ser armazenado por este contrato de memória.',
    );
  }
}

function parseMemoryInput<T>(schema: z.ZodType<T>, input: unknown, checkSensitiveContent = false): T {
  rejectIdentityFields(input);

  if (checkSensitiveContent) {
    rejectSensitiveContent(input);
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    throw new MemoryPolicyError(
      'MEMORY_VALIDATION_FAILED',
      'Os argumentos da memória são inválidos.',
    );
  }

  return result.data;
}

function assertExpirationIsFuture(expiration: Date | null | undefined, now: Date): void {
  if (expiration && expiration.getTime() <= now.getTime()) {
    throw new MemoryPolicyError(
      'MEMORY_EXPIRATION_INVALID',
      'A expiração da memória deve estar no futuro.',
    );
  }
}

export function parseMemoryListInput(input: unknown): MemoryListInput {
  return parseMemoryInput(memoryListInputSchema, input);
}

export function parseMemorySaveInput(input: unknown, now = new Date()): MemorySaveInput {
  const parsed = parseMemoryInput(memorySaveInputSchema, input, true);
  assertExpirationIsFuture(parsed.data_expiracao, now);
  return parsed;
}

export function parseMemoryUpdateInput(input: unknown, now = new Date()): MemoryUpdateInput {
  const parsed = parseMemoryInput(memoryUpdateInputSchema, input, true);
  assertExpirationIsFuture(parsed.data_expiracao, now);
  return parsed;
}

export function validateMemoryUpdateAgainstPersistedState(
  persistedInput: unknown,
  updateInput: unknown,
  now = new Date(),
): MemoryUpdateInput {
  const persisted = memoryRecordSchema.safeParse(persistedInput);
  if (!persisted.success) {
    throw new MemoryPolicyError(
      'MEMORY_VALIDATION_FAILED',
      'O estado persistido da memória é inválido.',
    );
  }

  const update = parseMemoryUpdateInput(updateInput, now);

  if (persisted.data.origem === MEMORY_ORIGINS.INFERIDA) {
    if (update.conteudo !== undefined) {
      throw new MemoryPolicyError(
        'MEMORY_INFERRED_CONTENT_IMMUTABLE',
        'O conteúdo de uma memória inferida não pode ser alterado por esta operação.',
      );
    }

    if (update.origem !== undefined && update.origem !== MEMORY_ORIGINS.INFERIDA) {
      throw new MemoryPolicyError(
        'MEMORY_INFERRED_EVIDENCE_INCOMPATIBLE',
        'A origem de uma memória inferida não pode ser reclassificada.',
      );
    }

    if (update.evidencia !== undefined && update.evidencia !== persisted.data.evidencia) {
      throw new MemoryPolicyError(
        'MEMORY_INFERRED_EVIDENCE_INCOMPATIBLE',
        'A evidência de uma memória inferida não pode ser substituída nesta operação.',
      );
    }
  }

  if (
    persisted.data.origem === MEMORY_ORIGINS.DESCONHECIDA
    && (update.conteudo !== undefined || update.evidencia !== undefined)
    && update.origem === undefined
  ) {
    throw new MemoryPolicyError(
      'MEMORY_LEGACY_PROVENANCE_REQUIRED',
      'Registros legados exigem origem explícita antes de alterar proveniência ou conteúdo.',
    );
  }

  return update;
}

export function parseMemoryInactivateInput(input: unknown): MemoryInactivateInput {
  return parseMemoryInput(memoryInactivateInputSchema, input);
}

export function parseMemoryDeleteInput(input: unknown): MemoryDeleteInput {
  return parseMemoryInput(memoryDeleteInputSchema, input);
}

export function assertMemoryAuthorized(
  operation: MemoryOperation,
  context: unknown,
): MemoryAuthorizationContext {
  const parsedContext = memoryAuthorizationContextSchema.safeParse(context);
  if (!parsedContext.success) {
    throw new MemoryPolicyError(
      'MEMORY_AUTHORIZATION_INVALID',
      'O contexto de autorização da memória é inválido.',
    );
  }

  if (
    operation !== 'memory_delete'
    && !parsedContext.data.consentimento_memoria_ativo
  ) {
    throw new MemoryPolicyError(
      'MEMORY_CONSENT_REQUIRED',
      'O consentimento de memória não está ativo.',
    );
  }

  const allowed = {
    memory_list: parsedContext.data.pode_ler,
    memory_save: parsedContext.data.pode_escrever,
    memory_update: parsedContext.data.pode_escrever,
    memory_inactivate: parsedContext.data.pode_escrever,
    memory_delete: parsedContext.data.pode_excluir,
  }[operation];

  if (!allowed) {
    throw new MemoryPolicyError(
      'MEMORY_OPERATION_FORBIDDEN',
      'A operação de memória não está autorizada.',
    );
  }

  return parsedContext.data;
}

export function buildMemorySavePersistence(
  input: unknown,
  context: unknown,
  backendGeneratedDedupeKey: unknown,
  now = new Date(),
): MemorySavePersistence {
  const authorization = assertMemoryAuthorized('memory_save', context);
  const parsedInput = parseMemorySaveInput(input, now);

  rejectSensitiveContent(backendGeneratedDedupeKey);
  const parsedDedupeKey = memoryDedupeKeySchema.safeParse(backendGeneratedDedupeKey);
  if (!parsedDedupeKey.success) {
    throw new MemoryPolicyError(
      'MEMORY_VALIDATION_FAILED',
      'A chave de deduplicação gerada pelo backend é inválida.',
    );
  }

  const persistence = memorySavePersistenceSchema.safeParse({
    usuario_id: authorization.usuario_id,
    conteudo: parsedInput.conteudo,
    origem: parsedInput.origem,
    evidencia: parsedInput.evidencia ?? null,
    chave_dedupe: parsedDedupeKey.data,
    historico_id: parsedInput.historico_id ?? null,
    data_expiracao: parsedInput.data_expiracao ?? null,
  });

  if (!persistence.success) {
    throw new MemoryPolicyError(
      'MEMORY_VALIDATION_FAILED',
      'Os dados internos da memória são inválidos.',
    );
  }

  return persistence.data;
}

export function assertMemoryOwner(
  memoryOwnerId: unknown,
  context: unknown,
): MemoryAuthorizationContext {
  const parsedContext = memoryAuthorizationContextSchema.safeParse(context);
  const parsedOwner = memoryIdSchema.safeParse(memoryOwnerId);

  if (!parsedContext.success || !parsedOwner.success) {
    throw new MemoryPolicyError(
      'MEMORY_AUTHORIZATION_INVALID',
      'O contexto de autorização da memória é inválido.',
    );
  }

  if (parsedOwner.data !== parsedContext.data.usuario_id) {
    throw new MemoryPolicyError(
      'MEMORY_OWNER_MISMATCH',
      'A memória não pertence ao usuário autenticado.',
    );
  }

  return parsedContext.data;
}

