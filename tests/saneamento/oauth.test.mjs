import { client } from './runtime.mjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, mock, test } from 'node:test';
const { OAuthTentativaService: OAuth, hashOAuth } = await import('../../src/modules/email/oauth-tentativa.service.ts');
const { EmailService } = await import('../../src/modules/email/email.service.ts');
const { EmailController } = await import('../../src/modules/email/email.controller.ts');
const { ConsentimentoService: Consent } = await import('../../src/modules/consentimento/consentimento.service.ts');
let dados, credenciais, emTransacao;
const matches = (row, where) => Object.entries(where).every(([k, value]) => {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if ('in' in value) return value.in.includes(row[k]);
    if ('gt' in value) return row[k] > value.gt;
    if ('lt' in value) return row[k] < value.lt;
    if (k === 'tb_consentimento_tipo') return true;
  }
  return row[k] === value;
});
beforeEach(() => {
  credenciais = { tentativa: randomUUID(), state: randomBytes(32).toString('base64url'), segredo: randomBytes(32).toString('base64url'), code: 'codigo-simulado' };
  dados = {
    tentativas: [{ oauth_tentativa_id: credenciais.tentativa, usuario_id: 7, oauth_provedor: 'GMAIL',
      oauth_state_hash: hashOAuth(credenciais.state), oauth_finalizacao_hash: hashOAuth(credenciais.segredo),
      oauth_status: 'PENDENTE', oauth_expira_em: new Date(Date.now() + 600000) }],
    integracoes: [{ usuario_id: 7, integracao_provedor: 'OUTLOOK', integracao_nome: 'outlook@example.invalid' }],
    consentimento: null,
  };
  emTransacao = false;
  mock.method(console, 'error', () => {});
  // Transações simuladas com rollback. Locks reais devem ser testados em PostgreSQL separado.
  let anterior = Promise.resolve();
  mock.method(client, '$transaction', fn => {
    const executar = async () => {
      const copia = structuredClone(dados);
      emTransacao = true;
      try { return await fn(client); }
      catch (error) { dados = copia; throw error; }
      finally { emTransacao = false; }
    };
    const atual = anterior.then(executar);
    anterior = atual.catch(() => undefined);
    return atual;
  });
  mock.method(client, '$queryRaw', async () => [{ usuario_id: 7 }]);
  mock.method(client.tb_oauth_tentativa, 'findUnique', async ({ where }) => dados.tentativas.find(t => matches(t, where)) ?? null);
  mock.method(client.tb_oauth_tentativa, 'findFirst', async ({ where }) => dados.tentativas.find(t => matches(t, where)) ?? null);
  mock.method(client.tb_oauth_tentativa, 'create', async ({ data }) => { dados.tentativas.push({ oauth_status: 'PENDENTE', ...data }); return data; });
  mock.method(client.tb_oauth_tentativa, 'updateMany', async ({ where, data }) => {
    const rows = dados.tentativas.filter(t => matches(t, where));
    rows.forEach(t => Object.assign(t, data)); return { count: rows.length };
  });
  mock.method(client.tb_oauth_tentativa, 'update', async ({ where, data }) => Object.assign(dados.tentativas.find(t => matches(t, where)), data));
  mock.method(client.tb_oauth_tentativa, 'deleteMany', async () => ({ count: 0 }));
  mock.method(client.tb_integracao, 'findFirst', async ({ where }) => dados.integracoes.find(i => matches(i, where)) ?? null);
  mock.method(client.tb_integracao, 'deleteMany', async ({ where }) => {
    dados.integracoes = dados.integracoes.filter(i => !matches(i, where)); return { count: 1 };
  });
  mock.method(client.tb_integracao, 'create', async ({ data }) => { dados.integracoes.push(data); return data; });
  mock.method(client.tb_consentimento_tipo, 'findUnique', async () => ({ consentimento_tipo_id: 2 }));
  mock.method(client.tb_consentimento, 'findUnique', async () => dados.consentimento);
  mock.method(client.tb_consentimento, 'findFirst', async () => dados.consentimento?.consentimento_status ? dados.consentimento : null);
  mock.method(client.tb_consentimento, 'upsert', async ({ create, update }) => {
    dados.consentimento = dados.consentimento ? { ...dados.consentimento, ...update } : create;
    return dados.consentimento;
  });
  mock.method(EmailService, 'exchangeCodeForTokens', async () => {
    assert.equal(emTransacao, false);
    return { access_token: 'token-simulado', refresh_token: 'refresh-simulado', expires_in: 3600 };
  });
  mock.method(EmailService, 'getGoogleUserEmail', async () => {
    assert.equal(emTransacao, false); return 'gmail@example.invalid';
  });
});
afterEach(() => mock.restoreAll());
test('início gera hashes e cancela tentativa anterior', async () => {
  const nova = await OAuth.iniciar(7);
  assert.notEqual(nova.state, credenciais.state);
  assert.equal(dados.tentativas[0].oauth_status, 'CANCELADA');
  assert.equal(dados.tentativas[1].oauth_state_hash, hashOAuth(nova.state));
  assert.ok(!JSON.stringify(dados).includes(nova.segredo));
});
test('state adulterado e expirado são rejeitados', async () => {
  await assert.rejects(OAuth.callback(randomBytes(32).toString('base64url')));
  dados.tentativas[0].oauth_expira_em = new Date(0);
  await assert.rejects(OAuth.callback(credenciais.state));
});
test('callback repetido não consome nem persiste integração', async () => {
  assert.equal(await OAuth.callback(credenciais.state), credenciais.tentativa);
  assert.equal(await OAuth.callback(credenciais.state), credenciais.tentativa);
  assert.equal(dados.tentativas[0].oauth_status, 'PENDENTE');
  assert.equal(client.tb_integracao.create.mock.callCount(), 0);
});
test('callback tem no-store e retorno correlacionado sem segredo', async () => {
  const res = { set(v) { this.headers = v; }, redirect(status, url) { this.status = status; this.url = url; } };
  await EmailController.callback({ query: { state: credenciais.state, code: credenciais.code } }, res);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(new URL(res.url).searchParams.get('tentativa'), credenciais.tentativa);
  assert.ok(!res.url.includes(credenciais.segredo));
});
for (const [nome, userId, mudar] of [
  ['outro usuário', 8, c => c], ['segredo incorreto', 7, c => ({ ...c, segredo: randomBytes(32).toString('base64url') })],
  ['state incorreto', 7, c => ({ ...c, state: randomBytes(32).toString('base64url') })],
]) test(nome + ' não consome tentativa', async () => {
  await assert.rejects(EmailService.finalizar(userId, mudar(credenciais)));
  assert.equal(dados.tentativas[0].oauth_status, 'PENDENTE');
  assert.equal(EmailService.exchangeCodeForTokens.mock.callCount(), 0);
});
test('finalização confirma atomicamente e preserva Outlook', async () => {
  assert.deepEqual(await EmailService.finalizar(7, credenciais), { concluida: true });
  assert.equal(dados.integracoes.length, 2);
  assert.equal(dados.consentimento.consentimento_status, true);
  assert.equal(dados.tentativas[0].oauth_status, 'CONCLUIDA');
});
test('replay/finalização repetida não troca tokens novamente', async () => {
  await EmailService.finalizar(7, credenciais);
  await assert.rejects(EmailService.finalizar(7, credenciais));
  await assert.rejects(OAuth.callback(credenciais.state));
  assert.equal(EmailService.exchangeCodeForTokens.mock.callCount(), 1);
});
test('duas finalizações concorrentes só consomem uma vez no runner serializado', async () => {
  // Outra requisição pode ter uma transação aberta; isso não significa que esta
  // chamada de rede esteja dentro da transação da sua própria requisição.
  mock.method(EmailService, 'exchangeCodeForTokens', async () => ({ access_token: 'simulado', refresh_token: 'simulado', expires_in: 3600 }));
  mock.method(EmailService, 'getGoogleUserEmail', async () => 'gmail@example.invalid');
  const results = await Promise.allSettled([EmailService.finalizar(7, credenciais), EmailService.finalizar(7, credenciais)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(EmailService.exchangeCodeForTokens.mock.callCount(), 1);
});
test('falha no consentimento desfaz integração e preserva a anterior', async () => {
  dados.integracoes.push({ usuario_id: 7, integracao_provedor: 'GMAIL', integracao_nome: 'anterior@example.invalid' });
  mock.method(client.tb_consentimento, 'upsert', async () => { throw new Error('falha simulada'); });
  await assert.rejects(EmailService.finalizar(7, credenciais));
  assert.equal(dados.integracoes.length, 2);
  assert.equal(dados.integracoes[1].integracao_nome, 'anterior@example.invalid');
  assert.equal(dados.tentativas[0].oauth_status, 'FALHOU');
});
test('reconexão substitui somente Gmail do usuário', async () => {
  dados.integracoes.push({ usuario_id: 7, integracao_provedor: 'GMAIL', integracao_nome: 'anterior@example.invalid' });
  dados.integracoes.push({ usuario_id: 8, integracao_provedor: 'GMAIL', integracao_nome: 'outro@example.invalid' });
  await EmailService.finalizar(7, credenciais);
  assert.equal(dados.integracoes.length, 3);
  assert.ok(dados.integracoes.some(i => i.usuario_id === 8));
});
test('revogar duas vezes preserva data e remove Gmail/Outlook somente do usuário', async () => {
  dados.integracoes.push({ usuario_id: 8, integracao_provedor: 'GMAIL' });
  await Consent.registrar(7, 'EMAIL', false);
  const data = dados.consentimento.consentimento_data_criacao;
  await Consent.registrar(7, 'EMAIL', false);
  assert.equal(dados.consentimento.consentimento_data_criacao, data);
  assert.equal(dados.integracoes.length, 1);
  assert.equal(dados.integracoes[0].usuario_id, 8);
  await assert.rejects(EmailService.finalizar(7, credenciais));
});
test('revogação durante Google impede confirmação posterior', async () => {
  mock.method(EmailService, 'exchangeCodeForTokens', async () => {
    await Consent.registrar(7, 'EMAIL', false);
    return { access_token: 'simulado', refresh_token: 'simulado', expires_in: 3600 };
  });
  await assert.rejects(EmailService.finalizar(7, credenciais));
  assert.equal(dados.integracoes.length, 0);
  assert.equal(dados.consentimento.consentimento_status, false);
  assert.equal(dados.tentativas[0].oauth_status, 'CANCELADA');
});
test('não permite concessão EMAIL fora da conexão confirmada', async () => {
  await assert.rejects(Consent.registrar(7, 'EMAIL', true));
});
test('cancelamento é idempotente e impede uso posterior', async () => {
  await OAuth.encerrar(7, credenciais, 'CANCELADA');
  await OAuth.encerrar(7, credenciais, 'CANCELADA');
  await assert.rejects(OAuth.consumir(7, credenciais));
});
test('estado distingue autorização sem conexão e não retorna tokens', async () => {
  dados.consentimento = { consentimento_status: true };
  dados.tentativas[0].oauth_status = 'CANCELADA';
  assert.deepEqual(await EmailService.estado(7), { autorizacaoEmail: true, conexaoEmail: 'desconectado' });
});
