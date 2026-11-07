import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { MetaMovimentacaoError, MetaMovimentacaoService } from '../../src/modules/meta/meta-movimentacao.service.js';

const operation = '00000000-0000-4000-8000-000000000001';
const otherOperation = '00000000-0000-4000-8000-000000000002';

function clone(value: any) {
  if (value instanceof Prisma.Decimal) return new Prisma.Decimal(value.toString());
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function fakeDatabase(initial: any = {}) {
  const state: any = {
    metas: [{
      meta_id: 1,
      usuario_id: 7,
      meta_titulo: 'Viagem',
      meta_valor: new Prisma.Decimal('100.00'),
      meta_valor_reservado: new Prisma.Decimal('20.00'),
      meta_completado: false,
      ...(initial.meta ?? {}),
    }],
    movements: (initial.movements ?? []).map((movement: any) => ({
      meta_movimentacao_data: new Date('2026-11-01T12:00:00.000Z'),
      ...movement,
      meta_movimentacao_valor: new Prisma.Decimal(movement.meta_movimentacao_valor),
    })),
    nextId: 1,
  };
  state.nextId = Math.max(0, ...state.movements.map((movement: any) => movement.meta_movimentacao_id ?? 0)) + 1;
  const snapshot = () => clone(state);
  const restore = (value: any) => {
    state.metas = value.metas;
    state.movements = value.movements;
    state.nextId = value.nextId;
  };
  const tx: any = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: any[]) => (
      state.metas.some((meta: any) => meta.meta_id === values[0] && meta.usuario_id === values[1])
        ? [{ meta_id: values[0] }]
        : []
    ),
    tb_meta: {
      findUnique: async ({ where }: any) => state.metas.find((meta: any) => meta.meta_id === where.meta_id) ?? null,
      findFirst: async ({ where }: any) => state.metas.find((meta: any) => meta.meta_id === where.meta_id && meta.usuario_id === where.usuario_id) ?? null,
      update: async ({ where, data }: any) => {
        const meta = state.metas.find((item: any) => item.meta_id === where.meta_id);
        if (!meta) throw new Error('META_NAO_ENCONTRADA');
        Object.assign(meta, data);
        return meta;
      },
    },
    tb_meta_movimentacao: {
      findUnique: async ({ where }: any) => {
        const key = where.meta_id_meta_movimentacao_operacao_id;
        return state.movements.find((movement: any) => (
          movement.meta_id === key.meta_id
          && movement.meta_movimentacao_operacao_id === key.meta_movimentacao_operacao_id
        )) ?? null;
      },
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = state.movements.filter((movement: any) => {
          if (where.meta_id?.in) return where.meta_id.in.includes(movement.meta_id);
          if (movement.meta_id !== where.meta_id) return false;
          if (!where.OR) return true;
          return where.OR.some((condition: any) => (
            (
              condition.meta_movimentacao_data?.lt
              && movement.meta_movimentacao_data.getTime() < condition.meta_movimentacao_data.lt.getTime()
            )
            || (
              condition.meta_movimentacao_data instanceof Date
              && movement.meta_movimentacao_data.getTime() === condition.meta_movimentacao_data.getTime()
              && movement.meta_movimentacao_id < condition.meta_movimentacao_id.lt
            )
          ));
        });
        if (where.meta_id && !where.meta_id.in) rows = rows.filter((movement: any) => movement.meta_id === where.meta_id);
        if (orderBy) {
          rows.sort((left: any, right: any) => (
            right.meta_movimentacao_data - left.meta_movimentacao_data
            || right.meta_movimentacao_id - left.meta_movimentacao_id
          ));
        }
        return rows.slice(0, take ?? rows.length);
      },
      create: async ({ data }: any) => {
        if (initial.failCreate) throw new Error('HISTORY_FAILURE');
        const movement = {
          meta_movimentacao_id: state.nextId++,
          meta_movimentacao_data: new Date('2026-11-06T12:00:00.000Z'),
          ...data,
        };
        state.movements.push(movement);
        return movement;
      },
    },
  };
  const database = {
    ...tx,
    $transaction: async (callback: (client: any) => Promise<any>) => {
      const before = snapshot();
      try {
        return await callback(tx);
      } catch (error) {
        restore(before);
        throw error;
      }
    },
  };
  return { database, state };
}

test('depósito atualiza saldo e cria histórico atomicamente', async () => {
  const { database, state } = fakeDatabase();
  const result = await MetaMovimentacaoService.create(7, 1, {
    tipo: 'DEPOSITO',
    valor: '15.25',
    operacao_id: operation,
  }, database);
  assert.equal(result.movimentacao.meta_movimentacao_valor, '15.25');
  assert.equal(result.meta.meta_valor_reservado, '35.25');
  assert.equal(state.movements.length, 1);
});

test('retirada válida usa Decimal e não altera compras', async () => {
  const { database, state } = fakeDatabase();
  const result = await MetaMovimentacaoService.create(7, 1, {
    tipo: 'RETIRADA',
    valor: '7.50',
    operacao_id: operation,
  }, database);
  assert.equal(result.meta.meta_valor_reservado, '12.50');
  assert.equal(Object.hasOwn(state, 'purchases'), false);
});

test('valor zero, negativo e precisão inválida não geram escrita', async () => {
  const { database, state } = fakeDatabase();
  for (const valor of ['0.00', '-1.00', '1.001']) {
    await assert.rejects(
      MetaMovimentacaoService.create(7, 1, { tipo: 'DEPOSITO', valor, operacao_id: operation }, database),
    );
  }
  assert.equal(state.movements.length, 0);
  assert.equal(String(state.metas[0].meta_valor_reservado), '20');
});

