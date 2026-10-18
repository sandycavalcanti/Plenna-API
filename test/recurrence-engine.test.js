import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.DIRECT_URL = 'postgresql://localhost:1/recurrence_engine_offline';
process.env.DATABASE_URL = process.env.DIRECT_URL;

const runtimeClient = { $disconnect: async () => {} };
globalThis.prismaRuntime = { client: runtimeClient, pool: { end: async () => {} } };

const distRoot = process.env.PLENNA_TEST_DIST
  ? resolve(process.env.PLENNA_TEST_DIST)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const compiled = (relativePath) => pathToFileURL(resolve(distRoot, relativePath)).href;

const { disconnectPrisma } = await import(compiled('src/lib/prisma.js'));
const { RecorrenciaEngine } = await import(compiled('src/modules/recorrencia/recorrencia.engine.js'));
const { formatDateOnly } = await import(compiled('src/modules/recorrencia/recorrencia.calendar.js'));

const date = (value) => new Date(`${value}T00:00:00.000Z`);

function recurrence(overrides = {}) {
  return {
    compra_recorrencia_id: 10,
    usuario_id: 7,
    forma_pagamento_id: 3,
    compra_recorrencia_fonte: 'Contrato',
    compra_recorrencia_frequencia: 'DIARIA',
    compra_recorrencia_status: 'ATIVA',
    compra_recorrencia_primeira_ocorrencia: date('2026-10-20'),
    compra_recorrencia_proxima_ocorrencia: date('2026-10-20'),
    compra_recorrencia_data_final: null,
    compra_recorrencia_fuso_horario: 'America/Sao_Paulo',
    compra_recorrencia_data_criacao: new Date('2026-10-19T15:00:00.000Z'),
    ...overrides,
  };
}

function createDatabase(recurrences = [recurrence()], templates = []) {
  const state = {
    recurrences: new Map(recurrences.map((row) => [row.compra_recorrencia_id, { ...row }])),
    templates: new Map(recurrences.map((row) => [
      row.compra_recorrencia_id,
      (templates.length > 0 ? templates : [
        {
          compra_item_id: 1,
          categoria_id: 2,
          compra_item_nome: 'Internet',
          compra_item_valor: 10,
          compra_item_quantidade: 1,
          compra_item_unidade_medida: null,
        },
      ]).map((item) => ({ ...item })),
    ])),
    purchases: [],
    purchaseItems: [],
    nextPurchaseId: 100,
    locked: new Set(),
    rawQueries: [],
    transactionOptions: [],
  };

  const snapshot = () => ({
    recurrences: new Map([...state.recurrences].map(([id, row]) => [id, { ...row }])),
    purchases: state.purchases.map((row) => ({ ...row })),
    purchaseItems: state.purchaseItems.map((row) => ({ ...row })),
    nextPurchaseId: state.nextPurchaseId,
  });
  const restore = (saved) => {
    state.recurrences = saved.recurrences;
    state.purchases = saved.purchases;
    state.purchaseItems = saved.purchaseItems;
  };

  const rawQuery = async (strings, ...values) => {
    const sql = strings.join('?');
    state.rawQueries.push(sql);
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      const recurrenceId = values[0];
      const runDate = values[1];
      if (state.locked.has(recurrenceId)) return [];
      const row = state.recurrences.get(recurrenceId);
      if (!row || row.compra_recorrencia_status !== 'ATIVA'
        || !row.compra_recorrencia_proxima_ocorrencia
        || row.compra_recorrencia_proxima_ocorrencia > runDate) return [];
      state.locked.add(recurrenceId);
      return [{ ...row }];
    }

    const runDate = values[0];
    const limit = values[1];
    return [...state.recurrences.values()]
      .filter((row) => row.compra_recorrencia_status === 'ATIVA'
        && row.compra_recorrencia_proxima_ocorrencia
        && row.compra_recorrencia_proxima_ocorrencia <= runDate)
      .sort((left, right) => left.compra_recorrencia_id - right.compra_recorrencia_id)
      .slice(0, limit)
      .map((row) => ({ compra_recorrencia_id: row.compra_recorrencia_id }));
  };

  const database = {
    $queryRaw: rawQuery,
    $transaction: async (callback, options) => {
      state.transactionOptions.push(options);
      const saved = snapshot();
      let lockedId = null;
      const tx = {
        $queryRaw: async (strings, ...values) => {
          const result = await rawQuery(strings, ...values);
          if (strings.join('?').includes('FOR UPDATE SKIP LOCKED') && result.length > 0) {
            lockedId = result[0].compra_recorrencia_id;
          }
          return result;
        },
        tb_compra: {
          findFirst: async ({ where }) => state.purchases.find((purchase) => (
            purchase.compra_recorrencia_id === where.compra_recorrencia_id
            && formatDateOnly(purchase.compra_recorrencia_data_prevista)
              === formatDateOnly(where.compra_recorrencia_data_prevista)
          )) ?? null,
          create: async ({ data }) => {
            const duplicate = state.purchases.find((purchase) => (
              purchase.compra_recorrencia_id === data.compra_recorrencia_id
              && formatDateOnly(purchase.compra_recorrencia_data_prevista)
                === formatDateOnly(data.compra_recorrencia_data_prevista)
            ));
            if (duplicate) throw new Error('uq_compra_recorrencia_data_prevista');
            const purchase = { compra_id: state.nextPurchaseId++, ...data };
            state.purchases.push(purchase);
            return purchase;
          },
        },
        tb_compra_item: {
          findMany: async ({ where }) => (state.templates.get(where.compra_recorrencia_id) ?? [])
            .filter((item) => item.compra_id === undefined || item.compra_id === null)
            .filter(() => where.compra_item_ativo === 1)
            .map((item) => ({ ...item })),
          createMany: async ({ data }) => {
            state.purchaseItems.push(...data);
            return { count: data.length };
          },
        },
        tb_compra_recorrencia: {
          updateMany: async ({ where, data }) => {
            const row = state.recurrences.get(where.compra_recorrencia_id);
            if (!row || row.compra_recorrencia_status !== where.compra_recorrencia_status
              || formatDateOnly(row.compra_recorrencia_proxima_ocorrencia)
                !== formatDateOnly(where.compra_recorrencia_proxima_ocorrencia)) {
              return { count: 0 };
            }
            Object.assign(row, data);
            return { count: 1 };
          },
        },
      };

      try {
        return await callback(tx);
      } catch (error) {
        restore(saved);
        throw error;
      } finally {
        if (lockedId !== null) state.locked.delete(lockedId);
      }
    },
    state,
  };

  return database;
}

