import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { MetaHistoricoService } from '../../src/modules/meta/meta-historico.service.js';

function date(value: string) {
  return new Date(value);
}

function fakeDatabase() {
  const metas = [
    {
      meta_id: 1,
      usuario_id: 7,
      meta_titulo: 'Cadeira Gamer',
      meta_descricao: '',
      meta_valor: new Prisma.Decimal('500.00'),
      meta_valor_reservado: new Prisma.Decimal('400.00'),
      meta_completado: false,
      meta_data_conclusao: null,
      meta_data_criacao: date('2026-08-10T12:00:00.000Z'),
    },
    {
      meta_id: 2,
      usuario_id: 7,
      meta_titulo: 'Jaqueta',
      meta_descricao: '',
      meta_valor: new Prisma.Decimal('400.00'),
      meta_valor_reservado: new Prisma.Decimal('250.00'),
      meta_completado: true,
      meta_data_conclusao: date('2026-10-15T12:00:00.000Z'),
      meta_data_criacao: date('2026-08-05T12:00:00.000Z'),
    },
    {
      meta_id: 3,
      usuario_id: 7,
      meta_titulo: 'Livro',
      meta_descricao: '',
      meta_valor: new Prisma.Decimal('100.00'),
      meta_valor_reservado: new Prisma.Decimal('0.00'),
      meta_completado: false,
      meta_data_conclusao: null,
      meta_data_criacao: date('2026-09-02T12:00:00.000Z'),
    },
    {
      meta_id: 4,
      usuario_id: 7,
      meta_titulo: 'Legada',
      meta_descricao: '',
      meta_valor: new Prisma.Decimal('300.00'),
      meta_valor_reservado: new Prisma.Decimal('100.00'),
      meta_completado: true,
      meta_data_conclusao: null,
      meta_data_criacao: date('2026-07-01T12:00:00.000Z'),
    },
    {
      meta_id: 5,
      usuario_id: 8,
      meta_titulo: 'Privada',
      meta_descricao: '',
      meta_valor: new Prisma.Decimal('100.00'),
      meta_valor_reservado: new Prisma.Decimal('100.00'),
      meta_completado: false,
      meta_data_conclusao: null,
      meta_data_criacao: date('2026-08-01T12:00:00.000Z'),
    },
    {
      meta_id: 6,
      usuario_id: 7,
      meta_titulo: 'Meta em 100%',
      meta_descricao: '',
      meta_valor: new Prisma.Decimal('100.00'),
      meta_valor_reservado: new Prisma.Decimal('100.00'),
      meta_completado: false,
      meta_data_conclusao: null,
      meta_data_criacao: date('2026-08-01T12:00:00.000Z'),
    },
    {
      meta_id: 7,
      usuario_id: 7,
      meta_titulo: 'Meta acima do objetivo',
      meta_descricao: '',
      meta_valor: new Prisma.Decimal('100.00'),
      meta_valor_reservado: new Prisma.Decimal('120.00'),
      meta_completado: false,
      meta_data_conclusao: null,
      meta_data_criacao: date('2026-08-01T12:00:00.000Z'),
    },
    {
      meta_id: 8,
      usuario_id: 7,
      meta_titulo: 'Meta reaberta',
      meta_descricao: '',
      meta_valor: new Prisma.Decimal('200.00'),
      meta_valor_reservado: new Prisma.Decimal('50.00'),
      meta_completado: false,
      meta_data_conclusao: null,
      meta_data_criacao: date('2026-07-01T12:00:00.000Z'),
    },
  ];

  const movements = [
    { meta_movimentacao_id: 1, meta_id: 1, meta_movimentacao_tipo: 'DEPOSITO', meta_movimentacao_valor: new Prisma.Decimal('100.00'), meta_movimentacao_data: date('2026-08-20T12:00:00.000Z') },
    { meta_movimentacao_id: 2, meta_id: 1, meta_movimentacao_tipo: 'DEPOSITO', meta_movimentacao_valor: new Prisma.Decimal('150.00'), meta_movimentacao_data: date('2026-09-05T12:00:00.000Z') },
    { meta_movimentacao_id: 3, meta_id: 1, meta_movimentacao_tipo: 'RETIRADA', meta_movimentacao_valor: new Prisma.Decimal('50.00'), meta_movimentacao_data: date('2026-10-10T12:00:00.000Z') },
    { meta_movimentacao_id: 4, meta_id: 1, meta_movimentacao_tipo: 'DEPOSITO', meta_movimentacao_valor: new Prisma.Decimal('200.00'), meta_movimentacao_data: date('2026-11-05T12:00:00.000Z') },
    { meta_movimentacao_id: 5, meta_id: 2, meta_movimentacao_tipo: 'DEPOSITO', meta_movimentacao_valor: new Prisma.Decimal('250.00'), meta_movimentacao_data: date('2026-09-20T12:00:00.000Z') },
    { meta_movimentacao_id: 6, meta_id: 6, meta_movimentacao_tipo: 'DEPOSITO', meta_movimentacao_valor: new Prisma.Decimal('100.00'), meta_movimentacao_data: date('2026-08-20T12:00:00.000Z') },
    { meta_movimentacao_id: 7, meta_id: 7, meta_movimentacao_tipo: 'DEPOSITO', meta_movimentacao_valor: new Prisma.Decimal('120.00'), meta_movimentacao_data: date('2026-08-20T12:00:00.000Z') },
    { meta_movimentacao_id: 8, meta_id: 8, meta_movimentacao_tipo: 'DEPOSITO', meta_movimentacao_valor: new Prisma.Decimal('50.00'), meta_movimentacao_data: date('2026-07-20T12:00:00.000Z') },
  ];

  const database: any = {
    tb_meta: {
      findMany: async ({ where }: any) => metas.filter((meta) => meta.usuario_id === where.usuario_id && meta.meta_data_criacao < where.meta_data_criacao.lt),
    },
    tb_meta_movimentacao: {
      findMany: async ({ where }: any) => movements.filter((movement) => (
        where.meta_id.in.includes(movement.meta_id)
        && (!where.meta_movimentacao_data || movement.meta_movimentacao_data < where.meta_movimentacao_data.lt)
      )),
    },
  };
  return { database, metas };
}