test('retirada acima do saldo e overflow fazem rollback', async () => {
  const { database, state } = fakeDatabase();
  await assert.rejects(
    MetaMovimentacaoService.create(7, 1, { tipo: 'RETIRADA', valor: '20.01', operacao_id: operation }, database),
    (error: any) => error instanceof MetaMovimentacaoError && error.code === 'SALDO_INSUFICIENTE',
  );
  assert.equal(String(state.metas[0].meta_valor_reservado), '20');

  state.metas[0].meta_valor_reservado = new Prisma.Decimal('99999999.99');
  await assert.rejects(
    MetaMovimentacaoService.create(7, 1, { tipo: 'DEPOSITO', valor: '0.01', operacao_id: otherOperation }, database),
    (error: any) => error instanceof MetaMovimentacaoError && error.code === 'SALDO_LIMITE_EXCEDIDO',
  );
  assert.equal(String(state.metas[0].meta_valor_reservado), '99999999.99');
});

test('meta de outro usuário é indistinguível de meta inexistente', async () => {
  const { database } = fakeDatabase();
  await assert.rejects(
    MetaMovimentacaoService.create(8, 1, { tipo: 'DEPOSITO', valor: '1.00', operacao_id: operation }, database),
    (error: any) => error instanceof MetaMovimentacaoError && error.code === 'META_NAO_ENCONTRADA',
  );
});

test('replay idêntico retorna a movimentação original sem duplicar', async () => {
  const { database, state } = fakeDatabase();
  const input = { tipo: 'DEPOSITO' as const, valor: '10.00', operacao_id: operation };
  const first = await MetaMovimentacaoService.create(7, 1, input, database);
  const second = await MetaMovimentacaoService.create(7, 1, input, database);
  assert.equal(state.movements.length, 1);
  assert.equal(second.movimentacao.meta_movimentacao_id, first.movimentacao.meta_movimentacao_id);
  assert.equal(second.meta.meta_valor_reservado, '30.00');
});

test('replay com payload diferente retorna conflito sem nova escrita', async () => {
  const { database, state } = fakeDatabase();
  await MetaMovimentacaoService.create(7, 1, {
    tipo: 'DEPOSITO',
    valor: '10.00',
    operacao_id: operation,
  }, database);
  await assert.rejects(
    MetaMovimentacaoService.create(7, 1, {
      tipo: 'RETIRADA',
      valor: '10.00',
      operacao_id: operation,
    }, database),
    (error: any) => error instanceof MetaMovimentacaoError && error.code === 'OPERACAO_REUTILIZADA',
  );
  assert.equal(state.movements.length, 1);
  assert.equal(String(state.metas[0].meta_valor_reservado), '30');
});

test('falha ao registrar histórico desfaz também o saldo', async () => {
  const { database, state } = fakeDatabase({ failCreate: true });
  await assert.rejects(
    MetaMovimentacaoService.create(7, 1, { tipo: 'DEPOSITO', valor: '10.00', operacao_id: operation }, database),
    /HISTORY_FAILURE/,
  );
  assert.equal(String(state.metas[0].meta_valor_reservado), '20');
  assert.equal(state.movements.length, 0);
});

test('histórico é ordenado, paginado e rejeita cursor de outra meta', async () => {
  const { database } = fakeDatabase({
    movements: [
      { meta_movimentacao_id: 1, meta_id: 1, meta_movimentacao_operacao_id: operation, meta_movimentacao_tipo: 'DEPOSITO', meta_movimentacao_valor: '1.00', meta_movimentacao_data: new Date('2026-11-03T12:00:00.000Z') },
      { meta_movimentacao_id: 2, meta_id: 1, meta_movimentacao_operacao_id: otherOperation, meta_movimentacao_tipo: 'RETIRADA', meta_movimentacao_valor: '0.50', meta_movimentacao_data: new Date('2026-11-02T12:00:00.000Z') },
    ],
  });
  const first = await MetaMovimentacaoService.list(7, 1, { limit: 1 }, database);
  assert.equal(first.itens.length, 1);
  assert.equal(first.itens[0].meta_movimentacao_id, 1);
  assert.ok(first.nextCursor);
  const second = await MetaMovimentacaoService.list(7, 1, { limit: 1, cursor: first.nextCursor }, database);
  assert.equal(second.itens[0].meta_movimentacao_id, 2);
  await assert.rejects(
    MetaMovimentacaoService.list(7, 1, {
      limit: 1,
      cursor: Buffer.from(JSON.stringify({
        meta_id: 2,
        data: '2026-11-02T12:00:00.000Z',
        id: 2,
      })).toString('base64url'),
    }, database),
    (error: any) => error instanceof MetaMovimentacaoError && error.code === 'DADOS_INVALIDOS',
  );
});

test('meta sem movimentações e meta acima do objetivo expõem progresso seguro', async () => {
  const { database, state } = fakeDatabase();
  const empty = await MetaMovimentacaoService.enrichMetas(state.metas, database);
  assert.equal(empty[0].meta_valor_reservado, '20.00');
  assert.equal(empty[0].ultima_movimentacao, null);
  state.metas[0].meta_valor_reservado = new Prisma.Decimal('120.00');
  const over = await MetaMovimentacaoService.enrichMetas(state.metas, database);
  assert.equal(over[0].progresso_percentual, 120);
  assert.equal(over[0].valor_restante, '0.00');
});