const noOpFinancialEffects = {
  evaluateLimits: async () => ({ alerts: [] }),
  recalculateMetrics: async () => null,
  dispatchPush: async () => null,
};

after(disconnectPrisma);

test('não processa antes da data e gera a primeira ocorrência escolhida com múltiplos itens', async () => {
  const database = createDatabase([recurrence()], [
    { compra_item_id: 1, categoria_id: 2, compra_item_nome: 'Plano', compra_item_valor: 10, compra_item_quantidade: 2, compra_item_unidade_medida: 'un' },
    { compra_item_id: 2, categoria_id: 3, compra_item_nome: 'Taxa', compra_item_valor: 5.5, compra_item_quantidade: 1, compra_item_unidade_medida: null },
  ]);

  const before = await RecorrenciaEngine.processDue({ ...noOpFinancialEffects, db: database, now: date('2026-10-19') });
  assert.equal(before.geradas, 0);
  assert.equal(database.state.purchases.length, 0);

  const result = await RecorrenciaEngine.processDue({ ...noOpFinancialEffects, db: database, now: date('2026-10-20') });
  assert.equal(result.geradas, 1);
  assert.equal(database.state.purchases.length, 1);
  assert.equal(Number(database.state.purchases[0].compra_valor), 25.5);
  assert.equal(database.state.purchases[0].compra_status, 'CONFIRMADA');
  assert.equal(database.state.purchases[0].compra_classificacao, 'PENDENTE');
  assert.equal(database.state.purchases[0].compra_email, false);
  assert.equal(formatDateOnly(database.state.purchases[0].compra_recorrencia_data_prevista), '2026-10-20');
  assert.equal(database.state.purchases[0].compra_horario.toISOString(), '2026-10-20T03:00:00.000Z');
  assert.equal(database.state.purchaseItems.length, 2);
  assert.equal(database.state.purchaseItems[0].compra_recorrencia_id, null);
  assert.equal(database.state.recurrences.get(10).compra_recorrencia_proxima_ocorrencia.toISOString(), '2026-10-21T00:00:00.000Z');
});

