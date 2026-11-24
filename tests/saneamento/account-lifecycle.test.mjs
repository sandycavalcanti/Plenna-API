import './offline-env.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import bcrypt from 'bcrypt';

const database = process.env.PLENNA_ACCOUNT_TEST_URL;
test('exclusão intercepta a conta antiga e libera o e-mail para outra identidade', {
  skip: !database,
}, async () => {
  const url = new URL(database);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/plenna_account_test(?:_[a-z0-9]+)?$/);
  process.env.DATABASE_URL = url.href;
  process.env.DIRECT_URL = url.href;

  const { prisma, disconnectPrisma } = await import('../../dist/src/lib/prisma.js');
  const { AuthService } = await import('../../dist/src/modules/auth/auth.service.js');
  const { authMiddleware } = await import('../../dist/src/modules/auth/auth.middleware.js');
  const { UsersService } = await import('../../dist/src/modules/user/user.service.js');
  const { EmailService } = await import('../../dist/src/modules/email/email.service.js');
  const { EmailSyncService } = await import('../../dist/src/modules/email/email-sync.service.js');
  const { DeviceService } = await import('../../dist/src/modules/notification/device.service.js');

  const email = `${randomUUID()}@example.test`;
  const signup = { email, nome: 'Conta fictícia', senha: 'Anterior123', aceitouTermos: true };
  const authorizedUser = async (token) => {
    const request = { headers: { authorization: `Bearer ${token}` } };
    let status;
    const response = { status(code) { status = code; return this; }, json() {} };
    await authMiddleware(request, response, (error) => { if (error) throw error; });
    return { status, userId: request.userId };
  };

  try {
    for (const codigo of ['TERMOS_USO', 'EMAIL']) {
      await prisma.tb_consentimento_tipo.upsert({
        where: { consentimento_tipo_codigo: codigo },
        update: {},
        create: { consentimento_tipo_codigo: codigo, consentimento_tipo_nome: codigo },
      });
    }
    const old = await AuthService.register(signup);
    const where = { usuario_id: old.usuario_id };
    await prisma.tb_redefinicao_senha.create({ data: {
      ...where,
      redefinicao_senha_codigo_hash: await bcrypt.hash('123456', 4),
      redefinicao_senha_expira_em: new Date(Date.now() + 60_000),
    } });
    await AuthService.resetPassword(email, '123456', 'Redefinida123');
    await assert.rejects(AuthService.login(email, signup.senha), { statusCode: 401 });
    const { token } = await AuthService.login(email, 'Redefinida123');
    assert.equal((await authorizedUser(token)).userId, old.usuario_id);
    const tipo = await prisma.tb_consentimento_tipo.findUniqueOrThrow({
      where: { consentimento_tipo_codigo: 'EMAIL' },
    });
    await prisma.tb_consentimento.create({ data: {
      ...where, consentimento_tipo_id: tipo.consentimento_tipo_id, consentimento_status: true,
    } });
    await prisma.tb_integracao.create({ data: {
      ...where, integracao_email: 'gmail@example.test', integracao_provedor: 'GMAIL',
      integracao_access_token: 'fixture-access', integracao_refresh_token: 'fixture-refresh',
      integracao_token_expira_em: new Date(),
    }, select: { integracao_id: true } });
    const installation = await prisma.monitoramentoInstalacao.create({ data: {
      id: randomUUID(), hash: Buffer.alloc(32), accountId: old.usuario_id,
      contextId: randomUUID(), sessionId: randomUUID(), eligibleFrom: new Date(),
      timezone: 'America/Sao_Paulo', collectionId: randomUUID(), collectionUntil: new Date(),
    } });
    const pushToken = `fixture-${randomUUID()}`;
    await DeviceService.registerPushToken(old.usuario_id, pushToken, 'android');

    let credentialsRequested;
    const started = new Promise(resolve => { credentialsRequested = resolve; });
    let releaseCredentials;
    const released = new Promise(resolve => { releaseCredentials = resolve; });
    const originalCredentials = EmailService.getValidAccessToken;
    const originalList = EmailService.listMessages;
    EmailService.getValidAccessToken = async () => {
      credentialsRequested();
      await released;
      return 'fixture-access';
    };
    let listCalled = false;
    EmailService.listMessages = async () => { listCalled = true; return []; };
    const sync = EmailSyncService.syncUser(old.usuario_id);
    void sync.catch(() => {});
    await Promise.race([started, sync]);
    try {
      const deletions = await Promise.allSettled([
        UsersService.delete(old.usuario_id), UsersService.delete(old.usuario_id),
      ]);
      if (deletions.every(result => result.status === 'rejected')) throw deletions[0].reason;
      assert.equal(deletions.filter(result => result.status === 'fulfilled').length, 1);
      await assert.rejects(AuthService.login(email, signup.senha), { statusCode: 401 });
      await assert.rejects(EmailService.assertCaptureConsent(old.usuario_id), { statusCode: 403 });
      assert.equal(await prisma.tb_integracao.count({ where }), 0);
      assert.equal(await prisma.tb_redefinicao_senha.count({ where }), 0);
      const detached = await prisma.monitoramentoInstalacao.findUniqueOrThrow({ where: { id: installation.id } });
      assert.equal(detached.accountId, null);
      assert.equal(detached.sessionId, null);
      assert.notEqual(detached.contextId, installation.contextId);

      assert.equal(await prisma.tb_dispositivo.count({ where }), 0);
      releaseCredentials();
      await assert.rejects(sync, { statusCode: 403 });
      assert.equal(listCalled, false);
      const fresh = await AuthService.register({ ...signup, senha: 'Nova123' });
      assert.notEqual(fresh.usuario_id, old.usuario_id);
      assert.deepEqual(await authorizedUser(token), { status: 401, userId: undefined });
      const freshConsent = await prisma.tb_consentimento.findMany({
        where: { usuario_id: fresh.usuario_id }, include: { tb_consentimento_tipo: true },
      });
      assert.deepEqual(freshConsent.map(row => row.tb_consentimento_tipo.consentimento_tipo_codigo), ['TERMOS_USO']);
      assert.equal((await authorizedUser((await AuthService.login(email, 'Nova123')).token)).userId, fresh.usuario_id);
      assert.equal((await prisma.tb_usuario.findUniqueOrThrow({ where })).usuario_status, false);
    } finally {
      releaseCredentials();
      EmailService.getValidAccessToken = originalCredentials;
      EmailService.listMessages = originalList;
      await sync.catch(() => {});
    }
  } finally {
    await disconnectPrisma();
  }
});
