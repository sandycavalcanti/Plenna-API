import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import {
  MEMORY_ORIGINS,
  MEMORY_STATUS,
} from '../../src/modules/ai/memory.contracts.js';
import {
  MemoryRepositoryConflictError,
} from '../../src/modules/ai/memory.repository.js';
import { PrismaMemoryRepository } from '../../src/modules/ai/prisma-memory.repository.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    ai_anotacao_id: 7,
    usuario_id: 42,
    ai_anotacao_texto: 'Preferência persistida.',
    ai_anotacao_data_criacao: new Date('2026-10-20T00:00:00.000Z'),
    ai_anotacao_origem: MEMORY_ORIGINS.DECLARADA,
    ai_anotacao_status: MEMORY_STATUS.ATIVA,
    ai_anotacao_chave_dedupe: 'memory:v1:key',
    ai_anotacao_evidencia: null,
    ai_anotacao_historico_id: null,
    ai_anotacao_data_expiracao: null,
    ai_anotacao_data_atualizacao: new Date('2026-10-21T00:00:00.000Z'),
    ...overrides,
  };
}

function createMockClient(options: {
  listRows?: unknown[];
  findFirstRows?: unknown[];
  createdRow?: unknown;
  updateCount?: number;
  deleteCount?: number;
  historyRow?: unknown;
  createError?: unknown;
} = {}) {
  const calls = {
    list: [] as unknown[],
    findFirst: [] as unknown[],
    create: [] as unknown[],
    update: [] as unknown[],
    delete: [] as unknown[],
    history: [] as unknown[],
  };
  let findFirstIndex = 0;
  const client = {
    tb_ai_anotacao: {
      findMany: async (args: unknown) => {
        calls.list.push(args);
        return options.listRows ?? [memoryRow()];
      },
      findFirst: async (args: unknown) => {
        calls.findFirst.push(args);
        const row = options.findFirstRows?.[findFirstIndex];
        findFirstIndex += 1;
        return row === undefined ? null : row;
      },
      create: async (args: unknown) => {
        calls.create.push(args);
        if (options.createError) throw options.createError;
        return options.createdRow ?? memoryRow();
      },
      updateMany: async (args: unknown) => {
        calls.update.push(args);
        return { count: options.updateCount ?? 1 };
      },
      deleteMany: async (args: unknown) => {
        calls.delete.push(args);
        return { count: options.deleteCount ?? 1 };
      },
    },
    tb_historico: {
      findFirst: async (args: unknown) => {
        calls.history.push(args);
        return options.historyRow ?? { historico_id: 10 };
      },
    },
  } as unknown as ConstructorParameters<typeof PrismaMemoryRepository>[0];

  return { client, calls };
}

function duplicateError() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.6.0',
  });
}

test('pagina diretamente no Prisma e inclui filtros, ordenação estável e ownership', async () => {
  const { client, calls } = createMockClient();
  const repository = new PrismaMemoryRepository(client);

  const page = await repository.listByUsuario(42, {
    status: MEMORY_STATUS.ATIVA,
    origem: MEMORY_ORIGINS.DECLARADA,
    offset: 10,
    limit: 2,
    agora: NOW,
  });

  const args = calls.list[0] as Record<string, any>;
  assert.equal(page.itens[0]?.usuario_id, 42);
  assert.equal(args.where.usuario_id, 42);
  assert.deepEqual(args.where.AND[1], { ai_anotacao_origem: MEMORY_ORIGINS.DECLARADA });
  assert.equal(args.skip, 10);
  assert.equal(args.take, 3);
  assert.deepEqual(args.orderBy, [
    { ai_anotacao_data_atualizacao: 'desc' },
    { ai_anotacao_data_criacao: 'desc' },
    { ai_anotacao_id: 'desc' },
  ]);

  await repository.findById(42, 7);
  await repository.findByDedupeKey(42, 'memory:v1:key');
  assert.deepEqual((calls.findFirst[0] as any).where, {
    usuario_id: 42,
    ai_anotacao_id: 7,
  });
  assert.deepEqual((calls.findFirst[1] as any).where, {
    usuario_id: 42,
    ai_anotacao_chave_dedupe: 'memory:v1:key',
  });
});

