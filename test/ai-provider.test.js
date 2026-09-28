import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/plenna_test';
process.env.DIRECT_URL ??= process.env.DATABASE_URL;
process.env.GOOGLE_CLIENT_ID ??= 'client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'client-secret';
process.env.GOOGLE_REDIRECT_URI ??= 'https://example.com/callback';
process.env.EMAIL_SYNC_ENABLED ??= 'true';
process.env.AI_PROVIDER = 'requesty';
process.env.REQUESTY_API_KEY = 'requesty-key';

const { env } = await import('../dist/src/lib/env.js');
const { createAIProvider } = await import('../dist/src/modules/email/ai-provider.factory.js');
const { CodexLocalError, CodexLocalProvider } = await import('../dist/src/modules/email/codex-local.provider.js');
const { RequestyProvider } = await import('../dist/src/modules/email/requesty.provider.js');

test('factory seleciona Requesty por padrão e Codex local por configuração', () => {
  const originalProvider = env.aiProvider;
  const originalProduction = env.isProduction;
  try {
    env.isProduction = false;
    env.aiProvider = 'requesty';
    assert.ok(createAIProvider() instanceof RequestyProvider);
    env.aiProvider = 'codex_local';
    assert.ok(createAIProvider() instanceof CodexLocalProvider);
  } finally {
    env.aiProvider = originalProvider;
    env.isProduction = originalProduction;
  }
});

test('factory rejeita provider inválido e Codex local em produção', () => {
  const originalProvider = env.aiProvider;
  const originalProduction = env.isProduction;
  try {
    env.aiProvider = 'provider_inexistente';
    assert.throws(() => createAIProvider(), /Provider de IA inválido/);
    env.aiProvider = 'codex_local';
    env.isProduction = true;
    assert.throws(() => createAIProvider(), /não é permitido em produção/);
  } finally {
    env.aiProvider = originalProvider;
    env.isProduction = originalProduction;
  }
});

function fakeCodex(finalResponse, error) {
  const calls = [];
  return {
    calls,
    startThread(options) {
      calls.push({ options });
      return {
        run: async (prompt, runOptions) => {
          calls.push({ prompt, runOptions });
          if (error) throw error;
          return { finalResponse };
        },
      };
    },
  };
}

test('Codex local valida resposta estruturada e executa em read-only', async () => {
  const codex = fakeCodex('{"categoryId":7}');
  const provider = new CodexLocalProvider(() => codex);
  const result = await provider.suggestCategory('texto', [{ categoryId: 7, categoryName: 'Casa' }]);
  assert.deepEqual(result, { categoryId: 7 });
  assert.equal(codex.calls[0].options.sandboxMode, 'read-only');
  assert.equal(codex.calls[0].options.approvalPolicy, 'never');
  assert.equal(codex.calls[0].options.networkAccessEnabled, false);
  assert.equal(codex.calls[1].runOptions.outputSchema.type, 'object');
});

function assertCodexSchema(schema, root = true) {
  assert.equal(schema.oneOf, undefined);
  assert.equal(schema.allOf, undefined);
  assert.equal(schema.not, undefined);
  if (root) assert.equal(schema.type, 'object');
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    for (const property of Object.values(schema.properties)) assertCodexSchema(property, false);
  }
  if (schema.items) assertCodexSchema(schema.items, false);
  for (const item of schema.anyOf ?? []) assertCodexSchema(item, false);
}

test('todos os schemas do Codex usam Structured Outputs compatível', async () => {
  const cases = [
    ['email_classification', '{"classificacao":"IGNORAR","categoryId":null,"purchase":null}', 'classifyEmail'],
    ['category_suggestion', '{"categoryId":null}', 'suggestCategory'],
    ['purchase_extraction', '{"establishment":null,"orderNumber":null,"totalAmount":null,"paymentMethodName":null,"items":[]}', 'extractPurchase'],
  ];

  for (const [operation, response, method] of cases) {
    const codex = fakeCodex(response);
    const provider = new CodexLocalProvider(() => codex);
    await provider[method]('texto', []);
    assert.equal(codex.calls[0].options.sandboxMode, 'read-only');
    assertCodexSchema(codex.calls[1].runOptions.outputSchema);
    assert.equal(codex.calls[1].runOptions.outputSchema.oneOf, undefined, operation);
  }
});

test('Codex local classifica incompatibilidade de schema separadamente', async () => {
  const error = new Error('invalid_request_error: invalid_json_schema: Invalid schema for response_format');
  await assert.rejects(
    () => new CodexLocalProvider(() => fakeCodex('', error)).suggestCategory('texto', []),
    (caught) => caught instanceof CodexLocalError && caught.code === 'invalid_json_schema',
  );
});

test('Codex local diferencia resposta vazia e JSON inválido', async () => {
  await assert.rejects(
    () => new CodexLocalProvider(() => fakeCodex('')).suggestCategory('texto', []),
    (error) => error instanceof CodexLocalError && error.code === 'empty',
  );
  await assert.rejects(
    () => new CodexLocalProvider(() => fakeCodex('não é json')).suggestCategory('texto', []),
    (error) => error instanceof CodexLocalError && error.code === 'invalid_json',
  );
});

test('Codex local diferencia timeout e erro do SDK', async () => {
  const originalTimeout = env.codexLocalTimeoutMs;
  env.codexLocalTimeoutMs = 5;
  try {
    const hangingCodex = {
      startThread: () => ({
        run: (_prompt, options) => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      }),
    };
    await assert.rejects(
      () => new CodexLocalProvider(() => hangingCodex).suggestCategory('texto', []),
      (error) => error instanceof CodexLocalError && error.code === 'timeout',
    );
    await assert.rejects(
      () => new CodexLocalProvider(() => fakeCodex('', new Error('SDK failure'))).suggestCategory('texto', []),
      (error) => error instanceof CodexLocalError && error.code === 'execution',
    );
  } finally {
    env.codexLocalTimeoutMs = originalTimeout;
  }
});
