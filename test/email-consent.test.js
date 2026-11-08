import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? 'client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? 'client-secret';
process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? 'https://example.com/callback';
process.env.CRON_SECRET = process.env.CRON_SECRET ?? 'cron-secret';

const { AppError } = await import('../dist/src/errors/AppError.js');
const { ConsentimentoService } = await import('../dist/src/modules/consentimento/consentimento.service.js');
const { EmailService } = await import('../dist/src/modules/email/email.service.js');
const { EmailSyncService } = await import('../dist/src/modules/email/email-sync.service.js');
const { EmailController } = await import('../dist/src/modules/email/email.controller.js');
const { EmailClassificationEngine } = await import('../dist/src/modules/email/classification.engine.js');
const { prisma } = await import('../dist/src/lib/prisma.js');

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function consentTransaction(integration) {
  return {
    $queryRaw: async () => [{ usuario_id: 1 }],
    tb_integracao: { findFirst: async () => integration },
    tb_consentimento_tipo: { findUnique: async () => ({ consentimento_tipo_id: 10 }) },
    tb_consentimento: {
      findUnique: async () => null,
      upsert: async ({ create }) => ({ ...create, consentimento_id: 20 }),
    },
  };
}

test('EMAIL=true exige integração Gmail, sem conceder legado automaticamente', async () => {
  await assert.rejects(
    ConsentimentoService.registrarComClient(consentTransaction(null), 1, 'EMAIL', true),
    error => error instanceof AppError && error.statusCode === 409,
  );

  const result = await ConsentimentoService.registrarComClient(
    consentTransaction({ integracao_id: 7 }),
    1,
    'EMAIL',
    true,
  );
  assert.equal(result.consentimento_status, true);
});

test('syncUser bloqueia captura manual antes de consultar o Gmail sem consentimento', async () => {
  const originalAssert = EmailService.assertCaptureConsent;
  const originalFind = EmailService.findIntegrationByUserId;
  let integrationLookup = false;
  EmailService.assertCaptureConsent = async () => { throw new AppError('Captura desativada', 403); };
  EmailService.findIntegrationByUserId = async () => { integrationLookup = true; return null; };
  try {
    await assert.rejects(EmailSyncService.syncUser(1), error => error instanceof AppError && error.statusCode === 403);
    assert.equal(integrationLookup, false);
  } finally {
    EmailService.assertCaptureConsent = originalAssert;
    EmailService.findIntegrationByUserId = originalFind;
  }
});

test('cron filtra integrações Gmail pelo consentimento EMAIL ativo', async () => {
  const originalFindMany = prisma.tb_integracao.findMany;
  let query;
  prisma.tb_integracao.findMany = async args => { query = args; return []; };
  try {
    await EmailSyncService.syncAllUsers();
    assert.equal(query.where.tb_usuario.tb_consentimento.some.consentimento_status, true);
    assert.equal(query.where.tb_usuario.tb_consentimento.some.tb_consentimento_tipo.consentimento_tipo_codigo, 'EMAIL');
  } finally {
    prisma.tb_integracao.findMany = originalFindMany;
  }
});

test('leitura de mensagens Gmail também exige consentimento no backend', async () => {
  const originalAssert = EmailService.assertCaptureConsent;
  const originalFind = EmailService.findIntegrationByUserId;
  let integrationLookup = false;
  EmailService.assertCaptureConsent = async () => { throw new AppError('Captura desativada', 403); };
  EmailService.findIntegrationByUserId = async () => { integrationLookup = true; return null; };
  try {
    const response = fakeResponse();
    await EmailController.listMessages({ userId: 1 }, response);
    assert.equal(response.statusCode, 403);
    assert.equal(integrationLookup, false);
  } finally {
    EmailService.assertCaptureConsent = originalAssert;
    EmailService.findIntegrationByUserId = originalFind;
  }
});

