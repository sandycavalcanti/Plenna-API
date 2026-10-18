import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

process.env.DIRECT_URL = 'postgresql://localhost:1/recurrence_crud_offline';
process.env.DATABASE_URL = process.env.DIRECT_URL;

const delegateNames = [
  'tb_compra_recorrencia',
  'tb_compra_item',
  'tb_compra',
  'tb_usuario',
  'tb_categoria',
  'tb_forma_pagamento',
];
const methods = ['findFirst', 'findUnique', 'findMany', 'count', 'create', 'createMany', 'update', 'updateMany'];
const client = Object.fromEntries(delegateNames.map((name) => [
  name,
  Object.fromEntries(methods.map((method) => [
    method,
    async () => { throw new Error(`Consulta não simulada: ${name}.${method}`); },
  ])),
]));
client.$transaction = async (callback) => callback(client);
client.$disconnect = async () => {};
globalThis.prismaRuntime = { client, pool: { end: async () => {} } };

const distRoot = process.env.PLENNA_TEST_DIST
  ? resolve(process.env.PLENNA_TEST_DIST)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const compiled = (relativePath) => pathToFileURL(resolve(distRoot, relativePath)).href;

const { prisma, disconnectPrisma } = await import(compiled('src/lib/prisma.js'));
const { RecorrenciaService } = await import(compiled('src/modules/recorrencia/recorrencia.service.js'));
const { buildUpcomingOccurrences, formatDateOnly } = await import(compiled('src/modules/recorrencia/recorrencia.calendar.js'));
const { createRecurrenceSchema } = await import(compiled('src/modules/recorrencia/recorrencia.schemas.js'));

const recurrenceRecord = (overrides = {}) => ({
  compra_recorrencia_id: 10,
  usuario_id: 7,
  forma_pagamento_id: 3,
  compra_recorrencia_fonte: 'Contrato',
  compra_recorrencia_frequencia: 'MENSAL',
  compra_recorrencia_status: 'ATIVA',
  compra_recorrencia_primeira_ocorrencia: new Date('2026-01-31T00:00:00.000Z'),
  compra_recorrencia_proxima_ocorrencia: new Date('2026-01-31T00:00:00.000Z'),
  compra_recorrencia_data_final: null,
  compra_recorrencia_fuso_horario: 'America/Sao_Paulo',
  compra_recorrencia_data_criacao: new Date('2026-01-01T00:00:00.000Z'),
  compra_recorrencia_data_modificacao: new Date('2026-01-01T00:00:00.000Z'),
  tb_forma_pagamento: { forma_pagamento_id: 3, forma_pagamento_nome: 'Pix' },
  tb_compra_item: [{
    compra_item_id: 1,
    compra_id: null,
    compra_recorrencia_id: 10,
    categoria_id: 1,
    compra_item_nome: 'Internet',
    compra_item_valor: 99.9,
    compra_item_ativo: 1,
  }],
  ...overrides,
});

beforeEach(() => {
  for (const delegateName of delegateNames) {
    const delegate = prisma[delegateName];
    for (const method of methods) {
      mock.method(delegate, method, async () => {
        throw new Error(`Consulta não simulada: ${delegateName}.${method}`);
      });
    }
  }
  mock.method(prisma, '$transaction', async (callback) => callback(prisma));
});

afterEach(() => mock.restoreAll());
after(disconnectPrisma);

