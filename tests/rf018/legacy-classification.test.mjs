import test from 'node:test';
import assert from 'node:assert/strict';

const { registrarClassificacao } = await import('../../src/modules/compra/eventos.ledger.ts');

function fakeTransaction(table = 'tb_compra_evento') {
  const rawSql = [];
  let created = null;
  const tx = {
    $queryRaw: async (strings) => {
      rawSql.push(strings.join(''));
      return rawSql.length === 1 ? [{ tabela: table }] : [];
    },
    tb_compra_evento: {
      findFirst: async () => ({ revisao: 3 }),
      create: async ({ data }) => {
        created = data;
        return data;
      },
    },
  };
  return { tx, rawSql, get created() { return created; } };
}

test('purchase classification is audited with a locked revision', async () => {
  const fake = fakeTransaction();
  await registrarClassificacao(fake.tx, 7, 11, 'IMPULSIVA');
  assert.equal(fake.created.revisao, 4);
  assert.equal(fake.created.tipo, 'CLASSIFICACAO');
  assert.deepEqual(fake.created.dados, { classificacao: 'IMPULSIVA' });
  assert.match(fake.rawSql[0], /FOR UPDATE/);
});

test('explicitly opting out is persisted as a classification event', async () => {
  const pending = fakeTransaction();
  await registrarClassificacao(pending.tx, 7, 11, 'PENDENTE', true);
  assert.equal(pending.created.tipo, 'CLASSIFICACAO');
  assert.deepEqual(pending.created.dados, { classificacao: 'PREFIRO_NAO_CLASSIFICAR' });
});