test('calcula próxima data para as quatro frequências e respeita término inclusivo', async () => {
  const rows = [
    recurrence({ compra_recorrencia_id: 11, compra_recorrencia_frequencia: 'DIARIA', compra_recorrencia_primeira_ocorrencia: date('2026-10-20'), compra_recorrencia_proxima_ocorrencia: date('2026-10-20'), compra_recorrencia_data_final: date('2026-10-20') }),
    recurrence({ compra_recorrencia_id: 12, compra_recorrencia_frequencia: 'SEMANAL', compra_recorrencia_primeira_ocorrencia: date('2026-10-20'), compra_recorrencia_proxima_ocorrencia: date('2026-10-20'), compra_recorrencia_data_final: date('2026-10-20') }),
    recurrence({ compra_recorrencia_id: 13, compra_recorrencia_frequencia: 'MENSAL', compra_recorrencia_primeira_ocorrencia: date('2026-01-31'), compra_recorrencia_proxima_ocorrencia: date('2026-01-31'), compra_recorrencia_data_final: date('2026-01-31'), compra_recorrencia_data_criacao: new Date('2026-01-01T12:00:00.000Z') }),
    recurrence({ compra_recorrencia_id: 14, compra_recorrencia_frequencia: 'ANUAL', compra_recorrencia_primeira_ocorrencia: date('2028-02-29'), compra_recorrencia_proxima_ocorrencia: date('2028-02-29'), compra_recorrencia_data_final: date('2028-02-29'), compra_recorrencia_data_criacao: new Date('2028-01-01T12:00:00.000Z') }),
    recurrence({ compra_recorrencia_id: 15, compra_recorrencia_primeira_ocorrencia: date('2026-10-20'), compra_recorrencia_proxima_ocorrencia: date('2026-10-21'), compra_recorrencia_data_final: date('2026-10-20') }),
  ];
  const database = createDatabase(rows);
  const result = await RecorrenciaEngine.processDue({ ...noOpFinancialEffects, db: database, now: date('2099-12-31'), batchSize: 10, maxOccurrences: 10 });

  assert.equal(result.geradas, 4);
  assert.equal(result.ignoradas, 0);
  assert.equal(database.state.recurrences.get(11).compra_recorrencia_status, 'FINALIZADA');
  assert.equal(database.state.recurrences.get(11).compra_recorrencia_proxima_ocorrencia, null);
  assert.equal(database.state.recurrences.get(12).compra_recorrencia_status, 'FINALIZADA');
  assert.equal(database.state.recurrences.get(12).compra_recorrencia_proxima_ocorrencia, null);
  assert.equal(database.state.recurrences.get(13).compra_recorrencia_status, 'FINALIZADA');
  assert.equal(database.state.recurrences.get(13).compra_recorrencia_proxima_ocorrencia, null);
  assert.equal(database.state.recurrences.get(14).compra_recorrencia_status, 'FINALIZADA');
  assert.equal(database.state.recurrences.get(14).compra_recorrencia_proxima_ocorrencia, null);
  assert.equal(database.state.recurrences.get(15).compra_recorrencia_status, 'FINALIZADA');
  assert.equal(database.state.purchases.some((purchase) => purchase.compra_recorrencia_id === 15), false);
});

test('preserva vencimentos atrasados, não processa pausadas/canceladas e não faz backfill anterior à criação', async () => {
  const rows = [
    recurrence({ compra_recorrencia_id: 21, compra_recorrencia_primeira_ocorrencia: date('2026-10-18'), compra_recorrencia_proxima_ocorrencia: date('2026-10-18'), compra_recorrencia_data_criacao: new Date('2026-10-17T12:00:00.000Z') }),
    recurrence({ compra_recorrencia_id: 22, compra_recorrencia_status: 'PAUSADA' }),
    recurrence({ compra_recorrencia_id: 23, compra_recorrencia_status: 'CANCELADA' }),
    recurrence({ compra_recorrencia_id: 24, compra_recorrencia_primeira_ocorrencia: date('2026-10-01'), compra_recorrencia_proxima_ocorrencia: date('2026-10-01'), compra_recorrencia_data_final: date('2026-10-09'), compra_recorrencia_data_criacao: new Date('2026-10-10T12:00:00.000Z') }),
  ];
  const database = createDatabase(rows);
  const result = await RecorrenciaEngine.processDue({ ...noOpFinancialEffects, db: database, now: date('2026-10-20'), batchSize: 10, maxOccurrences: 10 });

  assert.equal(result.geradas, 3);
  assert.equal(result.ignoradas, 0);
  assert.equal(formatDateOnly(database.state.recurrences.get(21).compra_recorrencia_proxima_ocorrencia), '2026-10-21');
  assert.equal(database.state.purchases.some((purchase) => purchase.compra_recorrencia_id === 22), false);
  assert.equal(database.state.purchases.some((purchase) => purchase.compra_recorrencia_id === 23), false);
  assert.equal(database.state.purchases.some((purchase) => purchase.compra_recorrencia_id === 24), false);
  assert.equal(database.state.recurrences.get(24).compra_recorrencia_status, 'FINALIZADA');
});

test('reexecução da mesma data é idempotente e compra excluída logicamente continua bloqueando duplicidade', async () => {
  const database = createDatabase([recurrence({ compra_recorrencia_data_final: date('2026-10-20') })]);
  const first = await RecorrenciaEngine.processDue({ ...noOpFinancialEffects, db: database, now: date('2026-10-20') });
  assert.equal(first.geradas, 1);

  const stored = database.state.purchases[0];
  stored.compra_ativo = 0;
  const row = database.state.recurrences.get(10);
  Object.assign(row, {
    compra_recorrencia_status: 'ATIVA',
    compra_recorrencia_proxima_ocorrencia: date('2026-10-20'),
  });

  const second = await RecorrenciaEngine.processDue({ ...noOpFinancialEffects, db: database, now: date('2026-10-20') });
  assert.equal(second.jaExistentes, 1);
  assert.equal(database.state.purchases.length, 1);
});

