import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://localhost:1/plenna_phase2_test';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.GOOGLE_CLIENT_ID = 'phase2-client';
process.env.GOOGLE_CLIENT_SECRET = 'phase2-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://example.test/callback';
process.env.JWT_SECRET = 'phase2-jwt-secret';
process.env.EMAIL_SYNC_ENABLED = 'false';
process.env.AI_PROVIDER = 'requesty';
process.env.REQUESTY_API_KEY = 'phase2-requesty-key';
process.env.CHAT_MAX_MESSAGE_CHARS = '4000';
process.env.CHAT_CONTEXT_MAX_MESSAGES = '30';
process.env.CHAT_CONTEXT_MAX_CHARS = '12000';

type Row = Record<string, any>;

let histories: Row[] = [];
let messages: Row[] = [];
let nextHistoryId = 1;
let nextMessageId = 1;
let failAssistantPersistence = false;

function matches(row: Row, where: Record<string, any>) {
  return Object.entries(where).every(([key, expected]) => row[key] === expected);
}

function pick(row: Row, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key]]),
  );
}

function sortRows(rows: Row[], orderBy: Record<string, string> | Array<Record<string, string>>) {
  const rules = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((left, right) => {
    for (const rule of rules) {
      const [key, direction] = Object.entries(rule)[0];
      const leftValue = left[key] instanceof Date ? left[key].getTime() : left[key];
      const rightValue = right[key] instanceof Date ? right[key].getTime() : right[key];
      if (leftValue === rightValue) continue;
      const result = leftValue > rightValue ? 1 : -1;
      return direction === 'desc' ? -result : result;
    }
    return 0;
  });
}

