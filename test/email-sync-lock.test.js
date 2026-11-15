import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

process.env.EMAIL_SYNC_ENABLED = 'true';
process.env.EMAIL_SYNC_LEASE_MS = '300';
process.env.CRON_SECRET = process.env.CRON_SECRET ?? 'cron-secret';

const { EmailSyncService, messageAlreadyPersisted } = await import('../dist/src/modules/email/email-sync.service.js');
const { EmailService } = await import('../dist/src/modules/email/email.service.js');
const { prisma } = await import('../dist/src/lib/prisma.js');
const { env } = await import('../dist/src/lib/env.js');

const originals = {
  assertCaptureConsent: EmailService.assertCaptureConsent,
  findIntegrationByUserId: EmailService.findIntegrationByUserId,
  getValidAccessToken: EmailService.getValidAccessToken,
  listMessages: EmailService.listMessages,
  getMessage: EmailService.getMessage,
  integrationUpdateMany: prisma.tb_integracao.updateMany,
  purchaseFindFirst: prisma.tb_compra.findFirst,
  promotionFindFirst: prisma.tb_propaganda.findFirst,
};

const baseIntegration = {
  integracao_id: 7,
  usuario_id: 1,
  integracao_email: 'test@example.invalid',
  integracao_access_token: 'access',
  integracao_refresh_token: 'refresh',
  integracao_token_expira_em: new Date(Date.now() + 3_600_000),
  integracao_ultima_sincronizacao_em: new Date('2026-08-01T00:00:00Z'),
  integracao_geracao: 'generation-7',
};

let state;
let updateCalls;
let listCalls;
let listBehavior;

function applyData(data) {
  if (Object.prototype.hasOwnProperty.call(data, 'integracao_sincronizacao_status')) {
    state.status = data.integracao_sincronizacao_status;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'integracao_execucao_id')) {
    state.executionId = data.integracao_execucao_id;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'integracao_lease_expira_em')) {
    state.leaseExpiresAt = data.integracao_lease_expira_em;
  }
}

function installSingleIntegrationDoubles() {
  state = {
    status: 'PENDENTE',
    executionId: null,
    leaseExpiresAt: null,
  };
  updateCalls = [];
  listCalls = 0;
  listBehavior = async () => [];

  EmailService.assertCaptureConsent = async () => {};
  EmailService.findIntegrationByUserId = async () => ({ ...baseIntegration });
  EmailService.getValidAccessToken = async () => 'access';
  EmailService.listMessages = async (...args) => {
    listCalls += 1;
    return listBehavior(...args);
  };
  EmailService.getMessage = async () => ({
    id: 'message-1',
    subject: 'synthetic',
    internalDate: String(Date.parse('2026-08-10T12:00:00Z')),
  });

  prisma.tb_integracao.updateMany = async ({ where, data }) => {
    updateCalls.push({ where, data });
    const now = new Date();
    const generationMatches = where.integracao_geracao === baseIntegration.integracao_geracao;
    if (!generationMatches || where.integracao_id !== baseIntegration.integracao_id) return { count: 0 };

    if (where.OR) {
      const available = state.status !== 'PROCESSANDO';
      const expired = state.status === 'PROCESSANDO'
        && Boolean(state.executionId)
        && state.leaseExpiresAt instanceof Date
        && state.leaseExpiresAt <= now;
      if (!available && !expired) return { count: 0 };
      applyData(data);
      return { count: 1 };
    }

    if (typeof where.integracao_sincronizacao_status === 'string'
      && state.status !== where.integracao_sincronizacao_status) return { count: 0 };
    if (typeof where.integracao_execucao_id === 'string'
      && state.executionId !== where.integracao_execucao_id) return { count: 0 };
    if (where.integracao_lease_expira_em?.gt
      && (!(state.leaseExpiresAt instanceof Date) || state.leaseExpiresAt <= where.integracao_lease_expira_em.gt)) return { count: 0 };

    applyData(data);
    return { count: 1 };
  };
}

beforeEach(() => {
  env.emailSyncLeaseMs = 300;
  installSingleIntegrationDoubles();
});

