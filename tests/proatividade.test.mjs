import assert from 'node:assert/strict';
import test from 'node:test';

process.env.AI_PROACTIVITY_ENABLED = 'true';

const { ProactiveMessageService } = await import('../.tmp-phase4-compile/src/modules/proatividade/proatividade.text.js');
const { ProactivityService, isQuietHours } = await import('../.tmp-phase4-compile/src/modules/proatividade/proatividade.service.js');
const { PrismaProactivityRepository } = await import('../.tmp-phase4-compile/src/modules/proatividade/proatividade.repository.js');

function candidate(overrides = {}) {
  return {
    id: 10,
    chave: 'recommendation-key',
    tipo: 'ATENCAO_META',
    titulo: 'Acompanhe sua meta',
    texto: 'O progresso conhecido do periodo merece acompanhamento.',
    evidencias: {
      versao: 1,
      periodo: '2026-10',
      referencias: ['meta:3'],
      limitacoes: [],
    },
    recomendacaoHistoricoId: null,
    expiraEm: null,
    ...overrides,
  };
}

function consent(values = {}) {
  return {
    async temConsentimentoAtivo(_userId, code) {
      return values[code] !== false;
    },
  };
}

function repository() {
  const records = new Map();
  let nextId = 1;
  let latest = null;
  return {
    records,
    setLatest(value) { latest = value; },
    async findLatestCreated() { return latest; },
    async findByKey(_userId, key) { return records.get(key) ?? null; },
    async createIfAbsent(input) {
      const existing = records.get(input.key);
      if (existing) return { created: false, record: existing };
      const record = {
        id: nextId++, userId: input.userId, key: input.key, recommendationId: input.recommendationId,
        historyId: 100 + nextId, notificationId: 200 + nextId, status: 'CRIADA', reason: null,
        createdAt: input.createdAt ?? new Date(), updatedAt: input.createdAt ?? new Date(),
      };
      records.set(input.key, record);
      return { created: true, record };
    },
  };
}

function recommendations(items) {
  return { async listEligibleForProactivity() { return items; } };
}

test('redação proativa usa somente fatos e cai para fallback quando há afirmação nova', async () => {
  const facts = {
    tipo: 'ATENCAO_META', titulo: 'Acompanhe sua meta', texto: 'O progresso conhecido do periodo merece acompanhamento.',
    periodo: '2026-10', referencias: ['meta:3'], limitacoes: [],
  };
  const grounded = new ProactiveMessageService({
    async chat() { return JSON.stringify({ titulo: 'Acompanhe sua meta', texto: 'Os dados registrados indicam acompanhar sua meta no periodo.' }); },
  }, { enabled: true });
  assert.equal((await grounded.generate(facts)).fonte, 'IA');

  const invented = new ProactiveMessageService({
    async chat() { return JSON.stringify({ titulo: 'Acompanhe sua meta', texto: 'Sua meta aumentou 999 reais e isso prova ansiedade.' }); },
  }, { enabled: true });
  const fallback = await invented.generate(facts);
  assert.equal(fallback.fonte, 'DETERMINISTICA_FALLBACK');
  assert.doesNotMatch(fallback.texto, /999/);
});

test('redação proativa usa fallback em timeout e sem provider aprovado', async () => {
  const facts = {
    tipo: 'ATENCAO_META', titulo: 'Acompanhe sua meta', texto: 'O progresso conhecido merece acompanhamento.',
    referencias: ['meta:3'], limitacoes: [],
  };
  const timeout = new ProactiveMessageService({
    async chat() { await new Promise((resolve) => setTimeout(resolve, 30)); return '{}'; },
  }, { enabled: true, timeoutMs: 5 });
  assert.equal((await timeout.generate(facts)).fonte, 'DETERMINISTICA_FALLBACK');
  assert.equal((await new ProactiveMessageService().generate(facts)).fonte, 'DETERMINISTICA');
});

test('elegibilidade bloqueia consentimento, horário silencioso, cooldown e evidência insuficiente', async () => {
  const now = new Date('2026-10-24T12:00:00.000Z');
  const base = candidate();
  const noConsent = new ProactivityService({ consent: consent({ IA_PROATIVIDADE: false }), recommendations: recommendations([base]), repository: repository() });
  assert.equal((await noConsent.processUser(1, { now, timezone: 'UTC' })).motivo, 'CONSENTIMENTO_PROATIVIDADE_INATIVO');

  const quiet = new ProactivityService({ consent: consent(), recommendations: recommendations([base]), repository: repository() });
  assert.equal((await quiet.processUser(1, { now: new Date('2026-10-24T22:00:00.000Z'), timezone: 'UTC' })).motivo, 'FORA_HORARIO_SILENCIOSO');

  const cooldownRepo = repository();
  cooldownRepo.setLatest({ status: 'CRIADA' });
  const cooldown = new ProactivityService({ consent: consent(), recommendations: recommendations([base]), repository: cooldownRepo });
  assert.equal((await cooldown.processUser(1, { now, timezone: 'UTC' })).motivo, 'COOLDOWN_ATIVO');

  const noEvidence = new ProactivityService({ consent: consent(), recommendations: recommendations([candidate({ evidencias: { referencias: [] } })]), repository: repository() });
  const noEvidenceResult = await noEvidence.processUser(1, { now, timezone: 'UTC' });
  assert.equal(noEvidenceResult.motivo, 'SEM_RECOMENDACAO_ELEGIVEL');
  assert.equal(noEvidenceResult.estado, 'NENHUMA_ACAO');
});

