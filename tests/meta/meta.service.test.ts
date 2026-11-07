import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { MetaService } from '../../src/modules/meta/meta.service.js';

function fakeDatabase() {
  const metas = [{
    meta_id: 2,
    usuario_id: 1,
    meta_titulo: 'Cadeira Gamer',
    meta_descricao: '',
    meta_valor: new Prisma.Decimal('500.00'),
    meta_valor_reservado: new Prisma.Decimal('0.00'),
    meta_completado: false,
  }];
  const database: any = {
    tb_meta: {
      create: async ({ data }: any) => {
        const created = { meta_id: 3, meta_valor_reservado: new Prisma.Decimal('0.00'), meta_completado: false, ...data };
        metas.push(created);
        return created;
      },
      findMany: async ({ where }: any) => metas.filter((meta) => meta.usuario_id === where.usuario_id),
      findFirst: async ({ where }: any) => metas.find((meta) => meta.meta_id === where.meta_id && meta.usuario_id === where.usuario_id) ?? null,
      update: async ({ where, data }: any) => {
        const meta = metas.find((item) => item.meta_id === where.meta_id);
        if (!meta) throw new Error('META_NAO_ENCONTRADA');
        Object.assign(meta, data);
        return meta;
      },
      delete: async ({ where }: any) => {
        const index = metas.findIndex((meta) => meta.meta_id === where.meta_id);
        if (index >= 0) metas.splice(index, 1);
      },
    },
  };
  return { database, metas };
}

test('CRUD de metas persiste reais e limita operações ao proprietário', async () => {
  const { database, metas } = fakeDatabase();
  const created = await MetaService.create(1, {
    titulo: 'Viagem', descricao: '', valor: '1250.50',
  }, database);
  assert.equal(created.meta_valor.toString(), '1250.5');

  const listed = await MetaService.findAllByUserId(1, {}, database);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].usuario_id, 1);

  const updated = await MetaService.update(1, 2, { titulo: 'Cadeira', valor: '500.00' }, database);
  assert.equal(updated.meta_titulo, 'Cadeira');
  assert.equal(updated.meta_valor.toString(), '500');
  assert.equal(Object.hasOwn(updated, 'meta_descricao'), true);

  const checked = await MetaService.checkMeta(1, { meta_id: 2, completado: true }, database);
  assert.equal(checked.meta_completado, true);
  await assert.rejects(() => MetaService.update(2, 2, { valor: '900.00' }, database), /Meta não encontrada/);

  await MetaService.delete(1, 3, database);
  assert.equal(metas.some((meta) => meta.meta_id === 3), false);
});
