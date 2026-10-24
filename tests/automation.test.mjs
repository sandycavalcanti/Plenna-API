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
const { PrismaAutomationExecutionRepository } = await import(`${compiled}automacao/automacao.repository.js`);
const { AutomationController } = await import(`${compiled}automacao/automacao.controller.js`);
const { env } = await import(`${compiled}../lib/env.js`);
const { CONSENTIMENTO_CODIGOS } = await import(`${compiled}consentimento/consentimento.constants.js`);

function fakeRepository() {
  let current = null;
  let nextId = 1;
  let nextLease = 1;
  return {
    get record() { return current; },
    async acquire(key, now) {
      if (!current) {
        current = {
          id: nextId++, key, leaseToken: `lease-${nextLease++}`, status: 'EM_ANDAMENTO',
          cursorUserId: null, cursorAttempts: 0, usersEvaluated: 0,
          recommendationsGenerated: 0, conversationsCreated: 0, actionsSuppressed: 0,
          errors: 0, timeouts: 0, recommendationCalls: 0, proactivityCalls: 0,
          startedAt: now, updatedAt: now, finishedAt: null, reason: null,
        };
        return { acquired: true, record: { ...current } };
      }
      if (current.status === 'CONCLUIDA') return { acquired: false, reason: 'JA_CONCLUIDA', record: { ...current } };
      if (current.status === 'EM_ANDAMENTO') return { acquired: false, reason: 'CONCORRENCIA', record: { ...current } };
      current.status = 'EM_ANDAMENTO';
      current.leaseToken = `lease-${nextLease++}`;
      current.updatedAt = now;
      current.finishedAt = null;
      return { acquired: true, record: { ...current } };
    },
    async progress(id, leaseToken, values, now) {
      assert.equal(id, current.id);
      assert.equal(leaseToken, current.leaseToken);
      Object.assign(current, values, { updatedAt: now });
    },
    async finish(id, leaseToken, status, reason, now) {
      assert.equal(id, current.id);
      assert.equal(leaseToken, current.leaseToken);
      Object.assign(current, { status, reason, updatedAt: now, finishedAt: now });
    },
  };
}

function users(ids) {
  return {
    calls: [],
    async listActive(after, limit, retryUserId = null) {
      this.calls.push({ after, limit, retryUserId });
      return ids.filter((id) => retryUserId !== null ? id >= retryUserId : after === null || id > after).slice(0, limit);
    },
  };
}

function consentMap(values) {
  return async (userId, code) => values[`${userId}:${code}`] === true;
}

