import { client } from './runtime.mjs';
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach, mock } from 'node:test';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
const { AuthService } = await import('../../src/modules/auth/auth.service.ts');
const { resetPasswordSchema, verifyResetCodeSchema } = await import('../../src/modules/auth/auth.schemas.ts');
let mail, record, user, updates;
nodemailer.createTransport = () => ({ sendMail: async value => { mail = value; } });
beforeEach(async () => {
  mail = null; record = null; updates = 0;
  user = { usuario_id: 7, usuario_email: 'teste@example.invalid', usuario_status: true,
    usuario_senha: await bcrypt.hash('Anterior1', 4), usuario_meta_valor_mensal: 100, _count: { tb_preferencia: 1 } };
  mock.method(client, '$queryRaw', async () => []);
  mock.method(client.tb_usuario, 'findUnique', async () => user);
  mock.method(client.tb_usuario, 'update', async ({ data }) => { updates++; Object.assign(user, data); return user; });
  mock.method(client.tb_redefinicao_senha, 'findFirst', async () => record?.redefinicao_senha_usado ? null : record);
  mock.method(client.tb_redefinicao_senha, 'create', async ({ data }) => (record = {
    ...data, redefinicao_senha_id: 1, redefinicao_senha_usado: false,
    redefinicao_senha_tentativas: 0, redefinicao_senha_data_criacao: new Date(),
  }));
  mock.method(client.tb_redefinicao_senha, 'updateMany', async ({ where, data }) => {
    if (!record || record.redefinicao_senha_usado || record.redefinicao_senha_expira_em <= new Date()) return { count: 0 };
    if (where.redefinicao_senha_tentativas && record.redefinicao_senha_tentativas >= where.redefinicao_senha_tentativas.lt) return { count: 0 };
    if (data.redefinicao_senha_tentativas) record.redefinicao_senha_tentativas++;
    if (data.redefinicao_senha_usado) record.redefinicao_senha_usado = true;
    return { count: 1 };
  });
});
afterEach(() => mock.restoreAll());
async function issue() {
  await AuthService.forgotPassword(user.usuario_email);
  return new URL(mail.html.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&')).searchParams.get('token');
}
test('link contém token aleatório de 256 bits; banco guarda apenas hashes', async () => {
  const token = await issue();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.ok(!record.redefinicao_senha_codigo_hash.includes(token));
  assert.equal(record.redefinicao_senha_codigo_hash.split('|')[1], crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(record.redefinicao_senha_expira_em > new Date());
});
test('token válido redefine, permite novo login e rejeita senha anterior e reuso', async () => {
  const token = await issue();
  await AuthService.resetPassword(user.usuario_email, token, 'NovaSenha1');
  assert.equal(updates, 1);
  assert.ok((await AuthService.login(user.usuario_email, 'NovaSenha1')).token);
  await assert.rejects(AuthService.login(user.usuario_email, 'Anterior1'));
  await assert.rejects(AuthService.resetPassword(user.usuario_email, token, 'OutraSenha1'));
});
test('código manual continua compatível com o link e é de uso único', async () => {
  await issue();
  const code = mail.html.match(/letter-spacing:4px;">(\d{6})/)[1];
  assert.deepEqual(await AuthService.verifyResetCode(user.usuario_email, code), { valido: true });
  await AuthService.resetPassword(user.usuario_email, code, 'NovaSenha1');
  await assert.rejects(AuthService.verifyResetCode(user.usuario_email, code));
});
test('token expirado não atualiza senha', async () => {
  const token = await issue(); record.redefinicao_senha_expira_em = new Date(0);
  await assert.rejects(AuthService.resetPassword(user.usuario_email, token, 'NovaSenha1'));
  assert.equal(updates, 0);
});
test('registro legado com apenas bcrypt continua aceitando código manual', async () => {
  await issue();
  record.redefinicao_senha_codigo_hash = await bcrypt.hash('123456', 4);
  await AuthService.resetPassword(user.usuario_email, '123456', 'NovaSenha1');
  assert.equal(updates, 1);
});
test('token inválido consome tentativa; verificações concorrentes param em cinco', async () => {
  await issue();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => AuthService.verifyResetCode(user.usuario_email, '0'.repeat(64))));
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(record.redefinicao_senha_tentativas, 5);
  assert.equal(updates, 0);
});
test('duas conclusões concorrentes produzem somente uma atualização', async () => {
  const token = await issue();
  const results = await Promise.allSettled([AuthService.resetPassword(user.usuario_email, token, 'NovaSenha1'), AuthService.resetPassword(user.usuario_email, token, 'OutraSenha1')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(updates, 1);
});
test('reenvio dentro do cooldown não emite outro token', async () => {
  await issue(); await AuthService.forgotPassword(user.usuario_email);
  assert.equal(client.tb_redefinicao_senha.create.mock.callCount(), 1);
});
test('contrato rejeita senha fraca, excesso de bytes e token malformado', () => {
  for (const novaSenha of ['abc', 'abcdef', 'é'.repeat(36) + '1']) {
    assert.equal(resetPasswordSchema.safeParse({ email: user.usuario_email, codigo: '123456', novaSenha }).success, false);
  }
  assert.equal(verifyResetCodeSchema.safeParse({ email: user.usuario_email, codigo: 'x'.repeat(64) }).success, false);
  assert.equal(resetPasswordSchema.safeParse({ email: user.usuario_email, codigo: '123456', novaSenha: 'NovaSenha1', confirmarSenha: 'OutraSenha1' }).success, false);
});
