import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMORY_ORIGINS,
  MEMORY_STATUS,
  MemoryPolicyError,
  type MemoryRecord,
  type MemorySavePersistence,
} from '../../src/modules/ai/memory.contracts.js';
import type {
  MemoryRepository,
  MemoryRepositoryListQuery,
  MemoryRepositoryUpdate,
} from '../../src/modules/ai/memory.repository.js';
import { MemoryService } from '../../src/modules/ai/memory.service.js';
import { AutomaticMemoryService } from '../../src/modules/ai/memory.automatic.js';
import { hasExplicitMemoryWriteIntent } from '../../src/modules/chat/chat.service.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');

class FakeMemoryRepository implements MemoryRepository {
  private nextId = 1;
  private readonly memories = new Map<number, MemoryRecord>();

  async listByUsuario(usuarioId: number, query: MemoryRepositoryListQuery) {
    const records = [...this.memories.values()]
      .filter((memory) => memory.usuario_id === usuarioId)
      .filter((memory) => query.status === MEMORY_STATUS.ATIVA
        ? memory.status === MEMORY_STATUS.ATIVA
        : memory.status === query.status)
      .filter((memory) => memory.data_expiracao === null || memory.data_expiracao > query.agora)
      .sort((left, right) => right.memoria_id - left.memoria_id);
    const page = records.slice(query.offset, query.offset + query.limit + 1);
    return {
      itens: page.slice(0, query.limit),
      proximo_cursor: page.length > query.limit ? String(query.offset + query.limit) : null,
    };
  }

  async findById(usuarioId: number, memoriaId: number) {
    const memory = this.memories.get(memoriaId);
    return memory?.usuario_id === usuarioId ? structuredClone(memory) : null;
  }

  async findByDedupeKey(usuarioId: number, chaveDedupe: string) {
    const memory = [...this.memories.values()].find((item) => item.usuario_id === usuarioId && item.chave_dedupe === chaveDedupe);
    return memory ? structuredClone(memory) : null;
  }

  async hasHistoricoForUsuario(_usuarioId: number, _historicoId: number) {
    return true;
  }

  async create(data: MemorySavePersistence) {
    const now = new Date(NOW);
    const record: MemoryRecord = {
      memoria_id: this.nextId++,
      usuario_id: data.usuario_id,
      conteudo: data.conteudo,
      origem: data.origem,
      status: MEMORY_STATUS.ATIVA,
      chave_dedupe: data.chave_dedupe,
      evidencia: data.evidencia,
      historico_id: data.historico_id,
      data_expiracao: data.data_expiracao,
      data_criacao: now,
      data_atualizacao: now,
    };
    this.memories.set(record.memoria_id, record);
    return structuredClone(record);
  }

  async update(usuarioId: number, memoriaId: number, data: MemoryRepositoryUpdate) {
    const current = await this.findById(usuarioId, memoriaId);
    if (!current) return null;
    const updated = { ...current, ...data, data_atualizacao: new Date(NOW) };
    this.memories.set(memoriaId, updated);
    return structuredClone(updated);
  }

  async delete(usuarioId: number, memoriaId: number) {
    const current = await this.findById(usuarioId, memoriaId);
    return current ? this.memories.delete(memoriaId) : false;
  }

  count() {
    return this.memories.size;
  }
}

function authorization(active = true) {
  return {
    usuario_id: 7,
    consentimento_memoria_ativo: active,
    pode_ler: active,
    pode_escrever: active,
    pode_excluir: true,
  };
}

function providerFor(decision: unknown, calls: { count: number }) {
  return {
    async chat() {
      calls.count += 1;
      return JSON.stringify(decision);
    },
  };
}

