import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { MetaService } from '../../src/modules/meta/meta.service.js';

function fakeDatabase() {
  const state: any = {
    meta: {
      meta_id: 10,
      usuario_id: 7,
      meta_titulo: 'Jaqueta',
      meta_valor: new Prisma.Decimal('400.00'),
      meta_valor_reservado: new Prisma.Decimal('250.00'),
      meta_completado: false,
      meta_data_conclusao: null,
    },
  };

  const database: any = {
    tb_meta: {
      findFirst: async ({ where }: any) => state.meta.meta_id === where.meta_id && state.meta.usuario_id === where.usuario_id
        ? state.meta
        : null,
      update: async ({ data }: any) => {
        Object.assign(state.meta, data);
        return state.meta;
      },
      create: async ({ data }: any) => ({
        meta_id: 11,
        meta_data_criacao: new Date('2026-11-08T12:00:00.000Z'),
        meta_valor_reservado: new Prisma.Decimal('0.00'),
        meta_completado: false,
        meta_data_conclusao: null,
        ...data,
      }),
    },
  };

  return { database, state };
}

test('conclusão explícita preserva saldo, não cria movimentação e é idempotente', async () => {
  const { database, state } = fakeDatabase();
  const first = await MetaService.checkMeta(7, { meta_id: 10, completado: true }, database);
  const completionDate = first.meta_data_conclusao;

  assert.equal(first.meta_completado, true);
  assert.equal(String(first.meta_valor_reservado), '250');
  assert.ok(completionDate instanceof Date);
  assert.equal(Object.hasOwn(database, 'tb_meta_movimentacao'), false);

  const replay = await MetaService.checkMeta(7, { meta_id: 10, completado: true }, database);
  assert.equal(replay.meta_data_conclusao, completionDate);
  assert.equal(String(state.meta.meta_valor_reservado), '250');
});

test('reabertura limpa a conclusão atual e uma nova conclusão recebe nova data', async () => {
  const { database, state } = fakeDatabase();
  await MetaService.checkMeta(7, { meta_id: 10, completado: true }, database);
  const firstDate = state.meta.meta_data_conclusao;

  await MetaService.checkMeta(7, { meta_id: 10, completado: false }, database);
  assert.equal(state.meta.meta_completado, false);
  assert.equal(state.meta.meta_data_conclusao, null);
  assert.equal(String(state.meta.meta_valor_reservado), '250');

  await MetaService.checkMeta(7, { meta_id: 10, completado: true }, database);
  assert.equal(state.meta.meta_completado, true);
  assert.ok(state.meta.meta_data_conclusao instanceof Date);
  assert.notEqual(state.meta.meta_data_conclusao, firstDate);
  assert.equal(String(state.meta.meta_valor_reservado), '250');
});

test('criação inicia meta ativa sem data de conclusão e sem histórico auxiliar', async () => {
  const { database } = fakeDatabase();
  const created = await MetaService.create(7, {
    titulo: 'Viagem',
    descricao: '',
    valor: '1250.50',
  }, database);

  assert.equal(created.meta_id, 11);
  assert.equal(created.meta_completado, false);
  assert.equal(created.meta_data_conclusao, null);
  assert.deepEqual(Object.keys(database), ['tb_meta']);
});