test('cria recorrência com múltiplos itens sem criar compra efetiva', async () => {
  let recurrenceData;
  let itemData;
  const created = recurrenceRecord({ tb_compra_item: [] });

  mock.method(prisma.tb_usuario, 'findFirst', async () => ({ usuario_id: 7 }));
  mock.method(prisma.tb_categoria, 'count', async () => 2);
  mock.method(prisma.tb_forma_pagamento, 'findUnique', async () => ({ forma_pagamento_id: 3 }));
  mock.method(prisma.tb_compra_recorrencia, 'create', async ({ data }) => {
    recurrenceData = data;
    return created;
  });
  mock.method(prisma.tb_compra_item, 'createMany', async ({ data }) => {
    itemData = data;
    return { count: data.length };
  });
  mock.method(prisma.tb_compra_recorrencia, 'findFirst', async () => ({
    ...created,
    tb_compra_item: [
      { compra_item_id: 1, categoria_id: 1, compra_item_nome: 'Internet', compra_item_valor: 99.9 },
      { compra_item_id: 2, categoria_id: 2, compra_item_nome: 'Seguro', compra_item_valor: 40 },
    ],
  }));

  const result = await RecorrenciaService.create(7, {
    formaPagamentoId: 3,
    compraFonte: 'Contrato',
    frequencia: 'MENSAL',
    primeiraOcorrencia: '2026-01-31',
    dataFinal: null,
    items: [
      { categoriaId: 1, nome: 'Internet', valor: 99.9 },
      { categoriaId: 2, nome: 'Seguro', valor: 40 },
    ],
  });

  assert.equal(result.id, 10);
  assert.equal(result.itens.length, 2);
  assert.equal(recurrenceData.compra_recorrencia_status, 'ATIVA');
  assert.equal(recurrenceData.compra_recorrencia_fuso_horario, 'America/Sao_Paulo');
  assert.equal(recurrenceData.forma_pagamento_id, 3);
  assert.equal(recurrenceData.compra_recorrencia_fonte, 'Contrato');
  assert.equal(itemData.length, 2);
  assert.equal(itemData[0].compra_id, null);
  assert.equal(itemData[0].compra_recorrencia_id, 10);
  assert.equal(prisma.tb_compra.create.mock.callCount(), 0);
});

