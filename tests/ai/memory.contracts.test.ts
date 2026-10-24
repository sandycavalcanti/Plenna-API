import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_ORIGINS,
  MEMORY_STATUS,
  MemoryPolicyError,
  assertMemoryAuthorized,
  assertMemoryOwner,
  buildMemorySavePersistence,
  memoryListInputSchema,
  memoryRecordSchema,
  memorySaveInputSchema,
  memorySavePersistenceSchema,
  normalizeLegacyMemoryRecord,
  parseMemoryDeleteInput,
  parseMemoryListInput,
  parseMemorySaveInput,
  parseMemoryUpdateInput,
  validateMemoryUpdateAgainstPersistedState,
} from '../../src/modules/ai/memory.contracts.js';

const authorizedContext = {
  usuario_id: 42,
  consentimento_memoria_ativo: true,
  pode_ler: true,
  pode_escrever: true,
  pode_excluir: false,
};

const validSave = {
  conteudo: 'Prefere revisar o orçamento aos domingos.',
  origem: MEMORY_ORIGINS.DECLARADA,
};

const persistedInferred = {
  memoria_id: 10,
  usuario_id: 42,
  conteudo: 'Prefere revisar o orçamento aos domingos.',
  origem: MEMORY_ORIGINS.INFERIDA,
  status: MEMORY_STATUS.ATIVA,
  chave_dedupe: 'generated:42:orcamento:domingo',
  evidencia: 'Preferência observada em uma declaração explícita.',
  historico_id: null,
  data_expiracao: null,
  data_criacao: new Date('2026-01-01T00:00:00.000Z'),
  data_atualizacao: new Date('2026-01-01T00:00:00.000Z'),
};

test('valida memória declarada e aplica defaults de listagem', () => {
  const save = memorySaveInputSchema.safeParse(validSave);
  assert.equal(save.success, true);

  const list = parseMemoryListInput({});
  assert.deepEqual(list, {
    status: MEMORY_STATUS.ATIVA,
    limite: 20,
  });
});

test('rejeita memória vazia, conteúdo excessivo e origem desconhecida', () => {
  assert.equal(memorySaveInputSchema.safeParse({ ...validSave, conteudo: '   ' }).success, false);
  assert.equal(
    memorySaveInputSchema.safeParse({
      ...validSave,
      conteudo: 'x'.repeat(MEMORY_CONTENT_MAX_LENGTH + 1),
    }).success,
    false,
  );
  assert.equal(
    memorySaveInputSchema.safeParse({ ...validSave, origem: 'SUPOSICAO' }).success,
    false,
  );
});

test('exige evidência para memória inferida e não expõe campo de mensagens no contrato', () => {
  assert.equal(
    memorySaveInputSchema.safeParse({
      ...validSave,
      origem: MEMORY_ORIGINS.INFERIDA,
    }).success,
    false,
  );

  assert.equal(
    memorySaveInputSchema.safeParse({
      ...validSave,
      mensagens: ['mensagem bruta'],
    }).success,
    false,
  );

  const inferred = parseMemorySaveInput({
    ...validSave,
    origem: MEMORY_ORIGINS.INFERIDA,
    evidencia: 'A pessoa declarou preferência em uma interação explícita.',
  });
  assert.equal(inferred.origem, MEMORY_ORIGINS.INFERIDA);
});

test('persiste evidência para inferências e representa origem legada como desconhecida', () => {
  assert.equal(memoryRecordSchema.safeParse(persistedInferred).success, true);
  assert.equal(
    memoryRecordSchema.safeParse({ ...persistedInferred, evidencia: null }).success,
    false,
  );

  const legacy = normalizeLegacyMemoryRecord({
    memoria_id: 3,
    usuario_id: 42,
    conteudo: 'Anotação anterior à expansão do contrato.',
    data_criacao: '2025-01-01T00:00:00.000Z',
  });

  assert.equal(legacy.origem, MEMORY_ORIGINS.DESCONHECIDA);
  assert.equal(legacy.evidencia, null);
  assert.equal(legacy.chave_dedupe, null);
  assert.equal(memoryRecordSchema.safeParse(legacy).success, true);
});