test('reconhece pedidos naturais explícitos sem confundir recuperação com gravação', () => {
  assert.equal(hasExplicitMemoryWriteIntent('Plenna, registre na minha memória que prefiro alertas curtos.'), true);
  assert.equal(hasExplicitMemoryWriteIntent('Você pode guardar isso para mim?'), true);
  assert.equal(hasExplicitMemoryWriteIntent('Lembre disso nas próximas conversas.'), true);
  assert.equal(hasExplicitMemoryWriteIntent('Quero que você memorize que estou juntando dinheiro.'), true);
  assert.equal(hasExplicitMemoryWriteIntent('Anote essa preferência, por favor.'), true);
  assert.equal(hasExplicitMemoryWriteIntent('Você lembra do que conversamos?'), false);
  assert.equal(hasExplicitMemoryWriteIntent('Não memorize isso.'), false);
});

test('não chama provider nem grava sem IA_MEMORIA ativo', async () => {
  const repository = new FakeMemoryRepository();
  const calls = { count: 0 };
  const service = new AutomaticMemoryService(
    new MemoryService(repository, { now: () => NOW }),
    async () => authorization(false),
    { enabled: true },
  );

  const result = await service.consider({
    usuario_id: 7,
    historico_id: 11,
    mensagem: 'Sempre prefiro receber orientações curtas.',
    provider: providerFor({ salvar: true, conteudo: 'Prefere orientações curtas.', origem: 'DECLARADA' }, calls),
  });

  assert.equal(result.status, 'CONSENTIMENTO_INATIVO');
  assert.equal(calls.count, 0);
  assert.equal(repository.count(), 0);
});

test('salva uma memória declarada elegível pelo caminho automático controlado', async () => {
  const repository = new FakeMemoryRepository();
  const calls = { count: 0 };
  const service = new AutomaticMemoryService(
    new MemoryService(repository, { now: () => NOW }),
    async () => authorization(),
    { enabled: true, maxContextChars: 600, timeoutMs: 100 },
  );

  const result = await service.consider({
    usuario_id: 7,
    historico_id: 11,
    mensagem: 'Sempre prefiro receber orientações curtas e práticas.',
    provider: providerFor({
      salvar: true,
      conteudo: 'Prefere orientações curtas e práticas.',
      origem: 'DECLARADA',
      evidencia: 'Preferência declarada na mensagem atual.',
    }, calls),
  });

  assert.equal(result.status, 'SALVA');
  assert.equal(calls.count, 1);
  assert.equal(repository.count(), 1);
  if (result.status === 'SALVA') {
    assert.equal(result.memoria.origem, MEMORY_ORIGINS.DECLARADA);
    assert.equal(result.memoria.historico_id, 11);
  }
});

test('não persiste comentário irrelevante, opt-out ou pedido explícito delegado', async () => {
  const repository = new FakeMemoryRepository();
  const calls = { count: 0 };
  const service = new AutomaticMemoryService(
    new MemoryService(repository, { now: () => NOW }),
    async () => authorization(),
    { enabled: true },
  );

  const irrelevantProvider = providerFor({ salvar: false }, calls);
  assert.equal((await service.consider({ usuario_id: 7, historico_id: 11, mensagem: 'Oi, tudo bem?', provider: irrelevantProvider })).status, 'SEM_CANDIDATO');
  assert.equal((await service.consider({ usuario_id: 7, historico_id: 11, mensagem: 'Não memorize isso.', provider: irrelevantProvider })).status, 'OPTOUT');
  assert.equal((await service.consider({ usuario_id: 7, historico_id: 11, mensagem: 'Registre na minha memória que gosto de resumos.', provider: irrelevantProvider, explicitWriteIntent: true })).status, 'EXPLICITA_DELEGADA');
  assert.equal(calls.count, 1);
  assert.equal(repository.count(), 0);
});