test('sync com consentimento válido consulta Gmail e finaliza', async () => {
  const originals = {
    assert: EmailService.assertCaptureConsent,
    find: EmailService.findIntegrationByUserId,
    token: EmailService.getValidAccessToken,
    list: EmailService.listMessages,
    updateMany: prisma.tb_integracao.updateMany,
    update: prisma.tb_integracao.update,
  };
  const integration = {
    integracao_id: 9,
    usuario_id: 1,
    integracao_access_token: 'access',
    integracao_refresh_token: 'refresh',
    integracao_token_expira_em: new Date(Date.now() + 3600000),
    integracao_ultima_sincronizacao_em: null,
  };
  let listed = 0;
  EmailService.assertCaptureConsent = async () => {};
  EmailService.findIntegrationByUserId = async () => integration;
  EmailService.getValidAccessToken = async () => 'access';
  EmailService.listMessages = async () => { listed += 1; return []; };
  prisma.tb_integracao.updateMany = async () => ({ count: 1 });
  prisma.tb_integracao.update = async () => integration;
  try {
    const result = await EmailSyncService.syncUser(1);
    assert.equal(result.processed, 0);
    assert.equal(result.created, 0);
    assert.equal(listed, 1);
  } finally {
    EmailService.assertCaptureConsent = originals.assert;
    EmailService.findIntegrationByUserId = originals.find;
    EmailService.getValidAccessToken = originals.token;
    EmailService.listMessages = originals.list;
    prisma.tb_integracao.updateMany = originals.updateMany;
    prisma.tb_integracao.update = originals.update;
  }
});

test('revogação durante a sincronização impede a próxima mensagem', async () => {
  const originals = {
    assert: EmailService.assertCaptureConsent,
    find: EmailService.findIntegrationByUserId,
    token: EmailService.getValidAccessToken,
    list: EmailService.listMessages,
    get: EmailService.getMessage,
    classify: EmailClassificationEngine.classify,
    purchase: prisma.tb_compra.findFirst,
    propaganda: prisma.tb_propaganda.findFirst,
    updateMany: prisma.tb_integracao.updateMany,
    update: prisma.tb_integracao.update,
  };
  const integration = {
    integracao_id: 10,
    usuario_id: 1,
    integracao_access_token: 'access',
    integracao_refresh_token: 'refresh',
    integracao_token_expira_em: new Date(Date.now() + 3600000),
    integracao_ultima_sincronizacao_em: null,
  };
  let checks = 0;
  let fetched = 0;
  EmailService.assertCaptureConsent = async () => {
    checks += 1;
    if (checks > 5) throw new AppError('Captura revogada durante a execução', 403);
  };
  EmailService.findIntegrationByUserId = async () => integration;
  EmailService.getValidAccessToken = async () => 'access';
  EmailService.listMessages = async () => [{ id: 'm1' }, { id: 'm2' }];
  EmailService.getMessage = async () => { fetched += 1; return { id: `m${fetched}`, textBody: 'informação' }; };
  EmailClassificationEngine.classify = () => ({ outcome: 'IGNORAR' });
  prisma.tb_compra.findFirst = async () => null;
  prisma.tb_propaganda.findFirst = async () => null;
  prisma.tb_integracao.updateMany = async () => ({ count: 1 });
  prisma.tb_integracao.update = async () => integration;
  try {
    await assert.rejects(EmailSyncService.syncUser(1), error => error instanceof AppError && error.statusCode === 403);
    assert.equal(fetched, 1);
  } finally {
    EmailService.assertCaptureConsent = originals.assert;
    EmailService.findIntegrationByUserId = originals.find;
    EmailService.getValidAccessToken = originals.token;
    EmailService.listMessages = originals.list;
    EmailService.getMessage = originals.get;
    EmailClassificationEngine.classify = originals.classify;
    prisma.tb_compra.findFirst = originals.purchase;
    prisma.tb_propaganda.findFirst = originals.propaganda;
    prisma.tb_integracao.updateMany = originals.updateMany;
    prisma.tb_integracao.update = originals.update;
  }
});