function meta(response: any, id: number) {
  return response.metas.find((item: any) => item.meta_id === id);
}

test('reconstrói saldo acumulado por depósitos e retiradas usando o objetivo atual', async () => {
  const { database } = fakeDatabase();
  const now = date('2026-11-15T12:00:00.000Z');
  const august = await MetaHistoricoService.findByMonth(7, '2026-08', database, now);
  const september = await MetaHistoricoService.findByMonth(7, '2026-09', database, now);
  const october = await MetaHistoricoService.findByMonth(7, '2026-10', database, now);
  const november = await MetaHistoricoService.findByMonth(7, '2026-11', database, now);

  assert.deepEqual(
    [meta(august, 1).meta_valor_reservado, meta(september, 1).meta_valor_reservado, meta(october, 1).meta_valor_reservado, meta(november, 1).meta_valor_reservado],
    ['100.00', '250.00', '200.00', '400.00'],
  );
  assert.deepEqual(
    [meta(august, 1).progresso_percentual, meta(september, 1).progresso_percentual, meta(october, 1).progresso_percentual, meta(november, 1).progresso_percentual],
    [20, 50, 40, 80],
  );
  assert.deepEqual([meta(august, 1).meta_valor, meta(october, 1).meta_valor], ['500.00', '500.00']);
  assert.equal(Object.hasOwn(meta(august, 1), 'objetivo_historico_disponivel'), false);
  assert.equal(meta(august, 6).meta_completado, false);
  assert.equal(meta(august, 6).progresso_percentual, 100);
  assert.equal(meta(august, 7).progresso_percentual, 120);
});

test('usa somente a conclusão atualmente válida e omite a meta após o mês concluído', async () => {
  const { database } = fakeDatabase();
  const now = date('2026-11-15T12:00:00.000Z');
  const september = await MetaHistoricoService.findByMonth(7, '2026-09', database, now);
  const october = await MetaHistoricoService.findByMonth(7, '2026-10', database, now);
  const november = await MetaHistoricoService.findByMonth(7, '2026-11', database, now);

  assert.equal(meta(september, 2).meta_completado, false);
  assert.equal(meta(october, 2).meta_completado, true);
  assert.equal(meta(october, 2).meta_data_conclusao, '2026-10-15T12:00:00.000Z');
  assert.equal(meta(november, 2), undefined);
});

test('não exibe metas futuras, isola o usuário, preserva reabertura e sinaliza conclusão legada', async () => {
  const { database } = fakeDatabase();
  const august = await MetaHistoricoService.findByMonth(7, '2026-08', database, date('2026-11-15T12:00:00.000Z'));

  assert.equal(meta(august, 3), undefined);
  assert.equal(meta(august, 5), undefined);
  assert.equal(meta(august, 4), undefined);
  assert.equal(meta(august, 8).meta_completado, false);
  assert.equal(august.limitacoes.some((message: string) => message.includes('legadas')), true);
});

test('rejeita consulta a mês futuro', async () => {
  const { database } = fakeDatabase();
  await assert.rejects(
    MetaHistoricoService.findByMonth(7, '2026-12', database, date('2026-11-15T12:00:00.000Z')),
    (error: any) => error.statusCode === 400,
  );
});

test('reabertura apaga a conclusão anterior e nova conclusão define o novo mês', async () => {
  const { database, metas } = fakeDatabase();
  const goal = metas.find((item) => item.meta_id === 2)!;
  goal.meta_completado = false;
  goal.meta_data_conclusao = null;

  const reopened = await MetaHistoricoService.findByMonth(7, '2026-10', database, date('2026-12-15T12:00:00.000Z'));
  assert.equal(meta(reopened, 2).meta_completado, false);

  goal.meta_completado = true;
  goal.meta_data_conclusao = date('2026-11-10T12:00:00.000Z');
  const concluded = await MetaHistoricoService.findByMonth(7, '2026-11', database, date('2026-12-15T12:00:00.000Z'));
  const afterConclusion = await MetaHistoricoService.findByMonth(7, '2026-12', database, date('2026-12-15T12:00:00.000Z'));
  assert.equal(meta(concluded, 2).meta_completado, true);
  assert.equal(meta(afterConclusion, 2), undefined);
});
