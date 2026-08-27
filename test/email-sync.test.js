import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? 'client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? 'client-secret';
process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? 'https://example.com/callback';
process.env.CRON_SECRET = process.env.CRON_SECRET ?? 'cron-secret';

const axios = (await import('axios')).default;
const { emailRouter } = await import('../dist/src/modules/email/email.routes.js');
const { EmailController } = await import('../dist/src/modules/email/email.controller.js');
const { EmailSyncService } = await import('../dist/src/modules/email/email-sync.service.js');
const { GeminiProvider } = await import('../dist/src/modules/email/gemini.provider.js');
const { EmailService } = await import('../dist/src/modules/email/email.service.js');
const { DashboardService } = await import('../dist/src/modules/dashboard/dashboard.service.js');
const { CompraService } = await import('../dist/src/modules/compra/compra.service.js');
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

test('GeminiProvider rejeita ausência de API key', async () => {
  const previous = env.geminiApiKey;
  env.geminiApiKey = '';
  const provider = new GeminiProvider();
  await assert.rejects(() => provider.classifyEmail('teste'));
  env.geminiApiKey = previous;
});

test('GeminiProvider rejeita resposta inválida', async () => {
  const previous = env.geminiApiKey;
  env.geminiApiKey = 'key';
  const originalPost = axios.post;
  axios.post = async () => ({ data: { candidates: [{ content: { parts: [{ text: 'not-json' }] } }] } });
  const provider = new GeminiProvider();
  await assert.rejects(() => provider.classifyEmail('teste'));
  axios.post = originalPost;
  env.geminiApiKey = previous;
});

test('sync clara não chama IA e adquire lock', async () => {
  const originalFind = EmailService.findIntegrationByUserId;
  const originalToken = EmailService.getValidAccessToken;
  const originalList = EmailService.listMessages;
  const originalGet = EmailService.getMessage;
  const originalClassify = GeminiProvider.prototype.classifyEmail;
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
  GeminiProvider.prototype.classifyEmail = async () => {
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
  GeminiProvider.prototype.classifyEmail = originalClassify;
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
  const originalClassify = GeminiProvider.prototype.classifyEmail;
  const originalSuggest = GeminiProvider.prototype.suggestCategory;
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
  GeminiProvider.prototype.classifyEmail = async () => {
    throw new Error('IA indisponível');
  };
  GeminiProvider.prototype.suggestCategory = async () => ({ categoryName: null });
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
  GeminiProvider.prototype.classifyEmail = originalClassify;
  GeminiProvider.prototype.suggestCategory = originalSuggest;
  prisma.tb_integracao.updateMany = originalUpdateMany;
  prisma.tb_integracao.update = originalUpdate;
  prisma.tb_compra.create = originalCreateCompra;
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

test('transição de compra impede caminhos inválidos', async () => {
  const originalFindFirst = prisma.tb_compra.findFirst;
  const originalUpdate = prisma.tb_compra.update;
  const originalTransaction = prisma.$transaction;

  let current = { compra_status: 'AGUARDANDO_CONFIRMACAO' };
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
