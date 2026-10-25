import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

let sqlAttempts = 0;
const blocked = () => {
  sqlAttempts++;
  throw Error('RF018_OFFLINE_SQL_BLOCKED');
};
const adapter = {
  provider: 'postgres',
  adapterName: 'rf018-offline-validation',
  connect: async () => ({
    provider: 'postgres',
    adapterName: 'rf018-offline-validation',
    queryRaw: blocked,
    executeRaw: blocked,
    startTransaction: blocked,
    dispose: async () => {},
    getConnectionInfo: () => ({ supportsRelationJoins: false }),
  }),
};
const client = new PrismaClient({ adapter });
const base = {
  compra_id: 1,
  usuario_id: 1,
  revisao: 1,
  versao_schema: 1,
  operacao_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  requisicao_hash: 'a'.repeat(64),
  respostas: { planejamento: 'PARCIALMENTE' },
};
test.after(() => client.$disconnect());
test('real generated Prisma client rejects redundant compra_id inside a nested item before any SQL', async () => {
  sqlAttempts = 0;
  await assert.rejects(
    client.tb_rf018_contexto_revisao.create({
      data: {
        ...base,
        itens: {
          create: [{ compra_id: 1, compra_item_id: 10, planejamento: 'SIM' }],
        },
      },
    }),
    (error) => {
      assert.equal(error.name, 'PrismaClientValidationError');
      assert.match(error.message, /Unknown argument `compra_id`/);
      return true;
    },
  );
  assert.equal(sqlAttempts, 0);
});
test('nested item without parent-owned keys passes real Prisma argument validation, with SQL still blocked', async () => {
  sqlAttempts = 0;
  await assert.rejects(
    client.tb_rf018_contexto_revisao.create({
      data: {
        ...base,
        itens: { create: [{ compra_item_id: 10, planejamento: 'SIM' }] },
      },
    }),
    /RF018_OFFLINE_SQL_BLOCKED/,
  );
  assert.ok(sqlAttempts > 0);
});