afterEach(() => {
  EmailService.assertCaptureConsent = originals.assertCaptureConsent;
  EmailService.findIntegrationByUserId = originals.findIntegrationByUserId;
  EmailService.getValidAccessToken = originals.getValidAccessToken;
  EmailService.listMessages = originals.listMessages;
  EmailService.getMessage = originals.getMessage;
  prisma.tb_integracao.updateMany = originals.integrationUpdateMany;
  prisma.tb_compra.findFirst = originals.purchaseFindFirst;
  prisma.tb_propaganda.findFirst = originals.promotionFindFirst;
});

test('adquire lock com UUID e finaliza limpando execução e lease', async () => {
  await EmailSyncService.syncUser(1);

  const acquire = updateCalls.find((call) => call.data.integracao_execucao_id && call.data.integracao_sincronizacao_status === 'PROCESSANDO');
  const finalize = updateCalls.find((call) => call.data.integracao_sincronizacao_status === 'FINALIZADA');
  assert.match(acquire.data.integracao_execucao_id, /^[0-9a-f-]{36}$/i);
  assert.ok(acquire.data.integracao_lease_expira_em instanceof Date);
  assert.equal(finalize.where.integracao_execucao_id, acquire.data.integracao_execucao_id);
  assert.equal(finalize.data.integracao_execucao_id, null);
  assert.equal(finalize.data.integracao_lease_expira_em, null);
  assert.equal(state.status, 'FINALIZADA');
});

test('não assume lock válido quando o lease ainda está ativo', async () => {
  state.status = 'PROCESSANDO';
  state.executionId = 'old-execution';
  state.leaseExpiresAt = new Date(Date.now() + 60_000);

  const result = await EmailSyncService.syncUser(1);

  assert.equal(result.status, 'JA_EM_ANDAMENTO');
  assert.equal(listCalls, 0);
});

test('não recupera automaticamente lock legado PROCESSANDO sem lease', async () => {
  state.status = 'PROCESSANDO';
  state.executionId = null;
  state.leaseExpiresAt = null;

  const result = await EmailSyncService.syncUser(1);

  assert.equal(result.status, 'JA_EM_ANDAMENTO');
  assert.equal(listCalls, 0);
  assert.equal(state.status, 'PROCESSANDO');
});

test('recupera lock identificado quando o lease expirou', async () => {
  state.status = 'PROCESSANDO';
  state.executionId = 'expired-execution';
  state.leaseExpiresAt = new Date(Date.now() - 1_000);

  await EmailSyncService.syncUser(1);

  const acquire = updateCalls.find((call) => call.data.integracao_execucao_id && call.data.integracao_sincronizacao_status === 'PROCESSANDO');
  assert.notEqual(acquire.data.integracao_execucao_id, 'expired-execution');
  assert.equal(state.status, 'FINALIZADA');
});

test('renova lease durante execução longa e impede segunda execução concorrente', async () => {
  env.emailSyncLeaseMs = 300;
  listBehavior = async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    return [];
  };

  const [first, second] = await Promise.all([
    EmailSyncService.syncUser(1),
    EmailSyncService.syncUser(1),
  ]);

  assert.equal(second.status, 'JA_EM_ANDAMENTO');
  assert.equal(first.processed, 0);
  const renewals = updateCalls.filter((call) => call.data.integracao_lease_expira_em && !call.data.integracao_execucao_id);
  assert.ok(renewals.length >= 1);
});

test('execução antiga não finaliza lock assumido por execução nova', async () => {
  listBehavior = async () => {
    state.status = 'PROCESSANDO';
    state.executionId = 'new-execution';
    state.leaseExpiresAt = new Date(Date.now() + 60_000);
    return [];
  };

  await assert.rejects(
    () => EmailSyncService.syncUser(1),
    (error) => error?.statusCode === 409,
  );
  assert.equal(state.executionId, 'new-execution');
  assert.equal(updateCalls.some((call) => call.data.integracao_sincronizacao_status === 'FINALIZADA'), false);
});

