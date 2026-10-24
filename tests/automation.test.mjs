import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/plenna_automation_offline';
process.env.DIRECT_URL ??= process.env.DATABASE_URL;
process.env.GOOGLE_CLIENT_ID ??= 'offline-client';
process.env.GOOGLE_CLIENT_SECRET ??= 'offline-secret';
process.env.GOOGLE_REDIRECT_URI ??= 'https://example.test/callback';
process.env.AI_AUTOMATION_ENABLED = 'false';
process.env.CRON_SECRET = 'offline-cron-secret';

globalThis.prismaRuntime = { client: {}, pool: { end: async () => {} } };

const compiled = '../.tmp-phase5-compile/src/modules/';
const { AutomationJobService } = await import(`${compiled}automacao/automacao.service.js`);
const { AutomationController } = await import(`${compiled}automacao/automacao.controller.js`);
const { env } = await import(`${compiled}../lib/env.js`);
const { CONSENTIMENTO_CODIGOS } = await import(`${compiled}consentimento/consentimento.constants.js`);

function fakeRepository() {
  let current = null;
  let nextId = 1;
  return {
    get record() { return current; },
    async acquire(key, now) {
      if (!current) {
        current = {
          id: nextId++, key, status: 'EM_ANDAMENTO', cursorUserId: null,
          usersEvaluated: 0, recommendationsGenerated: 0, conversationsCreated: 0,
          actionsSuppressed: 0, errors: 0, timeouts: 0, startedAt: now,
          updatedAt: now, finishedAt: null, reason: null,
        };
        return { acquired: true, record: { ...current } };
      }
      if (current.status === 'CONCLUIDA') return { acquired: false, reason: 'JA_CONCLUIDA', record: { ...current } };
      if (current.status === 'EM_ANDAMENTO') return { acquired: false, reason: 'CONCORRENCIA', record: { ...current } };
      current.status = 'EM_ANDAMENTO';
      current.updatedAt = now;
      return { acquired: true, record: { ...current } };
    },
    async progress(id, values, now) {
      assert.equal(id, current.id);
      Object.assign(current, values, { updatedAt: now });
    },
    async finish(id, status, reason, now) {
      assert.equal(id, current.id);
      Object.assign(current, { status, reason, updatedAt: now, finishedAt: now });
    },
  };
}

function users(ids) {
  return {
    calls: [],
    async listActive(after, limit) {
      this.calls.push({ after, limit });
      return ids.filter((id) => after === null || id > after).slice(0, limit);
    },
  };
}

function consentMap(values) {
  return async (userId, code) => values[`${userId}:${code}`] === true;
}

