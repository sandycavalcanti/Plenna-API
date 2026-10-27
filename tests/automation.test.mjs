import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://localhost:1/plenna_automation_test';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.GOOGLE_CLIENT_ID = 'automation-client';
process.env.GOOGLE_CLIENT_SECRET = 'automation-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://example.test/callback';
process.env.JWT_SECRET = 'automation-jwt-secret';
process.env.CRON_SECRET = 'cron-secret';

const compiled = '../.tmp-automation-compile/src/modules/';
const { AutomationJobService } = await import(`${compiled}automacao/automacao.service.js`);
const { AutomationController } = await import(`${compiled}automacao/automacao.controller.js`);
const { env } = await import(`${compiled}../lib/env.js`);
const { CONSENTIMENTO_CODIGOS } = await import(`${compiled}consentimento/consentimento.constants.js`);

function settings(overrides = {}) {
  return {
    enabled: true,
    batchSize: 2,
    maxUsers: 20,
    timeoutMs: 1000,
    maxErrors: 3,
    maxRecommendationCalls: 20,
    maxProactivityCalls: 20,
    timezone: 'America/Sao_Paulo',
    ...overrides,
  };
}

function users(ids) {
  return {
    calls: [],
    async countActive() {
      return ids.length;
    },
    async listActive(offset, limit) {
      this.calls.push({ offset, limit });
      if (ids.length === 0) return [];
      return Array.from({ length: Math.min(limit, ids.length) }, (_, index) => ids[(offset + index) % ids.length]);
    },
  };
}

function consentMap(overrides = {}) {
  return async (userId, code) => overrides[`${userId}:${code}`] ?? true;
}

function request(authorization) {
  return {
    headers: { authorization },
    header(name) { return this.headers[name]; },
  };
}

function response() {
  const result = { statusCode: 200, body: undefined };
  result.status = (code) => { result.statusCode = code; return result; };
  result.json = (body) => { result.body = body; return result; };
  return result;
}

test('não existe modelo nem arquivo de persistência do job', () => {
  const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  assert.doesNotMatch(schema, /tb_ai_automacao_execucao/);
  assert.equal(existsSync(new URL('../src/modules/automacao/automacao.repository.ts', import.meta.url)), false);
});

test('flag desabilitada não consulta usuários e não executa RF026/RF027', async () => {
  let selected = false;
  const service = new AutomationJobService({
    users: { countActive: async () => { selected = true; return 1; }, listActive: async () => [1] },
    settings: settings({ enabled: false }),
  });
  const result = await service.run();
  assert.equal(result.status, 'DESABILITADA');
  assert.equal(selected, false);
});

test('cron autenticado processa RF026 antes de RF027 e respeita consentimentos', async () => {
  const selected = users([2, 3, 4]);
  const calls = [];
  const service = new AutomationJobService({
    users: selected,
    consent: consentMap({ [`3:${CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO}`]: false }),
    recommendations: async (userId) => {
      calls.push(`rf026:${userId}`);
      return { itens: userId === 2 ? [{ codigo: 'ORCAMENTO' }] : [] };
    },
    proactivity: async (userId) => {
      calls.push(`rf027:${userId}`);
      return { estado: 'CRIADA' };
    },
    settings: settings(),
  });
  const result = await service.run({ now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(result.status, 'CONCLUIDA');
  assert.deepEqual(calls, ['rf026:4', 'rf026:2', 'rf027:2']);
  assert.equal(result.conversationsCreated, 1);
});

test('repetições não duplicam recomendação ou conversa quando os serviços idempotentes são reutilizados', async () => {
  const selected = users([10, 20]);
  const recommendations = new Set();
  const conversations = new Set();
  const service = new AutomationJobService({
    users: selected,
    consent: consentMap(),
    recommendations: async (userId) => {
      const first = !recommendations.has(userId);
      recommendations.add(userId);
      return { itens: first ? [{ codigo: 'EVENTO' }] : [{ codigo: 'EVENTO' }] };
    },
    proactivity: async (userId) => {
      if (conversations.has(userId)) return { estado: 'EXISTENTE' };
      conversations.add(userId);
      return { estado: 'CRIADA' };
    },
    settings: settings({ maxUsers: 2 }),
  });
  const first = await service.run({ now: new Date('2026-10-24T12:00:00Z') });
  const repeated = await service.run({ now: new Date('2026-10-24T12:05:00Z') });
  assert.equal(first.conversationsCreated, 2);
  assert.equal(repeated.conversationsCreated, 0);
  assert.equal(conversations.size, 2);
});

test('seleção diária distribui usuários sem checkpoint persistente', async () => {
  const selected = users([1, 2, 3, 4, 5, 6]);
  const service = new AutomationJobService({
    users: selected,
    consent: consentMap(),
    recommendations: async () => ({ itens: [] }),
    settings: settings({ maxUsers: 2 }),
  });
  await service.run({ now: new Date('2026-10-24T12:00:00Z') });
  await service.run({ now: new Date('2026-10-25T12:00:00Z') });
  assert.equal(selected.calls.length, 2);
  assert.notEqual(selected.calls[0].offset, selected.calls[1].offset);
  assert.deepEqual(selected.calls.map((call) => call.limit), [2, 2]);
});

test('falhas individuais são registradas e não repetidas na mesma execução', async () => {
  const selected = users([10, 20, 30]);
  const calls = [];
  const service = new AutomationJobService({
    users: selected,
    consent: consentMap(),
    recommendations: async (userId) => {
      calls.push(userId);
      if (userId === 10) throw new Error('consulta indisponível');
      return { itens: [] };
    },
    settings: settings({ maxErrors: 3 }),
  });
  const result = await service.run({ now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(result.status, 'CONCLUIDA');
  assert.equal(result.errors, 1);
  assert.deepEqual(calls, [20, 30, 10]);
});

test('timeout interrompe sem retry automático e a próxima execução é independente', async () => {
  const selected = users([30]);
  let calls = 0;
  const service = new AutomationJobService({
    users: selected,
    consent: consentMap(),
    recommendations: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { itens: [] };
    },
    settings: settings({ timeoutMs: 5 }),
  });
  const first = await service.run({ now: new Date('2026-10-24T12:00:00Z') });
  const second = await service.run({ now: new Date('2026-10-25T12:00:00Z') });
  assert.equal(first.status, 'INTERROMPIDA');
  assert.equal(first.timeouts, 1);
  assert.equal(second.status, 'INTERROMPIDA');
  assert.equal(calls, 2);
});

test('limites de chamadas são aplicados por execução', async () => {
  const selected = users([40, 50, 60]);
  let calls = 0;
  const service = new AutomationJobService({
    users: selected,
    consent: consentMap(),
    recommendations: async () => { calls += 1; return { itens: [] }; },
    settings: settings({ maxRecommendationCalls: 1 }),
  });
  const result = await service.run({ now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(result.status, 'INTERROMPIDA');
  assert.equal(result.reason, 'LIMITE_CHAMADAS_RECOMENDACAO');
  assert.equal(calls, 1);
});

test('controller exige CRON_SECRET e respeita a flag sem depender de persistência', async () => {
  const unauthorized = response();
  await AutomationController.process(request('Bearer wrong'), unauthorized, async () => { throw new Error('não esperado'); });
  assert.equal(unauthorized.statusCode, 401);

  const originalEnabled = env.aiAutomationEnabled;
  env.aiAutomationEnabled = false;
  try {
    const disabled = response();
    await AutomationController.process(request('Bearer cron-secret'), disabled);
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.body.processed, false);
  } finally {
    env.aiAutomationEnabled = originalEnabled;
  }
});
