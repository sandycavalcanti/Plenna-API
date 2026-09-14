import { client } from './runtime.mjs';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import nodemailer from 'nodemailer';
const { AuthController } = await import('../../src/modules/auth/auth.controller.ts');
const { AuthService } = await import('../../src/modules/auth/auth.service.ts');
const { permitirRedefinicao, obterIp } = await import('../../src/modules/auth/redefinicao-rate-limit.ts');
const { logSeguro } = await import('../../src/utils/logSeguro.ts');
const { env } = await import('../../src/lib/env.ts');
let envioFalha = false;
let transporte;
nodemailer.createTransport = opcoes => {
  transporte = opcoes;
  return { sendMail: async () => { if (envioFalha) throw new Error('SEGREDO-SMTP'); } };
};
beforeEach(() => {
  envioFalha = false;
  mock.method(console, 'error', () => {});
  mock.method(client, '$queryRaw', async () => [{ limite_contagem: 1 }]);
  mock.method(client, '$executeRaw', async () => 0);
  mock.method(client.tb_usuario, 'findUnique', async () => ({ usuario_id: 7, usuario_email: 'teste@example.invalid', usuario_nome: 'Teste' }));
  mock.method(client.tb_redefinicao_senha, 'findFirst', async () => null);
  mock.method(client.tb_redefinicao_senha, 'updateMany', async () => ({ count: 1 }));
  mock.method(client.tb_redefinicao_senha, 'create', async () => ({ redefinicao_senha_id: 11 }));
  mock.method(client.tb_redefinicao_senha, 'update', async () => ({}));
});
afterEach(() => mock.restoreAll());
async function solicitar(body = { email: 'teste@example.invalid' }) {
  const res = { codigo: null, corpo: null, status(n) { this.codigo = n; return this; }, json(v) { this.corpo = v; return this; } };
  await AuthController.forgotPassword({ body, socket: { remoteAddress: '127.0.0.1' } }, res);
  return { codigo: res.codigo, corpo: res.corpo };
}
const resposta = { codigo: 200, corpo: { message: 'Se houver uma conta associada a este e-mail, você receberá instruções para redefinir a senha. Caso não receba, aguarde e tente novamente.' } };
test('conta ausente recebe resposta genérica', async () => {
  mock.method(client.tb_usuario, 'findUnique', async () => null);
  assert.deepEqual(await solicitar(), resposta);
});
test('cooldown recebe resposta genérica e não cria código', async () => {
  mock.method(client.tb_redefinicao_senha, 'findFirst', async () => ({ redefinicao_senha_data_criacao: new Date() }));
  assert.deepEqual(await solicitar(), resposta);
  assert.equal(client.tb_redefinicao_senha.create.mock.callCount(), 0);
});
test('rate limit ocorre antes da consulta da conta', async () => {
  mock.method(client, '$queryRaw', async () => [{ limite_contagem: 21 }]);
  assert.deepEqual(await solicitar(), resposta);
  assert.equal(client.tb_usuario.findUnique.mock.callCount(), 0);
});
test('falha do limitador fecha envio e preserva resposta', async () => {
  mock.method(client, '$queryRaw', async () => { throw new Error('SEGREDO-BANCO'); });
  assert.deepEqual(await solicitar(), resposta);
  assert.equal(client.tb_usuario.findUnique.mock.callCount(), 0);
});
test('SMTP realizado recebe resposta genérica e usa timeout', async () => {
  assert.deepEqual(await solicitar(), resposta);
  assert.equal(transporte.connectionTimeout, 10000);
  assert.equal(transporte.socketTimeout, 15000);
});
test('falha SMTP invalida somente tentativa nova e não vaza erro', async () => {
  envioFalha = true;
  assert.deepEqual(await solicitar(), resposta);
  assert.deepEqual(client.tb_redefinicao_senha.update.mock.calls[0].arguments[0], {
    where: { redefinicao_senha_id: 11 }, data: { redefinicao_senha_usado: true },
  });
  assert.ok(!JSON.stringify(console.error.mock.calls).includes('SEGREDO-SMTP'));
});
test('falha da invalidação recebe evento separado e mesma resposta', async () => {
  envioFalha = true;
  mock.method(client.tb_redefinicao_senha, 'update', async () => { throw new Error('SEGREDO-INVALIDACAO'); });
  assert.deepEqual(await solicitar(), resposta);
  assert.ok(console.error.mock.calls.some(c => c.arguments[0].evento === 'redefinicao_invalidacao_falhou'));
});
test('falha operacional depois da consulta não altera resposta', async () => {
  mock.method(client.tb_redefinicao_senha, 'findFirst', async () => { throw new Error('SEGREDO'); });
  assert.deepEqual(await solicitar(), resposta);
});
test('entrada inválida permanece 400', async () => assert.equal((await solicitar({ email: 'invalido' })).codigo, 400));
test('logger não copia campos livres do erro', () => {
  logSeguro('redefinicao_falhou', { code: 'EAUTH', message: 'VAZAMENTO', stack: 'VAZAMENTO', config: { password: 'VAZAMENTO' } });
  const evento = console.error.mock.calls[0].arguments[0];
  assert.deepEqual(Object.keys(evento).sort(), ['categoria', 'correlacao', 'evento']);
  assert.equal(evento.categoria, 'autenticacao');
  assert.ok(!JSON.stringify(evento).includes('VAZAMENTO'));
});
test('HMAC separa contexto, normaliza email e SQL é parametrizado', async () => {
  await permitirRedefinicao(' TESTE@example.invalid ', '127.0.0.1');
  const chamadas = client.$queryRaw.mock.calls;
  const chaveIp = chamadas[0].arguments[1];
  const chaveEmail = chamadas[1].arguments[1];
  assert.match(chaveIp, /^[a-f0-9]{64}$/);
  assert.notEqual(chaveIp, chaveEmail);
  assert.match(chamadas[0].arguments[0].join('?'), /ON CONFLICT.*DO UPDATE/s);
  await permitirRedefinicao('teste@example.invalid', '127.0.0.1');
  assert.equal(client.$queryRaw.mock.calls[3].arguments[1], chaveEmail);
});
test('sem chave HMAC não acessa banco', async () => {
  const chave = env.rateLimitHmacKey;
  env.rateLimitHmacKey = undefined;
  try { await assert.rejects(permitirRedefinicao('teste@example.invalid', '127.0.0.1')); }
  finally { env.rateLimitHmacKey = chave; }
  assert.equal(client.$queryRaw.mock.callCount(), 0);
});
test('fora da Vercel ignora header fornecido pelo cliente', () => {
  assert.equal(obterIp({ socket: { remoteAddress: '127.0.0.1' }, get: () => '8.8.8.8' }), '127.0.0.1');
});

test('solicitações concorrentes respeitam resultado do contador atômico simulado', async () => {
  const contadores = new Map();
  mock.method(client, '$queryRaw', async (_sql, chave) => {
    const contagem = (contadores.get(chave) ?? 0) + 1;
    contadores.set(chave, contagem);
    return [{ limite_contagem: contagem }];
  });
  const resultados = await Promise.all(Array.from({ length: 10 }, () => permitirRedefinicao('teste@example.invalid', '127.0.0.1')));
  assert.equal(resultados.filter(Boolean).length, 3);
});