function settings(overrides = {}) {
  return {
    enabled: true, batchSize: 2, maxUsers: 20, timeoutMs: 1000, maxErrors: 3,
    maxRecommendationCalls: 20, maxProactivityCalls: 20, leaseMs: 1000,
    timezone: 'America/Sao_Paulo', ...overrides,
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(authorization) {
  return { headers: { authorization }, header(name) { return this.headers[name]; } };
}

test('flag desabilitada não consulta checkpoint nem usuários', async () => {
  const service = new AutomationJobService({ settings: settings({ enabled: false }) });
  const result = await service.run();
  assert.equal(result.status, 'DESABILITADA');
});

test('processa RF026 antes de RF027 e respeita os dois consentimentos', async () => {
  const repository = fakeRepository();
  const selected = users([1, 2, 3, 4]);
  const recommendationCalls = [];
  const proactivityCalls = [];
  const service = new AutomationJobService({
    repository, users: selected,
    consent: consentMap({
      [`2:${CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO}`]: true,
      [`2:${CONSENTIMENTO_CODIGOS.IA_PROATIVIDADE}`]: true,
      [`3:${CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO}`]: true,
      [`4:${CONSENTIMENTO_CODIGOS.IA_PERSONALIZACAO}`]: true,
      [`4:${CONSENTIMENTO_CODIGOS.IA_PROATIVIDADE}`]: true,
    }),
    recommendations: async (userId) => {
      recommendationCalls.push(userId);
      return { itens: userId === 4 ? [] : [{ id: userId }] };
    },
    proactivity: async (userId) => {
      proactivityCalls.push(userId);
      return { estado: 'CRIADA' };
    },
    settings: settings(),
  });

  const result = await service.run({ now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(result.status, 'CONCLUIDA');
  assert.deepEqual(recommendationCalls, [2, 3, 4]);
  assert.deepEqual(proactivityCalls, [2]);
  assert.equal(result.recommendationsGenerated, 2);
  assert.equal(result.conversationsCreated, 1);
  assert.equal(result.actionsSuppressed, 2);
});

test('limita erros por usuário e retoma pelo cursor persistido', async () => {
  const repository = fakeRepository();
  const selected = users([10, 20]);
  let recommendationCalls = 0;
  const dependencies = {
    repository,
    users: selected,
    consent: async () => true,
    recommendations: async () => { recommendationCalls += 1; throw new Error('consulta falhou'); },
    settings: settings({ maxErrors: 1 }),
  };
  const first = await new AutomationJobService(dependencies).run({ now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(first.status, 'INTERROMPIDA');
  assert.equal(first.reason, 'LIMITE_ERROS');
  assert.equal(repository.record.cursorUserId, 10);

  dependencies.recommendations = async () => { recommendationCalls += 1; return { itens: [] }; };
  const second = await new AutomationJobService(dependencies).run({ now: new Date('2026-10-24T12:05:00Z') });
  assert.equal(second.status, 'CONCLUIDA');
  assert.equal(repository.record.cursorUserId, 20);
  assert.equal(recommendationCalls, 2);
});

test('timeout não faz retry automático e uma execução concorrente é recusada', async () => {
  const repository = fakeRepository();
  const selected = users([30]);
  let calls = 0;
  const service = new AutomationJobService({
    repository, users: selected, consent: async () => true,
    recommendations: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return { itens: [] }; },
    settings: settings({ timeoutMs: 5 }),
  });
  const firstRun = service.run({ now: new Date('2026-10-24T12:00:00Z') });
  const concurrent = await service.run({ now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(concurrent.status, 'CONCORRENCIA');
  const first = await firstRun;
  assert.equal(first.status, 'INTERROMPIDA');
  assert.equal(first.timeouts, 1);
  assert.equal(calls, 1);
});

test('limite de usuários interrompe com cursor retomável', async () => {
  const repository = fakeRepository();
  const selected = users([40, 50, 60]);
  const service = new AutomationJobService({
    repository, users: selected, consent: async () => false,
    settings: settings({ maxUsers: 2 }),
  });
  const first = await service.run({ now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(first.status, 'INTERROMPIDA');
  assert.equal(first.reason, 'LIMITE_USUARIOS');
  assert.equal(first.usersEvaluated, 2);
  const second = await service.run({ now: new Date('2026-10-24T12:05:00Z') });
  assert.equal(second.status, 'CONCLUIDA');
  assert.equal(second.usersEvaluated, 3);
  assert.equal(repository.record.cursorUserId, 60);
});

test('controller rejeita segredo inválido e não executa o job quando a flag está desligada', async () => {
  const originalSecret = env.cronSecret;
  const originalEnabled = env.aiAutomationEnabled;
  env.cronSecret = 'offline-cron-secret';
  env.aiAutomationEnabled = false;
  try {
    let called = false;
    const unauthorized = response();
    await AutomationController.process(request('Bearer errado'), unauthorized, async () => { called = true; throw new Error('não deveria'); });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(called, false);

    const disabled = response();
    await AutomationController.process(request('Bearer offline-cron-secret'), disabled, async () => { called = true; throw new Error('não deveria'); });
    assert.equal(disabled.statusCode, 200);
    assert.deepEqual(disabled.body, { enabled: false, processed: false });
    assert.equal(called, false);
  } finally {
    env.cronSecret = originalSecret;
    env.aiAutomationEnabled = originalEnabled;
  }
});