test('protege conteúdo e evidência de memórias inferidas durante atualização', () => {
  assert.throws(
    () => validateMemoryUpdateAgainstPersistedState(persistedInferred, {
      memoria_id: persistedInferred.memoria_id,
      conteudo: 'Conteúdo incompatível.',
    }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_INFERRED_CONTENT_IMMUTABLE',
  );

  assert.throws(
    () => validateMemoryUpdateAgainstPersistedState(persistedInferred, {
      memoria_id: persistedInferred.memoria_id,
      evidencia: 'Evidência incompatível.',
    }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_INFERRED_EVIDENCE_INCOMPATIBLE',
  );

  assert.throws(
    () => validateMemoryUpdateAgainstPersistedState(persistedInferred, {
      memoria_id: persistedInferred.memoria_id,
      origem: MEMORY_ORIGINS.DECLARADA,
    }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_INFERRED_EVIDENCE_INCOMPATIBLE',
  );

  const statusUpdate = validateMemoryUpdateAgainstPersistedState(persistedInferred, {
    memoria_id: persistedInferred.memoria_id,
    status: MEMORY_STATUS.INATIVA,
  });
  assert.equal(statusUpdate.status, MEMORY_STATUS.INATIVA);
});

test('exige proveniência explícita antes de alterar conteúdo legado', () => {
  const legacy = normalizeLegacyMemoryRecord({
    memoria_id: 4,
    usuario_id: 42,
    conteudo: 'Conteúdo legado.',
    data_criacao: '2025-01-01T00:00:00.000Z',
  });

  assert.throws(
    () => validateMemoryUpdateAgainstPersistedState(legacy, {
      memoria_id: legacy.memoria_id,
      conteudo: 'Conteúdo revisado.',
    }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_LEGACY_PROVENANCE_REQUIRED',
  );

  const explicitlyDeclared = validateMemoryUpdateAgainstPersistedState(legacy, {
    memoria_id: legacy.memoria_id,
    origem: MEMORY_ORIGINS.DECLARADA,
    conteudo: 'Conteúdo declarado pelo usuário.',
  });
  assert.equal(explicitlyDeclared.origem, MEMORY_ORIGINS.DECLARADA);
});

test('rejeita identidade fornecida nos argumentos, inclusive em payload permissivo', () => {
  assert.throws(
    () => parseMemorySaveInput({ ...validSave, usuario_id: 999 }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_IDENTITY_FORBIDDEN',
  );

  assert.throws(
    () => parseMemoryListInput({ usuarioId: 999 }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_IDENTITY_FORBIDDEN',
  );
});

test('impede segredos controláveis e expiração já vencida sem prometer segurança total', () => {
  assert.throws(
    () => parseMemorySaveInput({
      ...validSave,
      conteudo: 'Bearer token-super-secreto',
    }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_SENSITIVE_CONTENT',
  );

  assert.throws(
    () => parseMemorySaveInput({
      ...validSave,
      data_expiracao: '2020-01-01T00:00:00.000Z',
    }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_EXPIRATION_INVALID',
  );
});

test('separa argumentos da tool da persistência e mantém deduplicação no backend', () => {
  assert.equal(
    memoryListInputSchema.safeParse({ limite: 51 }).success,
    false,
  );
  assert.equal(
    memorySaveInputSchema.safeParse({
      ...validSave,
      chave_dedupe: 'modelo-forneceu-livremente',
    }).success,
    false,
  );

  const persistence = buildMemorySavePersistence(
    validSave,
    authorizedContext,
    'generated:42:preferencia:domingo',
  );
  assert.equal(persistence.usuario_id, authorizedContext.usuario_id);
  assert.equal(persistence.chave_dedupe, 'generated:42:preferencia:domingo');
  assert.equal(memorySavePersistenceSchema.safeParse(persistence).success, true);
  assert.equal(persistence.evidencia, null);
});

test('mantém deduplicação obrigatória na persistência e atualizações não vazias', () => {
  assert.equal(
    memorySavePersistenceSchema.safeParse({
      usuario_id: 42,
      ...validSave,
      evidencia: null,
      chave_dedupe: '',
      historico_id: null,
      data_expiracao: null,
    }).success,
    false,
  );
  assert.equal(
    parseMemoryUpdateInput({ memoria_id: 10, status: MEMORY_STATUS.INATIVA }).status,
    MEMORY_STATUS.INATIVA,
  );
  assert.throws(
    () => parseMemoryUpdateInput({ memoria_id: 10 }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_VALIDATION_FAILED',
  );
});

test('exige consentimento e permissão por operação, preservando o isolamento do proprietário', () => {
  assert.deepEqual(assertMemoryAuthorized('memory_list', authorizedContext), authorizedContext);

  assert.throws(
    () => assertMemoryAuthorized('memory_save', { ...authorizedContext, pode_escrever: false }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_OPERATION_FORBIDDEN',
  );

  assert.throws(
    () => assertMemoryAuthorized('memory_list', { ...authorizedContext, consentimento_memoria_ativo: false }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_CONSENT_REQUIRED',
  );

  assert.throws(
    () => assertMemoryAuthorized('memory_delete', authorizedContext),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_OPERATION_FORBIDDEN',
  );

  assert.deepEqual(assertMemoryOwner(42, authorizedContext), authorizedContext);
  assert.throws(
    () => assertMemoryOwner(99, authorizedContext),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_OWNER_MISMATCH',
  );
});

test('não expõe o valor rejeitado nas mensagens públicas de política', () => {
  assert.throws(
    () => parseMemorySaveInput({ ...validSave, conteudo: 'Bearer token-ultra-confidencial' }),
    (error: unknown) => {
      assert.equal(error instanceof MemoryPolicyError, true);
      assert.equal((error as Error).message.includes('token-ultra-confidencial'), false);
      return true;
    },
  );
});

test('oferece parsing explícito para a futura operação de exclusão', () => {
  assert.deepEqual(parseMemoryDeleteInput({ memoria_id: 7 }), { memoria_id: 7 });
});

