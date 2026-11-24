import './offline-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcrypt';

test('redefinição atualiza a credencial e consome o código uma única vez', async () => {
  const { AuthService } = await import('../../dist/src/modules/auth/auth.service.js');
  const { prisma } = await import('../../dist/src/lib/prisma.js');
  const user = {
    usuario_id: 10,
    usuario_email: 'conta@example.test',
    usuario_status: true,
    usuario_senha: await bcrypt.hash('Anterior123', 4),
    _count: { tb_preferencia: 0 },
  };
  const registro = {
    redefinicao_senha_id: 1,
    redefinicao_senha_usado: false,
    redefinicao_senha_expira_em: new Date(Date.now() + 60_000),
    redefinicao_senha_tentativas: 0,
    redefinicao_senha_codigo_hash: await bcrypt.hash('123456', 4),
  };
  const users = prisma.tb_usuario;
  const resets = prisma.tb_redefinicao_senha;
  users.findFirst = async () => user;
  users.update = async ({ data }) => Object.assign(user, data);
  resets.findFirst = async () => registro.redefinicao_senha_usado ? null : registro;
  resets.updateMany = async () => {
    if (registro.redefinicao_senha_usado) return { count: 0 };
    registro.redefinicao_senha_usado = true;
    return { count: 1 };
  };
  prisma.$transaction = async (callback) => callback(prisma);
  prisma.$queryRaw = async (sql, value) => {
    const matches = sql.join('').includes('lower(usuario_email)')
      ? user.usuario_email.toLowerCase() === value.toLowerCase()
      : user.usuario_id === value;
    return user.usuario_status && matches ? [{ usuario_id: user.usuario_id }] : [];
  };

  const { forgotPasswordSchema, registerSchema } = await import('../../dist/src/modules/auth/auth.schemas.js');
  const cadastro = registerSchema.parse({
    nome: 'Conta teste', email: 'Conta@example.test', senha: 'Anterior123', aceitouTermos: true,
  });
  assert.equal(cadastro.email, 'conta@example.test');
  user.usuario_email = 'Conta@example.test';
  const emailRecuperacao = forgotPasswordSchema.parse({ email: cadastro.email }).email;
  const expiraEm = registro.redefinicao_senha_expira_em;
  registro.redefinicao_senha_expira_em = new Date(Date.now() - 1);
  await assert.rejects(AuthService.verifyResetCode(emailRecuperacao, '123456'), { statusCode: 400 });
  registro.redefinicao_senha_expira_em = expiraEm;
  registro.redefinicao_senha_tentativas = 5;
  await assert.rejects(AuthService.verifyResetCode(emailRecuperacao, '123456'), { statusCode: 429 });
  registro.redefinicao_senha_tentativas = 0;
  await AuthService.verifyResetCode(emailRecuperacao, '123456');
  await AuthService.resetPassword(emailRecuperacao, '123456', 'Nova123');
  assert.ok((await AuthService.login(user.usuario_email, 'Nova123')).token);
  await assert.rejects(AuthService.login(user.usuario_email, 'Anterior123'), { statusCode: 401 });
  await assert.rejects(AuthService.resetPassword(user.usuario_email, '123456', 'Outra123'), { statusCode: 400 });
  user.usuario_status = false;
  await assert.rejects(AuthService.login(emailRecuperacao, 'Nova123'), { statusCode: 401 });
  await assert.rejects(AuthService.verifyResetCode(emailRecuperacao, '123456'), { statusCode: 400 });
});