test('falha ou timeout do avaliador não grava memória nem interrompe o contrato', async () => {
  const repository = new FakeMemoryRepository();
  const service = new AutomaticMemoryService(
    new MemoryService(repository, { now: () => NOW }),
    async () => authorization(),
    { enabled: true, timeoutMs: 5 },
  );

  const failed = await service.consider({
    usuario_id: 7,
    historico_id: 11,
    mensagem: 'Tenho uma preferência duradoura por orientações curtas.',
    provider: { async chat() { throw new Error('provider indisponível'); } },
  });
  assert.deepEqual(failed, { status: 'FALHA', motivo: 'PROVIDER' });

  const timedOut = await service.consider({
    usuario_id: 7,
    historico_id: 11,
    mensagem: 'Tenho uma preferência duradoura por orientações curtas.',
    provider: { async chat() { await new Promise((resolve) => setTimeout(resolve, 25)); return '{}'; } },
  });
  assert.deepEqual(timedOut, { status: 'FALHA', motivo: 'TIMEOUT' });
  assert.equal(repository.count(), 0);
});

test('exige evidência para inferências e não armazena conteúdo sensível', async () => {
  const repository = new FakeMemoryRepository();
  const calls = { count: 0 };
  const service = new AutomaticMemoryService(
    new MemoryService(repository, { now: () => NOW }),
    async () => authorization(),
    { enabled: true },
  );

  const noEvidence = await service.consider({
    usuario_id: 7,
    historico_id: 11,
    mensagem: 'Talvez eu precise de acompanhamento.',
    provider: providerFor({ salvar: true, conteudo: 'Precisa de acompanhamento.', origem: 'INFERIDA' }, calls),
  });
  assert.equal(noEvidence.status, 'RESPOSTA_INVALIDA');

  const sensitive = await service.consider({
    usuario_id: 7,
    historico_id: 11,
    mensagem: 'Minha senha é temporária.',
    provider: providerFor({ salvar: true, conteudo: 'A senha é temporária.', origem: 'DECLARADA' }, calls),
  });
  assert.equal(sensitive.status, 'IGNORADA');
  assert.equal(calls.count, 1);
  assert.equal(repository.count(), 0);
});

test('revalida consentimento durante análise e deduplica entre históricos', async () => {
  const repository = new FakeMemoryRepository();
  let authorizationCalls = 0;
  const service = new AutomaticMemoryService(
    new MemoryService(repository, { now: () => NOW }),
    async () => {
      authorizationCalls += 1;
      return authorization(authorizationCalls < 2);
    },
    { enabled: true },
  );
  const decision = { salvar: true, conteudo: 'Prefere orientações curtas.', origem: 'DECLARADA' };

  const revoked = await service.consider({
    usuario_id: 7,
    historico_id: 11,
    mensagem: 'Prefiro orientações curtas.',
    provider: providerFor(decision, { count: 0 }),
  });
  assert.equal(revoked.status, 'CONSENTIMENTO_REVOGADO_DURANTE_ANALISE');
  assert.equal(repository.count(), 0);

  const activeService = new AutomaticMemoryService(
    new MemoryService(repository, { now: () => NOW }),
    async () => authorization(true),
    { enabled: true },
  );
  const first = await activeService.consider({ usuario_id: 7, historico_id: 11, mensagem: 'Prefiro orientações curtas.', provider: providerFor(decision, { count: 0 }) });
  const second = await activeService.consider({
    usuario_id: 7,
    historico_id: 22,
    mensagem: 'Prefiro orientacoes curtas.',
    provider: providerFor({ ...decision, conteudo: 'prefere orientacoes curtas' }, { count: 0 }),
  });
  assert.equal(first.status, 'SALVA');
  assert.equal(second.status, 'DUPLICADA');
  assert.equal(repository.count(), 1);
});

test('saveAutomatic não aceita contexto sem autorização automática do backend', async () => {
  const service = new MemoryService(new FakeMemoryRepository(), { now: () => NOW });
  await assert.rejects(
    () => service.saveAutomatic(authorization(), {
      conteudo: 'Preferência válida.',
      origem: MEMORY_ORIGINS.DECLARADA,
    }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'MEMORY_OPERATION_FORBIDDEN',
  );
});