test('falha libera somente o lock da própria execução', async () => {
  listBehavior = async () => { throw new Error('falha sintética'); };

  await assert.rejects(() => EmailSyncService.syncUser(1), /falha sintética/);

  assert.equal(state.status, 'ERRO');
  assert.equal(state.executionId, null);
  assert.equal(state.leaseExpiresAt, null);
});

test('timeout libera o lock e permite nova tentativa posterior', async () => {
  listBehavior = async () => {
    const error = new Error('timeout sintético');
    error.code = 'ETIMEDOUT';
    throw error;
  };

  await assert.rejects(() => EmailSyncService.syncUser(1), /timeout sintético/);

  assert.equal(state.status, 'ERRO');
  assert.equal(state.executionId, null);
  assert.equal(state.leaseExpiresAt, null);
});

test('deduplicação mantém o escopo do usuário para o mesmo messageId', async () => {
  const originalPurchaseFindFirst = prisma.tb_compra.findFirst;
  const originalPromotionFindFirst = prisma.tb_propaganda.findFirst;
  prisma.tb_compra.findFirst = async ({ where }) => where.usuario_id === 1 ? { compra_id: 10 } : null;
  prisma.tb_propaganda.findFirst = async () => null;
  try {
    assert.equal(await messageAlreadyPersisted(1, 'same-message'), true);
    assert.equal(await messageAlreadyPersisted(2, 'same-message'), false);
  } finally {
    prisma.tb_compra.findFirst = originalPurchaseFindFirst;
    prisma.tb_propaganda.findFirst = originalPromotionFindFirst;
  }
});

test('dois usuários podem sincronizar integrações independentes', async () => {
  const states = new Map([
    [1, { status: 'PENDENTE', executionId: null, leaseExpiresAt: null }],
    [2, { status: 'PENDENTE', executionId: null, leaseExpiresAt: null }],
  ]);
  const originalFindIntegration = EmailService.findIntegrationByUserId;
  const originalUpdateMany = prisma.tb_integracao.updateMany;
  EmailService.findIntegrationByUserId = async (userId) => ({
    ...baseIntegration,
    integracao_id: userId,
    usuario_id: userId,
    integracao_geracao: `generation-${userId}`,
  });
  prisma.tb_integracao.updateMany = async ({ where, data }) => {
    const current = states.get(where.integracao_id);
    if (!current || where.integracao_geracao !== `generation-${where.integracao_id}`) return { count: 0 };
    if (where.OR) {
      const available = current.status !== 'PROCESSANDO';
      const expired = current.status === 'PROCESSANDO'
        && current.executionId
        && current.leaseExpiresAt instanceof Date
        && current.leaseExpiresAt <= new Date();
      if (!available && !expired) return { count: 0 };
    } else {
      if (typeof where.integracao_sincronizacao_status === 'string'
        && current.status !== where.integracao_sincronizacao_status) return { count: 0 };
      if (typeof where.integracao_execucao_id === 'string'
        && current.executionId !== where.integracao_execucao_id) return { count: 0 };
      if (where.integracao_lease_expira_em?.gt
        && (!(current.leaseExpiresAt instanceof Date) || current.leaseExpiresAt <= where.integracao_lease_expira_em.gt)) return { count: 0 };
    }
    if (Object.prototype.hasOwnProperty.call(data, 'integracao_sincronizacao_status')) current.status = data.integracao_sincronizacao_status;
    if (Object.prototype.hasOwnProperty.call(data, 'integracao_execucao_id')) current.executionId = data.integracao_execucao_id;
    if (Object.prototype.hasOwnProperty.call(data, 'integracao_lease_expira_em')) current.leaseExpiresAt = data.integracao_lease_expira_em;
    return { count: 1 };
  };
  try {
    const results = await Promise.all([EmailSyncService.syncUser(1), EmailSyncService.syncUser(2)]);
    assert.equal(results[0].processed, 0);
    assert.equal(results[1].processed, 0);
    assert.equal(states.get(1).status, 'FINALIZADA');
    assert.equal(states.get(2).status, 'FINALIZADA');
  } finally {
    EmailService.findIntegrationByUserId = originalFindIntegration;
    prisma.tb_integracao.updateMany = originalUpdateMany;
  }
});