test('calendário preserva âncora mensal e aplica 29 de fevereiro anual', () => {
  const monthly = buildUpcomingOccurrences('MENSAL', '2026-01-31', null, 4)
    .map(formatDateOnly);
  assert.deepEqual(monthly, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);

  const annual = buildUpcomingOccurrences('ANUAL', '2028-02-29', null, 4)
    .map(formatDateOnly);
  assert.deepEqual(annual, ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28']);

  const weekly = buildUpcomingOccurrences('SEMANAL', '2026-10-05', null, 2)
    .map(formatDateOnly);
  assert.deepEqual(weekly, ['2026-10-05', '2026-10-12']);

  const bounded = buildUpcomingOccurrences('DIARIA', '2026-10-10', '2026-10-10', 5)
    .map(formatDateOnly);
  assert.deepEqual(bounded, ['2026-10-10']);
});

test('pausar limpa a próxima ocorrência e cancelar preserva a configuração', async () => {
  const record = recurrenceRecord();
  let updateData;
  mock.method(prisma.tb_compra_recorrencia, 'findFirst', async () => record);
  mock.method(prisma.tb_compra_recorrencia, 'update', async ({ data }) => {
    updateData = data;
    return { ...record, ...data };
  });

  const paused = await RecorrenciaService.pause(7, 10);
  assert.equal(paused.status, 'PAUSADA');
  assert.equal(updateData.compra_recorrencia_proxima_ocorrencia, null);

  mock.restoreAll();
  mock.method(prisma, '$transaction', async (callback) => callback(prisma));
  mock.method(prisma.tb_compra_recorrencia, 'findFirst', async () => ({ ...record, compra_recorrencia_status: 'PAUSADA' }));
  mock.method(prisma.tb_compra_recorrencia, 'update', async ({ data }) => ({
    ...record,
    ...data,
    compra_recorrencia_status: 'CANCELADA',
  }));
  const cancelled = await RecorrenciaService.cancel(7, 10);
  assert.equal(cancelled.status, 'CANCELADA');
  assert.equal(cancelled.proximaOcorrencia, null);
});

test('listagem usa ownership e preview não retorna datas após o término', async () => {
  let where;
  mock.method(prisma.tb_compra_recorrencia, 'findMany', async (args) => {
    where = args.where;
    return [recurrenceRecord({
      compra_recorrencia_data_final: new Date('2026-02-28T00:00:00.000Z'),
    })];
  });
  const records = await RecorrenciaService.findAll(7, 'ATIVA');
  assert.equal(where.usuario_id, 7);
  assert.equal(where.compra_recorrencia_status, 'ATIVA');
  assert.equal(records.length, 1);

  mock.method(prisma.tb_compra_recorrencia, 'findFirst', async () => recurrenceRecord({
    compra_recorrencia_data_final: new Date('2026-02-28T00:00:00.000Z'),
  }));
  const preview = await RecorrenciaService.upcoming(7, 10, 5);
  assert.deepEqual(preview.ocorrencias.map((item) => item.dataPrevista), ['2026-01-31', '2026-02-28']);
});

test('retomada calcula uma próxima data sem recuperar ocorrências pausadas', async () => {
  const record = recurrenceRecord({
    compra_recorrencia_status: 'PAUSADA',
    compra_recorrencia_primeira_ocorrencia: new Date('2099-01-31T00:00:00.000Z'),
    compra_recorrencia_proxima_ocorrencia: null,
  });
  let updateData;
  mock.method(prisma.tb_compra_recorrencia, 'findFirst', async () => record);
  mock.method(prisma.tb_compra_recorrencia, 'update', async ({ data }) => {
    updateData = data;
    return { ...record, ...data };
  });

  const resumed = await RecorrenciaService.resume(7, 10);
  assert.equal(resumed.status, 'ATIVA');
  assert.equal(formatDateOnly(updateData.compra_recorrencia_proxima_ocorrencia), '2099-01-31');
});

test('edição substitui somente os itens-modelo e não atualiza compras reais', async () => {
  const record = recurrenceRecord({ compra_recorrencia_primeira_ocorrencia: new Date('2099-01-31T00:00:00.000Z') });
  let templateUpdate;
  let templateCreate;
  let recurrenceUpdate;
  mock.method(prisma.tb_compra_recorrencia, 'findFirst', async () => record);
  mock.method(prisma.tb_categoria, 'count', async () => 1);
  mock.method(prisma.tb_forma_pagamento, 'findUnique', async () => ({ forma_pagamento_id: 3 }));
  mock.method(prisma.tb_compra_item, 'updateMany', async ({ data }) => {
    templateUpdate = data;
    return { count: 1 };
  });
  mock.method(prisma.tb_compra_item, 'createMany', async ({ data }) => {
    templateCreate = data;
    return { count: data.length };
  });
  mock.method(prisma.tb_compra_recorrencia, 'update', async ({ data }) => {
    recurrenceUpdate = data;
    return {
      ...record,
      ...data,
      tb_compra_item: [{
        compra_item_id: 2,
        categoria_id: 1,
        compra_item_nome: 'Novo item',
        compra_item_valor: 20,
      }],
    };
  });

  const result = await RecorrenciaService.update(7, 10, {
    compraFonte: 'Novo contrato',
    items: [{ categoriaId: 1, nome: 'Novo item', valor: 20 }],
  });
  assert.equal(result.itens[0].nome, 'Novo item');
  assert.equal(templateUpdate.compra_item_ativo, 0);
  assert.equal(templateCreate[0].compra_id, null);
  assert.equal(recurrenceUpdate.compra_recorrencia_fonte, 'Novo contrato');
  assert.equal(recurrenceUpdate.compra_fonte, undefined);
  assert.equal(prisma.tb_compra.update.mock.callCount(), 0);
});

test('falha ao salvar item-modelo é propagada pela transação sem criar compra', async () => {
  mock.method(prisma.tb_usuario, 'findFirst', async () => ({ usuario_id: 7 }));
  mock.method(prisma.tb_categoria, 'count', async () => 1);
  mock.method(prisma.tb_forma_pagamento, 'findUnique', async () => ({ forma_pagamento_id: 3 }));
  mock.method(prisma.tb_compra_recorrencia, 'create', async () => recurrenceRecord());
  mock.method(prisma.tb_compra_item, 'createMany', async () => {
    throw new Error('falha caracterizada no item-modelo');
  });

  await assert.rejects(
    () => RecorrenciaService.create(7, {
      formaPagamentoId: 3,
      frequencia: 'DIARIA',
      primeiraOcorrencia: '2026-10-20',
      items: [{ categoriaId: 1, nome: 'Item', valor: 10 }],
    }),
    /falha caracterizada no item-modelo/,
  );
  assert.equal(prisma.tb_compra.create.mock.callCount(), 0);
});

test('schema rejeita data final anterior à primeira ocorrência', () => {
  assert.throws(() => createRecurrenceSchema.parse({
    frequencia: 'DIARIA',
    primeiraOcorrencia: '2026-10-20',
    items: [{ categoriaId: 1, nome: 'Item', valor: 10 }],
  }));

  assert.throws(() => createRecurrenceSchema.parse({
    frequencia: 'DIARIA',
    primeiraOcorrencia: '2026-10-20',
    dataFinal: '2026-10-19',
    items: [{ categoriaId: 1, nome: 'Item', valor: 10 }],
  }));

  assert.throws(() => createRecurrenceSchema.parse({
    frequencia: 'DIARIA',
    primeiraOcorrencia: '2026-02-30',
    items: [{ categoriaId: 1, nome: 'Item', valor: 10 }],
  }));
});