test('estrutura física desabilitada não inicia uma conversa real', async () => {
  const blocked = new ProactivityService({ enabled: false, consent: consent(), recommendations: recommendations([candidate()]), repository: repository() });
  const result = await blocked.processUser(1, { now: new Date('2026-10-24T12:00:00.000Z'), timezone: 'UTC' });
  assert.equal(result.estado, 'SUPRIMIDA');
  assert.equal(result.motivo, 'ESTRUTURA_INDISPONIVEL');
});

test('criação proativa é idempotente, isola usuários e envia push somente após persistência', async () => {
  const now = new Date('2026-10-24T12:00:00.000Z');
  const sharedRepository = repository();
  const dispatched = [];
  const service = new ProactivityService({
    repository: sharedRepository,
    consent: consent(),
    recommendations: recommendations([candidate()]),
    dispatchPush: async (userId, notifications) => { dispatched.push({ userId, notifications }); },
  });
  const [first, second] = await Promise.all([
    service.processUser(1, { now, timezone: 'UTC' }),
    service.processUser(1, { now, timezone: 'UTC' }),
  ]);
  assert.equal([first.estado, second.estado].sort().join(','), 'CRIADA,EXISTENTE');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].notifications[0].body, 'Você tem uma nova mensagem da Plenna.');

  const other = await new ProactivityService({ consent: consent(), repository: sharedRepository, recommendations: recommendations([candidate({ id: 11, chave: 'other-user-key' })]) }).processUser(2, { now, timezone: 'UTC' });
  assert.equal(other.estado, 'CRIADA');
  assert.notEqual(first.historicoId, other.historicoId);
});

test('horário silencioso noturno cobre a virada do dia', () => {
  assert.equal(isQuietHours(new Date('2026-10-24T22:30:00.000Z'), 'UTC', '21:00', '08:00'), true);
  assert.equal(isQuietHours(new Date('2026-10-24T12:30:00.000Z'), 'UTC', '21:00', '08:00'), false);
});

test('repositório Prisma mantém história, associação e notificação na mesma transação simulada', async () => {
  const control = {
    ai_proatividade_id: 1, usuario_id: 7, ai_proatividade_chave: 'key', ai_proatividade_recomendacao_id: 10,
    ai_proatividade_historico_id: null, ai_proatividade_notificacao_id: null, ai_proatividade_status: 'PROCESSANDO',
    ai_proatividade_motivo: null, ai_proatividade_data_criacao: new Date(), ai_proatividade_data_atualizacao: new Date(),
  };
  const calls = [];
  const tx = {
    async $queryRaw(strings) {
      calls.push(strings[0]);
      if (strings.join('').includes('pg_advisory_xact_lock')) return [];
      return strings.join('').includes('tb_notificacao') ? [{ notificacao_id: 44 }] : [{ ai_proatividade_id: 1 }];
    },
    tb_ai_proatividade: {
      async findUnique() { return control; },
      async findFirst() { return null; },
      async update({ data }) { return { ...control, ...data, ai_proatividade_historico_id: data.ai_proatividade_historico_id ?? null, ai_proatividade_notificacao_id: data.ai_proatividade_notificacao_id ?? null }; },
    },
    tb_ai_recomendacao: {
      async findFirst() { return { ai_recomendacao_id: 10 }; },
      async updateMany() { return { count: 1 }; },
    },
    tb_historico: {
      async create({ data }) { calls.push(data); return { historico_id: 77 }; },
    },
    tb_mensagem: {
      async create({ data }) { calls.push(data); return { mensagem_id: 88 }; },
    },
    tb_notificacao: {
      async findUnique() { return { notificacao_id: 44, usuario_id: 7, notificacao_tipo: 'PROATIVA', notificacao_titulo: 'Nova mensagem da Plenna', notificacao_mensagem: 'Você tem uma nova mensagem da Plenna.', notificacao_historico_id: 77, compra_id: null, categoria_id: null, notificacao_evento: 'PROATIVA', notificacao_lida: 0, notificacao_lida_em: null, notificacao_data_criacao: new Date() }; },
    },
  };
  const db = { async $transaction(callback) { return callback(tx); } };
  const repository = new PrismaProactivityRepository(db);
  const result = await repository.createIfAbsent({ userId: 7, key: 'key', recommendationId: 10, recommendationKey: 'recommendation-key', title: 'Mensagem', message: 'Texto', createdAt: new Date() });
  assert.equal(result.created, true);
  assert.equal(result.record.historyId, 77);
  assert.equal(result.record.notificationId, 44);
  assert.ok(calls.some((call) => typeof call === 'object' && call.historico_origem === 'PROATIVO'));
});