function settings(overrides = {}) {
  return {
    enabled: true, batchSize: 2, maxUsers: 20, timeoutMs: 1000, maxErrors: 3,
    maxRecommendationCalls: 20, maxProactivityCalls: 20, maxUserRetries: 2,
    leaseMs: 1000, timezone: 'America/Sao_Paulo', ...overrides,
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

function prismaAutomationTable() {
  const rows = [];
  const calls = [];
  let nextId = 1;
  const clone = (row) => row ? { ...row } : null;
  const byWhere = (where) => rows.find((row) => {
    if (where.ai_automacao_execucao_id !== undefined && row.ai_automacao_execucao_id !== where.ai_automacao_execucao_id) return false;
    if (where.ai_automacao_chave !== undefined && typeof where.ai_automacao_chave === 'string' && row.ai_automacao_chave !== where.ai_automacao_chave) return false;
    if (where.ai_automacao_lease_token !== undefined && row.ai_automacao_lease_token !== where.ai_automacao_lease_token) return false;
    if (where.ai_automacao_status !== undefined) {
      if (typeof where.ai_automacao_status === 'string' && row.ai_automacao_status !== where.ai_automacao_status) return false;
      if (where.ai_automacao_status.in && !where.ai_automacao_status.in.includes(row.ai_automacao_status)) return false;
    }
    if (where.OR) {
      const matchesOr = where.OR.some((condition) => {
        if (condition.ai_automacao_status?.in && !condition.ai_automacao_status.in.includes(row.ai_automacao_status)) return false;
        if (condition.ai_automacao_status && typeof condition.ai_automacao_status === 'string' && row.ai_automacao_status !== condition.ai_automacao_status) return false;
        if (condition.ai_automacao_data_atualizacao?.lte && row.ai_automacao_data_atualizacao > condition.ai_automacao_data_atualizacao.lte) return false;
        return true;
      });
      if (!matchesOr) return false;
    }
    return true;
  });
  return {
    rows,
    calls,
    async findUnique({ where }) { return clone(byWhere(where)); },
    async findFirst() {
      return clone([...rows].sort((a, b) => b.ai_automacao_data_inicio - a.ai_automacao_data_inicio)[0] ?? null);
    },
    async create({ data }) {
      const row = {
        ai_automacao_execucao_id: nextId++,
        ai_automacao_chave: data.ai_automacao_chave,
        ai_automacao_lease_token: data.ai_automacao_lease_token,
        ai_automacao_status: data.ai_automacao_status,
        ai_automacao_cursor_usuario_id: data.ai_automacao_cursor_usuario_id ?? null,
        ai_automacao_cursor_tentativas: data.ai_automacao_cursor_tentativas ?? 0,
        ai_automacao_usuarios_avaliados: 0,
        ai_automacao_recomendacoes_geradas: 0,
        ai_automacao_conversas_criadas: 0,
        ai_automacao_acoes_suprimidas: 0,
        ai_automacao_erros: 0,
        ai_automacao_timeouts: 0,
        ai_automacao_chamadas_recomendacao: 0,
        ai_automacao_chamadas_proatividade: 0,
        ai_automacao_data_inicio: data.ai_automacao_data_atualizacao,
        ai_automacao_data_atualizacao: data.ai_automacao_data_atualizacao,
        ai_automacao_data_fim: null,
        ai_automacao_motivo: null,
      };
      rows.push(row);
      return clone(row);
    },
    async updateMany({ where, data }) {
      calls.push({ where, data });
      const row = byWhere(where);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };
}

test('primeira aquisição cria e adquire; concorrência, retomada, lease e conclusão são protegidos', async () => {
  const table = prismaAutomationTable();
  const repository = new PrismaAutomationExecutionRepository({ tb_ai_automacao_execucao: table });
  const now = new Date('2026-10-24T12:00:00Z');
  const first = await repository.acquire('rf026-rf027:2026-10-24', now, 1000);
  assert.equal(first.acquired, true);
  assert.equal(table.calls.length, 0, 'criação não deve exigir updateMany adicional');

  const concurrent = await repository.acquire('rf026-rf027:2026-10-24', new Date(now.getTime() + 10), 1000);
  assert.equal(concurrent.acquired, false);
  assert.equal(concurrent.reason, 'CONCORRENCIA');

  await repository.finish(first.record.id, first.record.leaseToken, 'INTERROMPIDA', 'REPROCESSAR_USUARIO', new Date(now.getTime() + 20));
  const resumed = await repository.acquire('rf026-rf027:2026-10-24', new Date(now.getTime() + 30), 1000);
  assert.equal(resumed.acquired, true);
  assert.notEqual(resumed.record.leaseToken, first.record.leaseToken);
  await assert.rejects(
    repository.finish(first.record.id, first.record.leaseToken, 'CONCLUIDA', 'worker antigo', new Date(now.getTime() + 40)),
    /Automação indisponível/,
  );

  await repository.finish(resumed.record.id, resumed.record.leaseToken, 'CONCLUIDA', 'SEM_USUARIOS_PENDENTES', new Date(now.getTime() + 50));
  const repeated = await repository.acquire('rf026-rf027:2026-10-24', new Date(now.getTime() + 60), 1000);
  assert.equal(repeated.acquired, false);
  assert.equal(repeated.reason, 'JA_CONCLUIDA');

  const leaseOwner = await repository.acquire('rf026-rf027:2026-10-25', new Date(now.getTime() + 70), 1000);
  const takeover = await repository.acquire('rf026-rf027:2026-10-25', new Date(now.getTime() + 2070), 1000);
  assert.equal(leaseOwner.acquired, true);
  assert.equal(takeover.acquired, true);
  assert.notEqual(takeover.record.leaseToken, leaseOwner.record.leaseToken);
  await assert.rejects(repository.progress(leaseOwner.record.id, leaseOwner.record.leaseToken, {}, new Date()), /Automação indisponível/);
});

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

test('falha e timeout mantêm usuário pendente, sem retry automático na mesma execução', async () => {
  const repository = fakeRepository();
  const selected = users([10, 20]);
  let recommendationCalls = 0;
  const dependencies = {
    repository, users: selected, consent: async () => true,
    recommendations: async () => { recommendationCalls += 1; throw new Error('consulta falhou'); },
    settings: settings({ maxErrors: 1 }),
  };
  const first = await new AutomationJobService(dependencies).run({ now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(first.status, 'INTERROMPIDA');
  assert.equal(first.reason, 'REPROCESSAR_USUARIO');
  assert.equal(repository.record.cursorUserId, 10);
  assert.equal(repository.record.cursorAttempts, 1);

  dependencies.recommendations = async () => { recommendationCalls += 1; return { itens: [] }; };
  const second = await new AutomationJobService(dependencies).run({ now: new Date('2026-10-24T12:05:00Z') });
  assert.equal(second.status, 'CONCLUIDA');
  assert.equal(repository.record.cursorUserId, 20);
  assert.equal(recommendationCalls, 3);

  const timeoutRepo = fakeRepository();
  const timeoutService = new AutomationJobService({
    repository: timeoutRepo, users: users([30]), consent: async () => true,
    recommendations: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { itens: [] }; },
    settings: settings({ timeoutMs: 5 }),
  });
  const timeout = await timeoutService.run({ now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(timeout.status, 'INTERROMPIDA');
  assert.equal(timeout.reason, 'TIMEOUT_USUARIO');
  assert.equal(timeoutRepo.record.cursorAttempts, 1);
});

test('limite de usuários é retomável e limite de chamadas persiste no checkpoint', async () => {
  const repository = fakeRepository();
  const selected = users([40, 50, 60]);
  const service = new AutomationJobService({
    repository, users: selected, consent: async () => false,
    settings: settings({ maxUsers: 2 }),
  });
  const first = await service.run({ now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(first.status, 'INTERROMPIDA');
  assert.equal(first.reason, 'LIMITE_USUARIOS');
  const second = await service.run({ now: new Date('2026-10-24T12:05:00Z') });
  assert.equal(second.status, 'CONCLUIDA');
  assert.equal(repository.record.cursorUserId, 60);

  const callRepo = fakeRepository();
  const callService = () => new AutomationJobService({
    repository: callRepo, users: users([70, 80]), consent: async () => true,
    recommendations: async () => ({ itens: [] }),
    settings: settings({ maxRecommendationCalls: 1 }),
  });
  const callFirst = await callService().run({ now: new Date('2026-10-26T12:00:00Z') });
  assert.equal(callFirst.status, 'INTERROMPIDA');
  assert.equal(callFirst.reason, 'LIMITE_CHAMADAS_RECOMENDACAO');
  assert.equal(callRepo.record.recommendationCalls, 1);
  const callSecond = await callService().run({ now: new Date('2026-10-26T12:05:00Z') });
  assert.equal(callSecond.status, 'INTERROMPIDA');
  assert.equal(callSecond.reason, 'LIMITE_CHAMADAS_RECOMENDACAO');
  assert.equal(callRepo.record.cursorUserId, 70);
});

test('controller rejeita segredo inválido, respeita flag e aceita execução autenticada', async () => {
  const originalSecret = env.cronSecret;
  const originalEnabled = env.aiAutomationEnabled;
  env.cronSecret = 'offline-cron-secret';
  try {
    let called = false;
    env.aiAutomationEnabled = false;
    const unauthorized = response();
    await AutomationController.process(request('Bearer errado'), unauthorized, async () => { called = true; throw new Error('não deveria'); });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(called, false);

    const disabled = response();
    await AutomationController.process(request('Bearer offline-cron-secret'), disabled, async () => { called = true; throw new Error('não deveria'); });
    assert.equal(disabled.statusCode, 200);
    assert.deepEqual(disabled.body, { enabled: false, processed: false });

    env.aiAutomationEnabled = true;
    const enabled = response();
    await AutomationController.process(request('Bearer offline-cron-secret'), enabled, async () => ({
      status: 'CONCLUIDA', reason: 'offline', executionId: 4, usersEvaluated: 1,
      recommendationsGenerated: 1, conversationsCreated: 1, actionsSuppressed: 0,
      errors: 0, timeouts: 0, recommendationCalls: 1, proactivityCalls: 1,
    }));
    assert.equal(enabled.statusCode, 200);
    assert.equal(enabled.body.executionId, 4);
  } finally {
    env.cronSecret = originalSecret;
    env.aiAutomationEnabled = originalEnabled;
  }
});