test('falha financeira faz rollback da compra, dos itens e do avanço da recorrência', async () => {
  const database = createDatabase();
  const result = await RecorrenciaEngine.processDue({
    db: database,
    batchSize: 10,
    maxOccurrences: 1,
    now: date('2026-10-20'),
    evaluateLimits: async () => { throw new Error('falha controlada'); },
    recalculateMetrics: async () => null,
    dispatchPush: async () => null,
  });

  assert.equal(result.falhas, 1);
  assert.deepEqual(result.falhasRecorrenciaIds, [10]);
  assert.equal(database.state.purchases.length, 0);
  assert.equal(database.state.purchaseItems.length, 0);
  assert.equal(formatDateOnly(database.state.recurrences.get(10).compra_recorrencia_proxima_ocorrencia), '2026-10-20');
});

test('falha de uma recorrência não desfaz outra e efeitos financeiros são chamados após a compra', async () => {
  const database = createDatabase([
    recurrence({ compra_recorrencia_id: 31 }),
    recurrence({ compra_recorrencia_id: 32, usuario_id: 8 }),
  ]);
  const evaluatedPurchaseIds = [];
  const metricCalls = [];
  const pushCalls = [];
  const result = await RecorrenciaEngine.processDue({
    db: database,
    batchSize: 10,
    maxOccurrences: 1,
    now: date('2026-10-20'),
    evaluateLimits: async (purchaseId) => {
      evaluatedPurchaseIds.push(purchaseId);
      if (purchaseId === 100) throw new Error('falha controlada na primeira recorrência');
      return { alerts: [{ created: true, notificationId: 55, type: 'LIMITE_COMPRA' }] };
    },
    recalculateMetrics: async (userId, referenceDate) => {
      metricCalls.push({ userId, referenceDate: referenceDate.toISOString() });
      return null;
    },
    dispatchPush: async (userId, notifications) => {
      pushCalls.push({ userId, notifications });
    },
  });

  assert.equal(result.falhas, 1);
  assert.equal(result.geradas, 1);
  assert.deepEqual(evaluatedPurchaseIds, [100, 101]);
  assert.deepEqual(metricCalls, [{ userId: 8, referenceDate: '2026-10-20T03:00:00.000Z' }]);
  assert.deepEqual(pushCalls, [{ userId: 8, notifications: [{ notificationId: 55, type: 'LIMITE_COMPRA' }] }]);
  assert.equal(database.state.purchases.length, 1);
  assert.equal(database.state.purchases[0].usuario_id, 8);
});

test('duas execuções simultâneas usam lock transacional e apenas uma gera a compra', async () => {
  const database = createDatabase();
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let evaluations = 0;
  const effects = {
    evaluateLimits: async () => {
      evaluations += 1;
      entered();
      await gate;
      return { alerts: [] };
    },
    recalculateMetrics: async () => null,
    dispatchPush: async () => null,
  };

  const first = RecorrenciaEngine.processDue({ ...effects, db: database, now: date('2026-10-20') });
  await started;
  const second = RecorrenciaEngine.processDue({ ...noOpFinancialEffects, db: database, now: date('2026-10-20') });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(evaluations, 1);
  assert.equal(database.state.purchases.length, 1);
  assert.equal(firstResult.geradas + secondResult.geradas, 1);
  assert.equal(firstResult.ignoradas + secondResult.ignoradas, 1);
  assert.ok(database.state.rawQueries.some((query) => query.includes('FOR UPDATE SKIP LOCKED')));
});

test('recupera backlog com limite global e preserva timeout configurado acima de 1000 ms', async () => {
  const database = createDatabase([
    recurrence({
      compra_recorrencia_id: 41,
      compra_recorrencia_primeira_ocorrencia: date('2026-10-18'),
      compra_recorrencia_proxima_ocorrencia: date('2026-10-18'),
      compra_recorrencia_data_criacao: new Date('2026-10-17T12:00:00.000Z'),
    }),
  ]);

  const result = await RecorrenciaEngine.processDue({
    ...noOpFinancialEffects,
    db: database,
    now: date('2026-10-20'),
    batchSize: 10,
    maxOccurrences: 2,
    transactionTimeoutMs: 5000,
  });

  assert.equal(result.geradas, 2);
  assert.equal(database.state.purchases.length, 2);
  assert.equal(formatDateOnly(database.state.recurrences.get(41).compra_recorrencia_proxima_ocorrencia), '2026-10-20');
  assert.equal(database.state.transactionOptions[0].timeout, 5000);
});