test('limita histórico, atualização e exclusão ao usuário autenticado', async () => {
  const { client, calls } = createMockClient({
    findFirstRows: [memoryRow()],
  });
  const repository = new PrismaMemoryRepository(client);

  assert.equal(await repository.hasHistoricoForUsuario(42, 10), true);
  await repository.update(42, 7, { status: MEMORY_STATUS.INATIVA });
  assert.equal(await repository.delete(42, 7), true);

  assert.deepEqual((calls.history[0] as any).where, {
    usuario_id: 42,
    historico_id: 10,
  });
  assert.deepEqual((calls.update[0] as any).where, {
    usuario_id: 42,
    ai_anotacao_id: 7,
  });
  assert.equal((calls.update[0] as any).data.ai_anotacao_status, MEMORY_STATUS.INATIVA);
  assert.ok((calls.update[0] as any).data.ai_anotacao_data_atualizacao instanceof Date);
  assert.deepEqual((calls.delete[0] as any).where, {
    usuario_id: 42,
    ai_anotacao_id: 7,
  });
});

test('persiste os campos do contrato e traduz registros legados', async () => {
  const { client, calls } = createMockClient({
    createdRow: memoryRow({ ai_anotacao_id: 8 }),
  });
  const repository = new PrismaMemoryRepository(client);
  const created = await repository.create({
    usuario_id: 42,
    conteudo: 'Nova preferência.',
    origem: MEMORY_ORIGINS.DECLARADA,
    evidencia: null,
    chave_dedupe: 'memory:v1:new',
    historico_id: 10,
    data_expiracao: null,
  });

  const createArgs = calls.create[0] as any;
  assert.equal(created.memoria_id, 8);
  assert.deepEqual(createArgs.data, {
    usuario_id: 42,
    ai_anotacao_texto: 'Nova preferência.',
    ai_anotacao_origem: MEMORY_ORIGINS.DECLARADA,
    ai_anotacao_status: MEMORY_STATUS.ATIVA,
    ai_anotacao_chave_dedupe: 'memory:v1:new',
    ai_anotacao_evidencia: null,
    ai_anotacao_historico_id: 10,
    ai_anotacao_data_expiracao: null,
    ai_anotacao_data_atualizacao: createArgs.data.ai_anotacao_data_atualizacao,
  });
  assert.ok(createArgs.data.ai_anotacao_data_atualizacao instanceof Date);

  const legacyRepository = new PrismaMemoryRepository(createMockClient({
    findFirstRows: [memoryRow({
      ai_anotacao_origem: null,
      ai_anotacao_status: null,
      ai_anotacao_chave_dedupe: null,
      ai_anotacao_evidencia: null,
      ai_anotacao_data_atualizacao: null,
    })],
  }).client);
  const legacy = await legacyRepository.findById(42, 7);
  assert.equal(legacy?.origem, MEMORY_ORIGINS.DESCONHECIDA);
  assert.equal(legacy?.status, MEMORY_STATUS.ATIVA);
  assert.equal(legacy?.chave_dedupe, null);
  assert.equal(legacy?.data_atualizacao.getTime(), legacy?.data_criacao.getTime());
});

test('traduz conflito de unicidade em erro controlado', async () => {
  const { client } = createMockClient({ createError: duplicateError() });
  const repository = new PrismaMemoryRepository(client);

  await assert.rejects(
    () => repository.create({
      usuario_id: 42,
      conteudo: 'Conflito.',
      origem: MEMORY_ORIGINS.DECLARADA,
      evidencia: null,
      chave_dedupe: 'memory:v1:conflict',
      historico_id: null,
      data_expiracao: null,
    }),
    (error: unknown) => error instanceof MemoryRepositoryConflictError,
  );
});