function makeClient() {
  const client: any = {
    tb_historico: {
      create: async ({ data, select }: any) => {
        const row = {
          historico_id: nextHistoryId++,
          ...data,
        };
        histories.push(row);
        return pick(row, select);
      },
      findMany: async ({ where, orderBy, select }: any) => sortRows(
        histories.filter((row) => matches(row, where)),
        orderBy,
      ).map((row) => pick(row, select)),
      findFirst: async ({ where, select }: any) => {
        const row = histories.find((candidate) => matches(candidate, where));
        return row ? pick(row, select) : null;
      },
      update: async ({ where, data, select }: any) => {
        const row = histories.find((candidate) => matches(candidate, where));
        if (!row) throw new Error('history not found');
        Object.assign(row, data);
        return pick(row, select);
      },
      updateMany: async ({ where, data }: any) => {
        const rows = histories.filter((candidate) => matches(candidate, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    tb_mensagem: {
      create: async ({ data, select }: any) => {
        if (failAssistantPersistence && data.mensagem_remetente === true) {
          throw new Error('assistant persistence failed');
        }
        const row = {
          mensagem_id: nextMessageId++,
          ...data,
        };
        messages.push(row);
        return pick(row, select);
      },
      findMany: async ({ where, orderBy, select }: any) => sortRows(
        messages.filter((row) => matches(row, where)),
        orderBy,
      ).map((row) => pick(row, select)),
      findFirst: async ({ where, orderBy, select }: any) => {
        const rows = messages.filter((row) => matches(row, where));
        const sorted = orderBy ? sortRows(rows, orderBy) : rows;
        return sorted[0] ? pick(sorted[0], select) : null;
      },
    },
  };

  client.$transaction = async (callback: (transaction: any) => Promise<unknown>) => callback(client);
  return client;
}

const client = makeClient();
(globalThis as any).prismaRuntime = { client, pool: { end: async () => {} } };

const { ChatFirstMessageError, ChatService } = await import('../../src/modules/chat/chat.service.js');
const { buildChatContext } = await import('../../src/modules/chat/chat.context.js');
const { PLENNA_CHAT_SYSTEM_PROMPT } = await import('../../src/modules/chat/chat.prompt.js');
const { AIProviderError } = await import('../../src/modules/email/ai-provider.js');
const { RequestyProvider } = await import('../../src/modules/email/requesty.provider.js');
const { CodexLocalError, CodexLocalProvider } = await import('../../src/modules/email/codex-local.provider.js');
const { env } = await import('../../src/lib/env.js');
const { ZodError } = await import('zod');
const { ChatController } = await import('../../src/modules/chat/chat.controller.js');
const { AppError } = await import('../../src/errors/AppError.js');
const { handleError } = await import('../../src/utils/handleError.js');

function reset() {
  histories = [];
  messages = [];
  nextHistoryId = 1;
  nextMessageId = 1;
  failAssistantPersistence = false;
}

function providerReturning(text: string, contexts: any[] = []) {
  return {
    classifyEmail: async () => ({ classificacao: 'IGNORAR' as const }),
    suggestCategory: async () => ({ categoryId: null }),
    chat: async (context: any[]) => {
      contexts.push(context);
      return text;
    },
  };
}

beforeEach(reset);

test('monta contexto com system, roles cronologicas, limite de mensagens e mensagem atual unica', () => {
  const at = new Date('2026-10-13T10:00:00.000Z');
  const current = {
    mensagem_id: 3,
    historico_id: 1,
    remetente: 'user' as const,
    texto: 'Atual',
    mensagem_data_criacao: new Date(at.getTime() + 2_000),
  };
  const result = buildChatContext([
    { ...current },
    { mensagem_id: 1, historico_id: 1, remetente: 'user', texto: 'Antiga', mensagem_data_criacao: at },
    { mensagem_id: 2, historico_id: 1, remetente: 'assistant', texto: 'Resposta', mensagem_data_criacao: new Date(at.getTime() + 1_000) },
  ], current, { maxMessages: 2, maxChars: PLENNA_CHAT_SYSTEM_PROMPT.length + 4 + 'Atual'.length + 30 });

  assert.equal(result[0].role, 'system');
  assert.equal(result[0].content, PLENNA_CHAT_SYSTEM_PROMPT);
  assert.deepEqual(result.slice(1).map((message) => [message.role, message.content]), [
    ['assistant', 'Resposta'],
    ['user', 'Atual'],
  ]);
  assert.equal(result.filter((message) => message.content === 'Atual').length, 1);
  assert.ok(result.reduce((total, message) => total + message.role.length + 1 + message.content.length, 0) <= PLENNA_CHAT_SYSTEM_PROMPT.length + 4 + 'Atual'.length + 30);
});

test('falha antes da persistencia quando system prompt e mensagem atual nao cabem', async () => {
  const history = await ChatService.createHistory(1, client);
  const originalMaxChars = env.chatContextMaxChars;
  env.chatContextMaxChars = 10;
  await assert.rejects(
    () => ChatService.sendMessage(1, history.historico_id, { texto: 'texto' }, client, () => providerReturning('resposta') as any),
    (error: any) => error.statusCode === 400,
  );
  env.chatContextMaxChars = originalMaxChars;
  assert.equal(messages.length, 0);
});

test('envia, preserva contexto autorizado e persiste user e assistant sem duplicar atual', async () => {
  const history = await ChatService.createHistory(1, client);
  await ChatService.createUserMessage(1, history.historico_id, { texto: 'Antes' }, client);
  await ChatService.createAssistantMessage(1, history.historico_id, 'Resposta anterior', client);
  const contexts: any[] = [];

  const result = await ChatService.sendMessage(
    1,
    history.historico_id,
    { texto: 'Pergunta atual' },
    client,
    () => providerReturning('Resposta atual', contexts) as any,
  );

  assert.equal(result.mensagemUsuario.remetente, 'user');
  assert.equal(result.mensagemIA.remetente, 'assistant');
  assert.equal(messages.filter((message) => message.historico_id === history.historico_id).length, 4);
  assert.deepEqual(contexts[0].map((message: any) => message.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(contexts[0].filter((message: any) => message.content === 'Pergunta atual').length, 1);
  assert.equal(contexts[0].some((message: any) => message.content === 'Resposta atual'), false);
  assert.equal(histories[0].historico_nome, 'Antes');
  assert.ok(histories[0].historico_data_modificacao >= histories[0].historico_data_criacao);
});

test('deriva titulo da primeira mensagem, normaliza espacos e respeita 45 caracteres', async () => {
  const history = await ChatService.createHistory(1, client);
  const text = '  Uma   conversa muito longa para caber no titulo do historico sem exceder 45  ';
  await ChatService.createUserMessage(1, history.historico_id, { texto: text }, client);
  assert.equal(histories[0].historico_nome.length <= 45, true);
  assert.equal(histories[0].historico_nome, 'Uma conversa muito longa para caber no titulo');
  await ChatService.createUserMessage(1, history.historico_id, { texto: 'Segundo texto' }, client);
  assert.equal(histories[0].historico_nome, 'Uma conversa muito longa para caber no titulo');
});

test('gera titulo com o provider apenas na primeira mensagem e preserva fallback quando falha', async () => {
  const history = await ChatService.createHistory(1, client);
  let titleCalls = 0;
  const provider = {
    ...providerReturning('Resposta'),
    generateTitle: async () => {
      titleCalls += 1;
      return '  **Dúvida sobre compra de roupas**  ';
    },
  };

  await ChatService.sendMessage(1, history.historico_id, { texto: 'Quero comprar roupas sem estourar o orçamento' }, client, () => provider as any);
  assert.equal(histories[0].historico_nome, 'Dúvida sobre compra de roupas');
  await ChatService.sendMessage(1, history.historico_id, { texto: 'E como planejar essa compra?' }, client, () => provider as any);
  assert.equal(titleCalls, 1);

  const fallbackHistory = await ChatService.createHistory(1, client);
  const failingTitleProvider = {
    ...providerReturning('Resposta sem falha geral'),
    generateTitle: async () => { throw new Error('title provider unavailable'); },
  };
  await ChatService.sendMessage(1, fallbackHistory.historico_id, { texto: '  Uma conversa com fallback  ' }, client, () => failingTitleProvider as any);
  assert.equal(histories.find((row) => row.historico_id === fallbackHistory.historico_id)?.historico_nome, 'Uma conversa com fallback');
  assert.equal(messages.filter((message) => message.historico_id === fallbackHistory.historico_id).length, 2);
});

test('primeira mensagem cria historico e mensagem na mesma transacao curta', async () => {
  const result = await ChatService.sendFirstMessage(1, { texto: 'Começar uma conversa sem historico previo' }, client, () => providerReturning('Resposta inicial') as any);
  assert.equal(result.historico.historico_id, 1);
  assert.equal(result.mensagemUsuario.remetente, 'user');
  assert.equal(result.mensagemIA.remetente, 'assistant');
  assert.equal(histories.length, 1);
  assert.equal(messages.length, 2);
});

test('ownership bloqueia outro usuario antes de persistir', async () => {
  const history = await ChatService.createHistory(2, client);
  await assert.rejects(
    () => ChatService.sendMessage(1, history.historico_id, { texto: 'IDOR' }, client, () => providerReturning('nao') as any),
    (error: any) => error.statusCode === 404,
  );
  assert.equal(messages.length, 0);
});

test('timeout, erro do provider e resposta vazia preservam user sem confirmar assistant', async () => {
  const cases = [
    { error: new AIProviderError('timeout', 'timeout'), status: 504 },
    { error: new AIProviderError('failure', 'failure'), status: 502 },
    { response: '', status: 502 },
  ];

  for (const scenario of cases) {
    reset();
    const history = await ChatService.createHistory(1, client);
    const provider = () => ({
      classifyEmail: async () => ({ classificacao: 'IGNORAR' as const }),
      suggestCategory: async () => ({ categoryId: null }),
      chat: async () => {
        if ('error' in scenario) throw scenario.error;
        return scenario.response;
      },
    });

    await assert.rejects(
      () => ChatService.sendMessage(1, history.historico_id, { texto: 'Falha controlada' }, client, provider as any),
      (error: any) => error.statusCode === scenario.status,
    );
    assert.equal(messages.filter((message) => message.mensagem_remetente === true).length, 0);
    assert.equal(messages.filter((message) => message.mensagem_remetente === false).length, 1);
  }
});

test('falha de persistencia da resposta nao retorna sucesso e preserva somente user', async () => {
  const history = await ChatService.createHistory(1, client);
  failAssistantPersistence = true;
  await assert.rejects(
    () => ChatService.sendMessage(1, history.historico_id, { texto: 'Persistir user' }, client, () => providerReturning('Resposta') as any),
    /assistant persistence failed/,
  );
  assert.equal(messages.filter((message) => message.mensagem_remetente === false).length, 1);
  assert.equal(messages.filter((message) => message.mensagem_remetente === true).length, 0);
});

test('handleError preserva contratos 400, 404 e 500 e controller responde 401', async () => {
  function response() {
    const result: any = { statusCode: 200, body: undefined };
    result.status = (code: number) => { result.statusCode = code; return result; };
    result.json = (body: unknown) => { result.body = body; return result; };
    return result;
  }

  const zodResponse = response();
  handleError(zodResponse, 500, new ZodError([]));
  assert.equal(zodResponse.statusCode, 400);

  const notFoundResponse = response();
  handleError(notFoundResponse, 500, new AppError('not found', 404));
  assert.equal(notFoundResponse.statusCode, 404);

  const unexpectedResponse = response();
  handleError(unexpectedResponse, 400, new Error('unexpected'));
  assert.equal(unexpectedResponse.statusCode, 500);

  const unauthorized = response();
  await ChatController.createMessage({ params: { historicoId: '1' }, body: { texto: 'x' } } as any, unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const invalidBody = response();
  await ChatController.createMessage({ userId: 1, params: { historicoId: '1' }, body: { texto: '   ' } } as any, invalidBody);
  assert.equal(invalidBody.statusCode, 400);

  const originalSendMessage = (ChatService as any).sendMessage;
  const originalSendFirstMessage = (ChatService as any).sendFirstMessage;
  try {
    (ChatService as any).sendMessage = async () => { throw new AppError('Historico nao encontrado', 404); };
    const notFound = response();
    await ChatController.createMessage({ userId: 1, params: { historicoId: '1' }, body: { texto: 'x' } } as any, notFound);
    assert.equal(notFound.statusCode, 404);

    (ChatService as any).sendMessage = async () => { throw new Error('unexpected'); };
    const internal = response();
    await ChatController.createMessage({ userId: 1, params: { historicoId: '1' }, body: { texto: 'x' } } as any, internal);
    assert.equal(internal.statusCode, 500);

    (ChatService as any).sendFirstMessage = async () => {
      throw new ChatFirstMessageError(9, new AppError('Falha ao consultar a IA', 502));
    };
    const partial = response();
    await ChatController.createFirstMessage({ userId: 1, body: { texto: 'primeira' } } as any, partial);
    assert.equal(partial.statusCode, 502);
    assert.equal(partial.body.historico_id, 9);
  } finally {
    (ChatService as any).sendMessage = originalSendMessage;
    (ChatService as any).sendFirstMessage = originalSendFirstMessage;
  }
});

test('Requesty conversacional envia roles estruturadas e texto livre sem response_format', async () => {
  const axios = (await import('axios')).default as any;
  const originalPost = axios.post;
  const calls: any[] = [];
  env.requestyApiKey = 'mock-key';
  env.requestyChatModel = 'mock-chat-model';
  axios.post = async (...args: any[]) => {
    calls.push(args);
    return { data: { choices: [{ message: { content: 'Resposta textual' } }] } };
  };

  try {
    const result = await new RequestyProvider().chat([
      { role: 'system', content: 'Sistema' },
      { role: 'user', content: 'Pergunta' },
      { role: 'assistant', content: 'Anterior' },
    ]);
    assert.equal(result, 'Resposta textual');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].model, 'mock-chat-model');
    assert.deepEqual(calls[0][1].messages.map((message: any) => message.role), ['system', 'user', 'assistant']);
    assert.equal('response_format' in calls[0][1], false);
  } finally {
    axios.post = originalPost;
  }
});

test('Requesty conversacional diferencia timeout, resposta vazia e nao faz retry', async () => {
  const axios = (await import('axios')).default as any;
  const originalPost = axios.post;
  let calls = 0;
  try {
    axios.post = async () => {
      calls += 1;
      const error: any = new Error('timeout');
      error.code = 'ECONNABORTED';
      throw error;
    };
    await assert.rejects(
      () => new RequestyProvider().chat([{ role: 'user', content: 'x' }]),
      (error: any) => error instanceof AIProviderError && error.code === 'timeout',
    );
    assert.equal(calls, 1);

    axios.post = async () => ({ data: { choices: [{ message: { content: '   ' } }] } });
    await assert.rejects(
      () => new RequestyProvider().chat([{ role: 'user', content: 'x' }]),
      (error: any) => error instanceof AIProviderError && error.code === 'empty',
    );
  } finally {
    axios.post = originalPost;
  }
});

test('CodexLocal conversacional envia contexto textual completo sem outputSchema e preserva isolamento', async () => {
  const calls: any[] = [];
  const fakeCodex: any = {
    startThread: (options: any) => {
      calls.push({ options });
      return {
        run: async (prompt: string, options: any) => {
          calls.push({ prompt, runOptions: options });
          return { finalResponse: 'Resposta local' };
        },
      };
    },
  };
  const result = await new CodexLocalProvider(() => fakeCodex).chat([
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Pergunta' },
  ]);

  assert.equal(result, 'Resposta local');
  assert.equal(calls[0].options.sandboxMode, 'read-only');
  assert.equal(calls[0].options.approvalPolicy, 'never');
  assert.equal(calls[0].options.networkAccessEnabled, false);
  assert.match(calls[1].prompt, /SYSTEM[\s\S]*USER/);
  assert.equal('outputSchema' in calls[1].runOptions, false);
});

test('CodexLocal conversacional converte timeout sem depender de schema', async () => {
  const originalTimeout = env.codexLocalTimeoutMs;
  env.codexLocalTimeoutMs = 5;
  try {
    const hangingCodex: any = {
      startThread: () => ({
        run: (_prompt: string, options: any) => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      }),
    };
    await assert.rejects(
      () => new CodexLocalProvider(() => hangingCodex).chat([{ role: 'user', content: 'x' }]),
      (error: any) => error instanceof CodexLocalError && error.code === 'timeout',
    );
  } finally {
    env.codexLocalTimeoutMs = originalTimeout;
  }
});

