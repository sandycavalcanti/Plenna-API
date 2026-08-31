import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? 'client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? 'client-secret';
process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? 'https://example.com/callback';
process.env.CRON_SECRET = process.env.CRON_SECRET ?? 'cron-secret';
process.env.REQUESTY_API_KEY = process.env.REQUESTY_API_KEY ?? 'requesty-key';

const axios = (await import('axios')).default;
const { emailRouter } = await import('../dist/src/modules/email/email.routes.js');
const { EmailController } = await import('../dist/src/modules/email/email.controller.js');
const { EmailSyncService } = await import('../dist/src/modules/email/email-sync.service.js');
const { GeminiProvider } = await import('../dist/src/modules/email/gemini.provider.js');
const { RequestyProvider } = await import('../dist/src/modules/email/requesty.provider.js');
const { EmailClassificationEngine } = await import('../dist/src/modules/email/classification.engine.js');
const { EmailService } = await import('../dist/src/modules/email/email.service.js');
const { DashboardService } = await import('../dist/src/modules/dashboard/dashboard.service.js');
const { CompraService } = await import('../dist/src/modules/compra/compra.service.js');
const { createCompraSchema } = await import('../dist/src/modules/compra/compra.schemas.js');
const { prisma } = await import('../dist/src/lib/prisma.js');
const { env } = await import('../dist/src/lib/env.js');

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    redirect(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

function routeMethods(path) {
  return emailRouter.stack
    .filter((layer) => layer.route?.path === path)
    .flatMap((layer) => Object.keys(layer.route.methods).filter((method) => layer.route.methods[method]));
}

test('cron route registrada em GET e POST', () => {
  const methods = routeMethods('/sync/cron');
  assert.deepEqual(new Set(methods), new Set(['get', 'post']));
});

test('cron GET aceita Authorization Bearer válido', async () => {
  const original = EmailSyncService.syncAllUsers;
  EmailSyncService.syncAllUsers = async () => ({ processedUsers: 1 });

  const req = { header: (name) => (name === 'authorization' ? 'Bearer cron-secret' : undefined) };
  const res = fakeResponse();
  await EmailController.syncCron(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.processedUsers, 1);

  EmailSyncService.syncAllUsers = original;
});

test('cron sem auth rejeita', async () => {
  const req = { header: () => undefined };
  const res = fakeResponse();
  await EmailController.syncCron(req, res);
  assert.equal(res.statusCode, 401);
});

test('cron com auth inválida rejeita', async () => {
  const req = { header: (name) => (name === 'authorization' ? 'Bearer errado' : undefined) };
  const res = fakeResponse();
  await EmailController.syncCron(req, res);
  assert.equal(res.statusCode, 401);
});

test('callback OAuth redireciona para o app no sucesso', async () => {
  const originalExchange = EmailService.exchangeCodeForTokens;
  const originalEmail = EmailService.getGoogleUserEmail;
  const originalSave = EmailService.saveIntegration;
  EmailService.exchangeCodeForTokens = async () => ({ access_token: 'token', expires_in: 3600, refresh_token: 'refresh' });
  EmailService.getGoogleUserEmail = async () => 'user@example.com';
  EmailService.saveIntegration = async () => ({});

  const req = { query: { code: 'abc', state: '1' } };
  const res = fakeResponse();
  await EmailController.callback(req, res);

  assert.equal(res.body, `${env.apiBaseUrl}/oauth-success.html`);

  EmailService.exchangeCodeForTokens = originalExchange;
  EmailService.getGoogleUserEmail = originalEmail;
  EmailService.saveIntegration = originalSave;
});

test('callback OAuth redireciona para o app no erro', async () => {
  const originalExchange = EmailService.exchangeCodeForTokens;
  EmailService.exchangeCodeForTokens = async () => {
    throw new Error('falha');
  };

  const req = { query: { code: 'abc', state: '1' } };
  const res = fakeResponse();
  await EmailController.callback(req, res);

  assert.equal(res.body, 'plenna://oauth-error');

  EmailService.exchangeCodeForTokens = originalExchange;
});

test('RequestyProvider rejeita ausência de API key', async () => {
  const previous = env.requestyApiKey;
  env.requestyApiKey = '';
  const provider = new RequestyProvider();
  await assert.rejects(() => provider.classifyEmail('teste'));
  env.requestyApiKey = previous;
});

test('RequestyProvider rejeita resposta inválida', async () => {
  const previous = env.requestyApiKey;
  env.requestyApiKey = 'key';
  const originalPost = axios.post;
  axios.post = async () => ({ data: { choices: [{ message: { content: 'not-json' } }] } });
  const provider = new RequestyProvider();
  await assert.rejects(() => provider.classifyEmail('teste'));
  axios.post = originalPost;
  env.requestyApiKey = previous;
});

test('RequestyProvider classifica e sugere categoria a partir de choices[0].message.content', async () => {
  const previous = env.requestyApiKey;
  env.requestyApiKey = 'key';
  const originalPost = axios.post;
  const responses = [
    { data: { choices: [{ message: { content: JSON.stringify({ classificacao: 'COMPRA', purchase: { amount: 10 } }) } }] } },
    { data: { choices: [{ message: { content: JSON.stringify({ categoryName: 'Eletrônicos' }) } }] } },
  ];
  let index = 0;
  axios.post = async () => responses[index++] ?? responses[responses.length - 1];

  const provider = new RequestyProvider();
  const classified = await provider.classifyEmail('teste');
  const suggested = await provider.suggestCategory('teste');

  assert.equal(classified.classificacao, 'COMPRA');
  assert.equal(Number(classified.purchase.amount), 10);
  assert.equal(suggested.categoryName, 'Eletrônicos');

  axios.post = originalPost;
  env.requestyApiKey = previous;
});

test('RequestyProvider converte 429 em erro genérico de rate limit', async () => {
  const previous = env.requestyApiKey;
  env.requestyApiKey = 'key';
  const originalPost = axios.post;
  axios.post = async () => {
    const error = new Error('retry in 30 seconds');
    error.response = {
      status: 429,
      data: { error: { message: 'Please retry in 30 seconds' } },
      headers: { 'retry-after': '30' },
    };
    throw error;
  };

  const provider = new RequestyProvider();
  await assert.rejects(() => provider.classifyEmail('teste'), (error) => error.name === 'AIRateLimitError');

  axios.post = originalPost;
  env.requestyApiKey = previous;
});

test('schema de compra manual rejeita controle de email/status', () => {
  assert.throws(() => createCompraSchema.parse({
    compraHorario: new Date('2026-08-10T12:00:00Z'),
    compraClassificacao: 'PENDENTE',
    compraEmail: true,
    compraStatus: 'AGUARDANDO_CONFIRMACAO',
  }));
});

test('compra manual é criada pelo backend como confirmada e não email', async () => {
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = async (cb) =>
    cb({
      tb_usuario: {
        findFirst: async () => ({ usuario_meta_valor_compra: null }),
      },
      tb_forma_pagamento: {
        findUnique: async () => null,
      },
      tb_categoria: {
        count: async () => 0,
      },
      tb_compra: {
        create: async ({ data }) => data,
        findMany: async () => [],
      },
      tb_compra_item: {
        createMany: async () => ({}),
      },
      tb_metricas: {
        findFirst: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
    });

  const result = await CompraService.create(1, {
    compraHorario: new Date('2026-08-10T12:00:00Z'),
    compraClassificacao: 'PENDENTE',
    compraValor: 15,
  });

  assert.equal(result.compra.compra_email, false);
  assert.equal(result.compra.compra_status, 'CONFIRMADA');

  prisma.$transaction = originalTransaction;
});

test('compra manual com compraValor válido funciona', async () => {
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = async (cb) =>
    cb({
      tb_usuario: {
        findFirst: async () => ({ usuario_meta_valor_compra: null }),
      },
      tb_forma_pagamento: {
        findUnique: async () => null,
      },
      tb_categoria: {
        count: async () => 0,
      },
      tb_compra: {
        create: async ({ data }) => data,
        findMany: async () => [],
      },
      tb_compra_item: {
        createMany: async () => ({}),
      },
      tb_metricas: {
        findFirst: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
    });

  const result = await CompraService.create(1, {
    compraHorario: new Date('2026-08-10T12:00:00Z'),
    compraClassificacao: 'PENDENTE',
    compraValor: 42,
  });

  assert.equal(Number(result.compra.compra_valor), 42);
  assert.equal(result.compra.compra_status, 'CONFIRMADA');

  prisma.$transaction = originalTransaction;
});

test('compra manual apenas com items funciona', async () => {
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = async (cb) =>
    cb({
      tb_usuario: {
        findFirst: async () => ({ usuario_meta_valor_compra: null }),
      },
      tb_forma_pagamento: {
        findUnique: async () => null,
      },
      tb_categoria: {
        count: async ({ where }) => (where.categoria_id.in.length === 1 ? 1 : 2),
      },
      tb_compra: {
        create: async ({ data }) => data,
        findMany: async () => [],
      },
      tb_compra_item: {
        createMany: async () => ({}),
      },
      tb_metricas: {
        findFirst: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
    });

  const result = await CompraService.create(1, {
    compraHorario: new Date('2026-08-10T12:00:00Z'),
    compraClassificacao: 'PENDENTE',
    items: [
      { categoriaId: 1, nome: 'Item A', valor: 50 },
      { categoriaId: 2, nome: 'Item B', valor: 30 },
    ],
  });

  assert.equal(Number(result.compra.compra_valor), 80);
  assert.equal(result.compra.compra_status, 'CONFIRMADA');

  prisma.$transaction = originalTransaction;
});

test('compra manual sem valor e sem items falha', async () => {
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = async (cb) =>
    cb({
      tb_usuario: {
        findFirst: async () => ({ usuario_meta_valor_compra: null }),
      },
      tb_forma_pagamento: {
        findUnique: async () => null,
      },
      tb_categoria: {
        count: async () => 0,
      },
      tb_compra: {
        create: async ({ data }) => data,
        findMany: async () => [],
      },
      tb_compra_item: {
        createMany: async () => ({}),
      },
      tb_metricas: {
        findFirst: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
    });

  await assert.rejects(() => CompraService.create(1, {
    compraHorario: new Date('2026-08-10T12:00:00Z'),
    compraClassificacao: 'PENDENTE',
  }));

  prisma.$transaction = originalTransaction;
});

test('PUT de compra pendente com valor nulo pode alterar outros campos sem confirmar', async () => {
  const originalFindFirst = prisma.tb_compra.findFirst;
  const originalUpdate = prisma.tb_compra.update;
  const originalTransaction = prisma.$transaction;

  let current = {
    compra_id: 50,
    usuario_id: 1,
    compra_status: 'AGUARDANDO_CONFIRMACAO',
    compra_valor: null,
    compra_horario: new Date('2026-08-10T12:00:00Z'),
    compra_usuario_concorda: null,
    compra_usuario_anotacao: null,
    compra_classificacao: 'PENDENTE',
    compra_email: true,
    compra_fonte: null,
    forma_pagamento_id: null,
  };

  prisma.tb_compra.findFirst = async () => current;
  prisma.$transaction = async (cb) =>
    cb({
      tb_forma_pagamento: {
        findUnique: async () => null,
      },
      tb_categoria: {
        count: async () => 0,
      },
      tb_compra: {
        findFirst: async () => current,
        update: async ({ data }) => {
          current = { ...current, ...data };
          return current;
        },
        findMany: async () => [],
        create: async () => current,
      },
      tb_compra_item: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
      },
      tb_usuario: {
        findFirst: async () => ({ usuario_meta_valor_compra: null }),
      },
      tb_metricas: {
        findFirst: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
    });
  prisma.tb_compra.update = async ({ data }) => {
    current = { ...current, ...data };
    return current;
  };

  const result = await CompraService.update(1, 50, {
    compraFonte: 'Nova fonte',
  });

  assert.equal(result.compra.compra_status, 'AGUARDANDO_CONFIRMACAO');
  assert.equal(result.compra.compra_fonte, 'Nova fonte');
  assert.equal(result.compra.compra_valor, null);

  prisma.tb_compra.findFirst = originalFindFirst;
  prisma.$transaction = originalTransaction;
  prisma.tb_compra.update = originalUpdate;
});

test('compra confirmada não pode perder o valor no update', async () => {
  const originalFindFirst = prisma.tb_compra.findFirst;
  const originalUpdate = prisma.tb_compra.update;
  const originalTransaction = prisma.$transaction;

  let current = {
    compra_id: 60,
    usuario_id: 1,
    compra_status: 'CONFIRMADA',
    compra_valor: 100,
    compra_horario: new Date('2026-08-10T12:00:00Z'),
    compra_usuario_concorda: null,
    compra_usuario_anotacao: null,
    compra_classificacao: 'PENDENTE',
    compra_email: false,
    compra_fonte: 'Amazon',
    forma_pagamento_id: null,
  };
  let draft = null;

  prisma.tb_compra.findFirst = async () => current;
  prisma.$transaction = async (cb) =>
    (() => {
      draft = { ...current };
      return cb({
      tb_forma_pagamento: {
        findUnique: async () => null,
      },
      tb_categoria: {
        count: async () => 0,
      },
      tb_compra: {
        findFirst: async () => draft,
        update: async ({ data }) => {
          draft = { ...draft, ...data };
          return draft;
        },
        findMany: async () => [],
        create: async () => current,
      },
      tb_compra_item: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
      },
      tb_usuario: {
        findFirst: async () => ({ usuario_meta_valor_compra: null }),
      },
      tb_metricas: {
        findFirst: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
    }).then((result) => {
      current = draft;
      return result;
    });
    })();

  await assert.rejects(() => CompraService.update(1, 60, {
    items: [],
  }), { message: 'Compra confirmada deve possuir valor' });

  assert.equal(current.compra_status, 'CONFIRMADA');
  assert.equal(Number(current.compra_valor), 100);

  prisma.tb_compra.findFirst = originalFindFirst;
  prisma.$transaction = originalTransaction;
});

test('sync clara não chama IA e adquire lock', async () => {
  const originalFind = EmailService.findIntegrationByUserId;
  const originalToken = EmailService.getValidAccessToken;
  const originalList = EmailService.listMessages;
  const originalGet = EmailService.getMessage;
  const originalClassify = RequestyProvider.prototype.classifyEmail;
  const originalUpdateMany = prisma.tb_integracao.updateMany;
  const originalUpdate = prisma.tb_integracao.update;
  const originalCreate = prisma.tb_compra.create;
  let classifyCalls = 0;

  EmailService.findIntegrationByUserId = async () => ({
    integracao_id: 10,
    usuario_id: 1,
    integracao_email: 'user@example.com',
    integracao_access_token: 'token',
    integracao_refresh_token: 'refresh',
    integracao_token_expira_em: new Date(Date.now() + 60_000),
    integracao_ultima_sincronizacao_em: null,
  });
  EmailService.getValidAccessToken = async () => 'token';
  EmailService.listMessages = async () => [{ id: 'm1' }];
  EmailService.getMessage = async () => ({
    id: 'm1',
    subject: 'Pedido confirmado - compra aprovada',
    from: 'Loja <vendas@loja.com>',
    snippet: 'Pagamento aprovado e nota fiscal emitida',
    labelIds: [],
    internalDate: String(Date.parse('2026-08-10T12:00:00Z')),
  });
  RequestyProvider.prototype.classifyEmail = async () => {
    classifyCalls += 1;
    return { classificacao: 'IGNORAR' };
  };
  prisma.tb_integracao.updateMany = async () => ({ count: 1 });
  prisma.tb_integracao.update = async () => ({});
  prisma.tb_compra.create = async () => ({ compra_id: 1 });

  const result = await EmailSyncService.syncUser(1);
  assert.equal(result.status, undefined);
  assert.equal(classifyCalls, 0);

  EmailService.findIntegrationByUserId = originalFind;
  EmailService.getValidAccessToken = originalToken;
  EmailService.listMessages = originalList;
  EmailService.getMessage = originalGet;
  RequestyProvider.prototype.classifyEmail = originalClassify;
  prisma.tb_integracao.updateMany = originalUpdateMany;
  prisma.tb_integracao.update = originalUpdate;
  prisma.tb_compra.create = originalCreate;
});

test('sync ambígua chama IA e falha não avança timestamp', async () => {
  const updates = [];
  const originalFind = EmailService.findIntegrationByUserId;
  const originalToken = EmailService.getValidAccessToken;
  const originalList = EmailService.listMessages;
  const originalGet = EmailService.getMessage;
  const originalClassify = RequestyProvider.prototype.classifyEmail;
  const originalSuggest = RequestyProvider.prototype.suggestCategory;
  const originalUpdateMany = prisma.tb_integracao.updateMany;
  const originalUpdate = prisma.tb_integracao.update;
  const originalCreateCompra = prisma.tb_compra.create;
  const originalCreateProp = prisma.tb_propaganda.create;

  EmailService.findIntegrationByUserId = async () => ({
    integracao_id: 11,
    usuario_id: 2,
    integracao_email: 'user@example.com',
    integracao_access_token: 'token',
    integracao_refresh_token: 'refresh',
    integracao_token_expira_em: new Date(Date.now() + 60_000),
    integracao_ultima_sincronizacao_em: new Date('2026-08-01T09:00:00Z'),
  });
  EmailService.getValidAccessToken = async () => 'token';
  EmailService.listMessages = async () => [{ id: 'm2' }];
  EmailService.getMessage = async () => ({
    id: 'm2',
    subject: 'Boletim semanal',
    from: 'Newsletter <news@service.com>',
    snippet: 'Conteúdo promocional sem sinal de compra',
    labelIds: ['CATEGORY_PROMOTIONS'],
    internalDate: String(Date.parse('2026-08-10T12:00:00Z')),
  });
  RequestyProvider.prototype.classifyEmail = async () => {
    throw new Error('IA indisponível');
  };
  RequestyProvider.prototype.suggestCategory = async () => ({ categoryName: null });
  prisma.tb_integracao.updateMany = async () => ({ count: 1 });
  prisma.tb_integracao.update = async ({ data }) => {
    updates.push(data);
    return {};
  };
  prisma.tb_compra.create = async () => ({ compra_id: 1 });
  prisma.tb_propaganda.create = async () => ({ propaganda_id: 1 });

  await assert.rejects(() => EmailSyncService.syncUser(2));
  assert.equal(updates.some((update) => update.integracao_ultima_sincronizacao_em), false);
  assert.equal(updates.at(-1).integracao_sincronizacao_status, 'ERRO');

  EmailService.findIntegrationByUserId = originalFind;
  EmailService.getValidAccessToken = originalToken;
  EmailService.listMessages = originalList;
  EmailService.getMessage = originalGet;
  RequestyProvider.prototype.classifyEmail = originalClassify;
  RequestyProvider.prototype.suggestCategory = originalSuggest;
  prisma.tb_integracao.updateMany = originalUpdateMany;
  prisma.tb_integracao.update = originalUpdate;
  prisma.tb_compra.create = originalCreateCompra;
  prisma.tb_propaganda.create = originalCreateProp;
});

test('sync respeita limite máximo de mensagens por execução', async () => {
  const originalEnvLimit = env.emailSyncMaxMessagesPerRun;
  const originalFind = EmailService.findIntegrationByUserId;
  const originalToken = EmailService.getValidAccessToken;
  const originalList = EmailService.listMessages;
  const originalGet = EmailService.getMessage;
  const originalUpdateMany = prisma.tb_integracao.updateMany;
  const originalUpdate = prisma.tb_integracao.update;
  const originalCreate = prisma.tb_compra.create;
  let createCalls = 0;

  env.emailSyncMaxMessagesPerRun = 1;
  EmailService.findIntegrationByUserId = async () => ({
    integracao_id: 12,
    usuario_id: 3,
    integracao_email: 'user@example.com',
    integracao_access_token: 'token',
    integracao_refresh_token: 'refresh',
    integracao_token_expira_em: new Date(Date.now() + 60_000),
    integracao_ultima_sincronizacao_em: new Date('2026-08-01T09:00:00Z'),
  });
  EmailService.getValidAccessToken = async () => 'token';
  EmailService.listMessages = async () => [{ id: 'm1' }, { id: 'm2' }];
  EmailService.getMessage = async (accessToken, id) => ({
    id,
    subject: `Pedido confirmado ${id}`,
    from: 'Loja <vendas@loja.com>',
    snippet: 'Pagamento aprovado',
    labelIds: [],
    internalDate: String(Date.parse('2026-08-10T12:00:00Z')),
  });
  prisma.tb_integracao.updateMany = async () => ({ count: 1 });
  prisma.tb_integracao.update = async () => ({});
  prisma.tb_compra.create = async ({ data }) => {
    createCalls += 1;
    return data;
  };

  await assert.rejects(() => EmailSyncService.syncUser(3), /Limite de 1 mensagens por execução atingido/);
  assert.equal(createCalls, 1);

  env.emailSyncMaxMessagesPerRun = originalEnvLimit;
  EmailService.findIntegrationByUserId = originalFind;
  EmailService.getValidAccessToken = originalToken;
  EmailService.listMessages = originalList;
  EmailService.getMessage = originalGet;
  prisma.tb_integracao.updateMany = originalUpdateMany;
  prisma.tb_integracao.update = originalUpdate;
  prisma.tb_compra.create = originalCreate;
});

test('rate limit do Gemini não gera sequência descontrolada de chamadas', async () => {
  const originalFind = EmailService.findIntegrationByUserId;
  const originalToken = EmailService.getValidAccessToken;
  const originalList = EmailService.listMessages;
  const originalGet = EmailService.getMessage;
  const originalClassify = EmailClassificationEngine.classify;
  const originalUpdateMany = prisma.tb_integracao.updateMany;
  const originalUpdate = prisma.tb_integracao.update;
  const originalPost = axios.post;
  const originalRateLimitUntil = RequestyProvider.rateLimitedUntil;
  let axiosCalls = 0;

  RequestyProvider.rateLimitedUntil = 0;
  EmailService.findIntegrationByUserId = async () => ({
    integracao_id: 13,
    usuario_id: 4,
    integracao_email: 'user@example.com',
    integracao_access_token: 'token',
    integracao_refresh_token: 'refresh',
    integracao_token_expira_em: new Date(Date.now() + 60_000),
    integracao_ultima_sincronizacao_em: new Date('2026-08-01T09:00:00Z'),
  });
  EmailService.getValidAccessToken = async () => 'token';
  EmailService.listMessages = async () => [{ id: 'm1' }];
  EmailService.getMessage = async () => ({
    id: 'm1',
    subject: 'Atualização da conta',
    from: 'Serviço <no-reply@service.com>',
    snippet: 'Mensagem que não resolve sozinha',
    labelIds: [],
    internalDate: String(Date.parse('2026-08-10T12:00:00Z')),
  });
  EmailClassificationEngine.classify = () => ({ outcome: 'AMBIGUA' });
  prisma.tb_integracao.updateMany = async () => ({ count: 1 });
  prisma.tb_integracao.update = async () => ({});
  axios.post = async () => {
    axiosCalls += 1;
    const error = new Error('Please retry in 60 seconds');
    error.response = {
      status: 429,
      data: { message: 'Please retry in 60 seconds' },
      headers: { 'retry-after': '60' },
    };
    throw error;
  };

  await assert.rejects(() => EmailSyncService.syncUser(4));
  await assert.rejects(() => EmailSyncService.syncUser(4));
  assert.equal(axiosCalls, 1);

  RequestyProvider.rateLimitedUntil = originalRateLimitUntil;
  EmailService.findIntegrationByUserId = originalFind;
  EmailService.getValidAccessToken = originalToken;
  EmailService.listMessages = originalList;
  EmailService.getMessage = originalGet;
  EmailClassificationEngine.classify = originalClassify;
  prisma.tb_integracao.updateMany = originalUpdateMany;
  prisma.tb_integracao.update = originalUpdate;
  axios.post = originalPost;
});

test('falha de suggestCategory em propaganda clara não derruba o sync', async () => {
  const originalFind = EmailService.findIntegrationByUserId;
  const originalToken = EmailService.getValidAccessToken;
  const originalList = EmailService.listMessages;
  const originalGet = EmailService.getMessage;
  const originalSuggest = RequestyProvider.prototype.suggestCategory;
  const originalUpdateMany = prisma.tb_integracao.updateMany;
  const originalUpdate = prisma.tb_integracao.update;
  const originalCreateProp = prisma.tb_propaganda.create;
  const updates = [];
  let created = 0;

  EmailService.findIntegrationByUserId = async () => ({
    integracao_id: 14,
    usuario_id: 5,
    integracao_email: 'user@example.com',
    integracao_access_token: 'token',
    integracao_refresh_token: 'refresh',
    integracao_token_expira_em: new Date(Date.now() + 60_000),
    integracao_ultima_sincronizacao_em: new Date('2026-08-01T09:00:00Z'),
  });
  EmailService.getValidAccessToken = async () => 'token';
  EmailService.listMessages = async () => [{ id: 'm1' }];
  EmailService.getMessage = async () => ({
    id: 'm1',
    subject: 'Oferta imperdível com desconto',
    from: 'Loja <promocoes@loja.com>',
    snippet: 'Promoção e frete grátis',
    labelIds: ['CATEGORY_PROMOTIONS'],
    internalDate: String(Date.parse('2026-08-10T12:00:00Z')),
  });
  RequestyProvider.prototype.suggestCategory = async () => {
    throw new Error('Falha temporária ao sugerir categoria');
  };
  prisma.tb_integracao.updateMany = async () => ({ count: 1 });
  prisma.tb_integracao.update = async ({ data }) => {
    updates.push(data);
    return {};
  };
  prisma.tb_propaganda.create = async ({ data }) => {
    created += 1;
    return data;
  };

  const result = await EmailSyncService.syncUser(5);

  assert.equal(result.created, 1);
  assert.equal(created, 1);
  assert.equal(updates.at(-1).integracao_sincronizacao_status, 'FINALIZADA');

  EmailService.findIntegrationByUserId = originalFind;
  EmailService.getValidAccessToken = originalToken;
  EmailService.listMessages = originalList;
  EmailService.getMessage = originalGet;
  RequestyProvider.prototype.suggestCategory = originalSuggest;
  prisma.tb_integracao.updateMany = originalUpdateMany;
  prisma.tb_integracao.update = originalUpdate;
  prisma.tb_propaganda.create = originalCreateProp;
});

test('dashboard financeiro usa apenas compras confirmadas', async () => {
  const originalFindMany = prisma.tb_compra.findMany;
  prisma.tb_compra.findMany = async (args) => {
    assert.equal(args.where.compra_status, 'CONFIRMADA');
    return [{ compra_valor: 10, tb_forma_pagamento: { forma_pagamento_nome: 'Pix' } }];
  };
  const result = await DashboardService.findGastosPorFormaPagamento(1);
  assert.equal(result[0].total, 10);
  prisma.tb_compra.findMany = originalFindMany;
});

test('MetricasService recalculateMonthlyMetrics ignora compras não confirmadas', async () => {
  const { MetricasService } = await import('../dist/src/modules/compra/metricas.service.js');
  const calls = [];
  const db = {
    tb_usuario: {
      findFirst: async () => ({ usuario_meta_valor_mensal: null }),
    },
    tb_compra: {
      findMany: async (args) => {
        calls.push(args.where.compra_status);
        return [];
      },
    },
    tb_metricas: {
      findFirst: async () => null,
      create: async () => ({}),
      update: async () => ({}),
    },
  };

  await MetricasService.recalculateMonthlyMetrics(1, new Date('2026-08-10T12:00:00Z'), db);

  assert.deepEqual(calls, ['CONFIRMADA']);
});

test('transição de compra impede caminhos inválidos', async () => {
  const originalFindFirst = prisma.tb_compra.findFirst;
  const originalUpdate = prisma.tb_compra.update;
  const originalTransaction = prisma.$transaction;

  let current = {
    compra_status: 'AGUARDANDO_CONFIRMACAO',
    compra_horario: new Date('2026-08-10T12:00:00Z'),
    compra_valor: 15,
    compra_usuario_concorda: null,
    compra_usuario_anotacao: null,
    compra_classificacao: 'PENDENTE',
    compra_email: true,
    compra_fonte: null,
    forma_pagamento_id: null,
  };
  prisma.tb_compra.findFirst = async () => current;
  prisma.$transaction = async (cb) =>
    cb({
      tb_forma_pagamento: {
        findUnique: async () => ({ forma_pagamento_id: 1 }),
      },
      tb_categoria: {
        count: async () => 0,
      },
      tb_compra: {
        findFirst: async () => current,
        findMany: async () => [],
        update: async ({ data }) => {
          current = { ...current, ...data };
          return current;
        },
        create: async () => current,
      },
      tb_compra_item: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
      },
      tb_usuario: {
        findFirst: async () => ({ usuario_meta_valor_compra: null }),
      },
      tb_metricas: {
        findFirst: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
    });
  prisma.tb_compra.update = async ({ data }) => {
    current = { ...current, ...data };
    return current;
  };

  await CompraService.confirm(1, 10);
  assert.equal(current.compra_status, 'CONFIRMADA');
  await assert.rejects(() => CompraService.ignore(1, 10));

  current = { compra_status: 'IGNORADA' };
  await assert.rejects(() => CompraService.confirm(1, 10));

  prisma.tb_compra.findFirst = originalFindFirst;
  prisma.$transaction = originalTransaction;
  prisma.tb_compra.update = originalUpdate;
});

test('confirmação recalcula métricas e retorna compra confirmada', async () => {
  const originalFindFirst = prisma.tb_compra.findFirst;
  const originalUpdate = prisma.tb_compra.update;
  const originalTransaction = prisma.$transaction;
  const metricasModule = await import('../dist/src/modules/compra/metricas.service.js');
  const originalRecalc = metricasModule.MetricasService.recalculateMonthlyMetrics;

  let current = {
    compra_id: 20,
    usuario_id: 1,
    compra_status: 'AGUARDANDO_CONFIRMACAO',
    compra_valor: 15,
    compra_horario: new Date('2026-08-10T12:00:00Z'),
    compra_usuario_concorda: null,
    compra_usuario_anotacao: null,
    compra_classificacao: 'PENDENTE',
    compra_email: true,
    compra_fonte: null,
    forma_pagamento_id: null,
  };
  let recalcCalls = 0;

  prisma.tb_compra.findFirst = async () => current;
  prisma.$transaction = async (cb) =>
    cb({
      tb_forma_pagamento: {
        findUnique: async () => ({ forma_pagamento_id: 1 }),
      },
      tb_categoria: {
        count: async () => 0,
      },
      tb_compra: {
        findFirst: async () => current,
        update: async ({ data }) => {
          current = { ...current, ...data };
          return current;
        },
        create: async () => current,
      },
      tb_compra_item: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
      },
      tb_usuario: {
        findFirst: async () => ({ usuario_meta_valor_compra: null }),
      },
      tb_metricas: {
        findFirst: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
    });
  prisma.tb_compra.update = async ({ data }) => {
    current = { ...current, ...data };
    return current;
  };
  metricasModule.MetricasService.recalculateMonthlyMetrics = async () => {
    recalcCalls += 1;
    return {};
  };

  const { CompraService } = await import('../dist/src/modules/compra/compra.service.js');
  const result = await CompraService.confirm(1, 20);

  assert.equal(result.compra.compra_status, 'CONFIRMADA');
  assert.equal(recalcCalls, 1);

  prisma.tb_compra.findFirst = originalFindFirst;
  prisma.$transaction = originalTransaction;
  prisma.tb_compra.update = originalUpdate;
  metricasModule.MetricasService.recalculateMonthlyMetrics = originalRecalc;
});

test('compra pendente com valor nulo pode ser confirmada quando items definem valor válido', async () => {
  const originalFindFirst = prisma.tb_compra.findFirst;
  const originalUpdate = prisma.tb_compra.update;
  const originalTransaction = prisma.$transaction;
  const originalRecalc = (await import('../dist/src/modules/compra/metricas.service.js')).MetricasService.recalculateMonthlyMetrics;
  const recalcCalls = [];

  let current = {
    compra_id: 30,
    usuario_id: 1,
    compra_status: 'AGUARDANDO_CONFIRMACAO',
    compra_valor: null,
    compra_horario: new Date('2026-08-10T12:00:00Z'),
    compra_usuario_concorda: null,
    compra_usuario_anotacao: null,
    compra_classificacao: 'PENDENTE',
    compra_email: true,
    compra_fonte: null,
    forma_pagamento_id: null,
  };

  prisma.tb_compra.findFirst = async () => current;
  prisma.$transaction = async (cb) =>
    cb({
      tb_forma_pagamento: {
        findUnique: async () => ({ forma_pagamento_id: 1 }),
      },
      tb_categoria: {
        count: async () => 2,
      },
      tb_compra: {
        findFirst: async () => current,
        update: async ({ data }) => {
          current = { ...current, ...data };
          return current;
        },
        findMany: async () => [],
        create: async () => current,
      },
      tb_compra_item: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
      },
      tb_usuario: {
        findFirst: async () => ({ usuario_meta_valor_compra: null }),
      },
      tb_metricas: {
        findFirst: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
    });
  prisma.tb_compra.update = async ({ data }) => {
    current = { ...current, ...data };
    return current;
  };
  (await import('../dist/src/modules/compra/metricas.service.js')).MetricasService.recalculateMonthlyMetrics = async (userId, date) => {
    recalcCalls.push(date.toISOString());
    return {};
  };

  const { CompraService } = await import('../dist/src/modules/compra/compra.service.js');
  const result = await CompraService.confirm(1, 30, {
    items: [
      { categoriaId: 1, nome: 'Item A', valor: 50 },
      { categoriaId: 2, nome: 'Item B', valor: 30 },
    ],
  });

  assert.equal(result.compra.compra_status, 'CONFIRMADA');
  assert.equal(Number(result.compra.compra_valor), 80);
  assert.equal(recalcCalls.length >= 1, true);

  prisma.tb_compra.findFirst = originalFindFirst;
  prisma.$transaction = originalTransaction;
  prisma.tb_compra.update = originalUpdate;
  (await import('../dist/src/modules/compra/metricas.service.js')).MetricasService.recalculateMonthlyMetrics = originalRecalc;
});

test('edicao de compra confirmada recalcula métricas do mês antigo e novo', async () => {
  const originalFindFirst = prisma.tb_compra.findFirst;
  const originalUpdate = prisma.tb_compra.update;
  const originalTransaction = prisma.$transaction;
  const metricasModule = await import('../dist/src/modules/compra/metricas.service.js');
  const originalRecalc = metricasModule.MetricasService.recalculateMonthlyMetrics;
  const calls = [];

  let current = {
    compra_id: 40,
    usuario_id: 1,
    compra_status: 'CONFIRMADA',
    compra_valor: 100,
    compra_horario: new Date('2026-08-10T12:00:00Z'),
    compra_usuario_concorda: null,
    compra_usuario_anotacao: null,
    compra_classificacao: 'PENDENTE',
    compra_email: false,
    compra_fonte: null,
    forma_pagamento_id: null,
  };

  prisma.tb_compra.findFirst = async () => current;
  prisma.$transaction = async (cb) =>
    cb({
      tb_forma_pagamento: {
        findUnique: async () => ({ forma_pagamento_id: 1 }),
      },
      tb_categoria: {
        count: async () => 0,
      },
      tb_compra: {
        findFirst: async () => current,
        update: async ({ data }) => {
          current = { ...current, ...data };
          return current;
        },
        findMany: async () => [],
        create: async () => current,
      },
      tb_compra_item: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
      },
      tb_usuario: {
        findFirst: async () => ({ usuario_meta_valor_compra: null }),
      },
      tb_metricas: {
        findFirst: async () => null,
        update: async () => ({}),
        create: async () => ({}),
      },
    });
  prisma.tb_compra.update = async ({ data }) => {
    current = { ...current, ...data };
    return current;
  };
  metricasModule.MetricasService.recalculateMonthlyMetrics = async (userId, date) => {
    calls.push(date.toISOString());
    return {};
  };

  const { CompraService } = await import('../dist/src/modules/compra/compra.service.js');
  await CompraService.update(1, 40, {
    compraHorario: new Date('2026-09-05T12:00:00Z'),
    compraClassificacao: 'PENDENTE',
    compraValor: 120,
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.some((value) => value.startsWith('2026-08-')));
  assert.ok(calls.some((value) => value.startsWith('2026-09-')));

  prisma.tb_compra.findFirst = originalFindFirst;
  prisma.$transaction = originalTransaction;
  prisma.tb_compra.update = originalUpdate;
  metricasModule.MetricasService.recalculateMonthlyMetrics = originalRecalc;
});
