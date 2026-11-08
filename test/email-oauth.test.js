import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? 'client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? 'client-secret';
process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? 'https://example.com/callback';

const { AppError } = await import('../dist/src/errors/AppError.js');
const { EmailController } = await import('../dist/src/modules/email/email.controller.js');
const { EmailService } = await import('../dist/src/modules/email/email.service.js');
const { OAuthTentativaService } = await import('../dist/src/modules/email/oauth-tentativa.service.js');
const { ConsentimentoService } = await import('../dist/src/modules/consentimento/consentimento.service.js');
const { prisma } = await import('../dist/src/lib/prisma.js');
const { env } = await import('../dist/src/lib/env.js');

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    set(values) { Object.assign(this.headers, values); return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    redirect(payload) { this.body = payload; return this; },
  };
}

test('state OAuth usa valor imprevisível e não expõe o identificador do usuário', () => {
  const state = 'A'.repeat(43);
  const url = new URL(EmailService.generateGoogleUrl(state));
  assert.equal(url.searchParams.get('state'), state);
  assert.notEqual(url.searchParams.get('state'), '42');
});

test('state OAuth inválido ou adulterado é rejeitado antes do banco', async () => {
  const originalTransaction = prisma.$transaction;
  let transactionCalls = 0;
  prisma.$transaction = async callback => {
    transactionCalls += 1;
    return callback({});
  };
  try {
    await assert.rejects(
      OAuthTentativaService.callback('1'),
      error => error instanceof AppError && error.statusCode === 400,
    );
    await assert.rejects(
      OAuthTentativaService.callback(`${'A'.repeat(42)}!`),
      error => error instanceof AppError && error.statusCode === 400,
    );
    assert.equal(transactionCalls, 0);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test('state OAuth expirado é rejeitado', async () => {
  const originalTransaction = prisma.$transaction;
  const state = 'B'.repeat(43);
  prisma.$transaction = async callback => callback({
    tb_oauth_tentativa: {
      findUnique: async () => ({
        oauth_tentativa_id: 'attempt-expired',
        usuario_id: 9,
        oauth_status: 'PENDENTE',
        oauth_expira_em: new Date(Date.now() - 1000),
      }),
    },
  });
  try {
    await assert.rejects(
      OAuthTentativaService.callback(state),
      error => error instanceof AppError && error.statusCode === 400,
    );
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test('state OAuth é consumido uma única vez', async () => {
  const originalTransaction = prisma.$transaction;
  const state = 'C'.repeat(43);
  const tentativa = {
    oauth_tentativa_id: 'attempt-once',
    usuario_id: 15,
    oauth_status: 'PENDENTE',
    oauth_expira_em: new Date(Date.now() + 60_000),
  };
  prisma.$transaction = async callback => callback({
    tb_oauth_tentativa: {
      findUnique: async () => tentativa,
      updateMany: async ({ data }) => {
        tentativa.oauth_status = data.oauth_status;
        return { count: 1 };
      },
    },
  });
  try {
    const first = await OAuthTentativaService.callback(state);
    assert.deepEqual(first, { tentativaId: 'attempt-once', userId: 15 });
    await assert.rejects(
      OAuthTentativaService.callback(state),
      error => error instanceof AppError && error.statusCode === 400,
    );
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test('callback salva a integração no usuário associado à tentativa, não no state', async () => {
  const originals = {
    callback: OAuthTentativaService.callback,
    finalizar: OAuthTentativaService.finalizar,
    exchange: EmailService.exchangeCodeForTokens,
    email: EmailService.getGoogleUserEmail,
    save: EmailService.saveIntegration,
    consent: ConsentimentoService.registrar,
  };
  let savedUserId;
  OAuthTentativaService.callback = async () => ({ tentativaId: 'attempt-user-bound', userId: 42 });
  OAuthTentativaService.finalizar = async () => {};
  EmailService.exchangeCodeForTokens = async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
  EmailService.getGoogleUserEmail = async () => 'person@example.com';
  EmailService.saveIntegration = async userId => { savedUserId = userId; return {}; };
  ConsentimentoService.registrar = async () => ({});
  try {
    const response = fakeResponse();
    await EmailController.callback({ query: { code: 'code', state: 'D'.repeat(43) } }, response);
    assert.equal(savedUserId, 42);
    assert.equal(response.body, `${env.apiBaseUrl}/oauth-success.html`);
  } finally {
    OAuthTentativaService.callback = originals.callback;
    OAuthTentativaService.finalizar = originals.finalizar;
    EmailService.exchangeCodeForTokens = originals.exchange;
    EmailService.getGoogleUserEmail = originals.email;
    EmailService.saveIntegration = originals.save;
    ConsentimentoService.registrar = originals.consent;
  }
});

test('cancelamento OAuth não registra consentimento e invalida a tentativa pendente', async () => {
  const originals = {
    cancelar: OAuthTentativaService.cancelar,
    registrar: ConsentimentoService.registrar,
  };
  let canceledState;
  let consentRegistered = false;
  OAuthTentativaService.cancelar = async state => { canceledState = state; };
  ConsentimentoService.registrar = async () => { consentRegistered = true; };
  try {
    const response = fakeResponse();
    const state = 'E'.repeat(43);
    await EmailController.callback({ query: { error: 'access_denied', state } }, response);
    assert.equal(response.body, 'plenna://oauth-error');
    assert.equal(canceledState, state);
    assert.equal(consentRegistered, false);
  } finally {
    OAuthTentativaService.cancelar = originals.cancelar;
    ConsentimentoService.registrar = originals.registrar;
  }
});

test('falha no callback encerra a tentativa sem conceder consentimento', async () => {
  const originals = {
    callback: OAuthTentativaService.callback,
    finalizar: OAuthTentativaService.finalizar,
    exchange: EmailService.exchangeCodeForTokens,
    registrar: ConsentimentoService.registrar,
  };
  let finalStatus;
  let consentRegistered = false;
  OAuthTentativaService.callback = async () => ({ tentativaId: 'attempt-failed', userId: 42 });
  OAuthTentativaService.finalizar = async (_id, status) => { finalStatus = status; };
  EmailService.exchangeCodeForTokens = async () => { throw new Error('OAuth inválido'); };
  ConsentimentoService.registrar = async () => { consentRegistered = true; };
  try {
    const response = fakeResponse();
    await EmailController.callback({ query: { code: 'code', state: 'F'.repeat(43) } }, response);
    assert.equal(response.body, 'plenna://oauth-error');
    assert.equal(finalStatus, 'FALHOU');
    assert.equal(consentRegistered, false);
  } finally {
    OAuthTentativaService.callback = originals.callback;
    OAuthTentativaService.finalizar = originals.finalizar;
    EmailService.exchangeCodeForTokens = originals.exchange;
    ConsentimentoService.registrar = originals.registrar;
  }
});

test('status distingue credenciais armazenadas de reconexão necessária sem chamar o Google', async () => {
  const originalFindFirst = prisma.tb_integracao.findFirst;
  const base = {
    integracao_email: 'person@example.com',
    integracao_access_token: 'access',
    integracao_refresh_token: 'refresh',
    integracao_sincronizacao_status: 'FINALIZADA',
    integracao_ultima_sincronizacao_em: null,
  };
  prisma.tb_integracao.findFirst = async () => ({ ...base, integracao_ultimo_erro: null });
  try {
    const stored = await EmailService.getIntegrationStatus(42);
    assert.equal(stored.credentialsStored, true);
    assert.equal(stored.authorizationStatus, 'CREDENTIALS_STORED');
    assert.equal(stored.operational, true);
    assert.equal(stored.requiresReauth, false);

    prisma.tb_integracao.findFirst = async () => ({ ...base, integracao_ultimo_erro: 'RECONEXAO_GMAIL_NECESSARIA' });
    const reconnect = await EmailService.getIntegrationStatus(42);
    assert.equal(reconnect.credentialsStored, true);
    assert.equal(reconnect.authorizationStatus, 'RECONNECT_REQUIRED');
    assert.equal(reconnect.operational, false);
    assert.equal(reconnect.requiresReauth, true);
  } finally {
    prisma.tb_integracao.findFirst = originalFindFirst;
  }
});

test('falha de autorização no refresh marca reconexão sem expor o erro ao contrato', async () => {
  const originals = {
    refresh: EmailService.refreshAccessToken,
    updateMany: prisma.tb_integracao.updateMany,
  };
  let update;
  EmailService.refreshAccessToken = async () => {
    const error = new Error('invalid_grant');
    error.response = { status: 400, data: { error: 'invalid_grant' } };
    throw error;
  };
  prisma.tb_integracao.updateMany = async args => { update = args; return { count: 1 }; };
  try {
    await assert.rejects(EmailService.refreshIntegrationTokens({ integracao_id: 7, integracao_refresh_token: 'refresh' }));
    assert.equal(update.data.integracao_ultimo_erro, 'RECONEXAO_GMAIL_NECESSARIA');
    assert.equal(update.data.integracao_sincronizacao_status, 'ERRO');
  } finally {
    EmailService.refreshAccessToken = originals.refresh;
    prisma.tb_integracao.updateMany = originals.updateMany;
  }
});
