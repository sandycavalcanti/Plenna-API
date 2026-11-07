import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { GoalAnalyticsService } from '../../src/modules/goal/goal-analytics.service.js';

const NOW = new Date('2026-11-15T12:00:00.000Z');

function movement(
  id: number,
  metaId: number,
  type: 'DEPOSITO' | 'RETIRADA',
  value: string,
  date: string,
) {
  return {
    meta_movimentacao_id: id,
    meta_id: metaId,
    meta_movimentacao_tipo: type,
    meta_movimentacao_valor: new Prisma.Decimal(value),
    meta_movimentacao_data: new Date(date),
  };
}

function fakeDatabase() {
  const goals = [
    {
      meta_id: 1,
      usuario_id: 7,
      meta_titulo: 'Viagem',
      meta_valor: new Prisma.Decimal('200.00'),
      meta_valor_reservado: new Prisma.Decimal('65.00'),
      meta_completado: false,
      meta_data_criacao: new Date('2026-07-15T12:00:00.000Z'),
    },
    {
      meta_id: 2,
      usuario_id: 7,
      meta_titulo: 'Curso',
      meta_valor: new Prisma.Decimal('100.00'),
      meta_valor_reservado: new Prisma.Decimal('120.00'),
      meta_completado: false,
      meta_data_criacao: new Date('2026-08-20T12:00:00.000Z'),
    },
    {
      meta_id: 3,
      usuario_id: 7,
      meta_titulo: 'Reserva',
      meta_valor: new Prisma.Decimal('100.00'),
      meta_valor_reservado: new Prisma.Decimal('90.00'),
      meta_completado: true,
      meta_data_criacao: new Date('2026-09-20T12:00:00.000Z'),
    },
    {
      meta_id: 99,
      usuario_id: 8,
      meta_titulo: 'Privada',
      meta_valor: new Prisma.Decimal('100.00'),
      meta_valor_reservado: new Prisma.Decimal('100.00'),
      meta_completado: false,
      meta_data_criacao: new Date('2026-07-01T12:00:00.000Z'),
    },
  ];
  const movements = [
    // 2026-08-01T02:30Z ainda e 31/07 em Sao Paulo; deve cair em julho.
    movement(1, 1, 'DEPOSITO', '100.00', '2026-07-31T23:30:00.000Z'),
    movement(2, 1, 'DEPOSITO', '5.00', '2026-08-01T02:30:00.000Z'),
    movement(3, 1, 'DEPOSITO', '50.00', '2026-08-01T03:30:00.000Z'),
    movement(4, 1, 'RETIRADA', '10.00', '2026-09-10T12:00:00.000Z'),
    movement(5, 1, 'DEPOSITO', '25.00', '2026-10-05T12:00:00.000Z'),
    movement(6, 1, 'RETIRADA', '100.00', '2026-10-06T12:00:00.000Z'),
    movement(7, 3, 'DEPOSITO', '90.00', '2026-10-10T12:00:00.000Z'),
  ];
  return {
    tb_meta: {
      findMany: async ({ where, take }: any) => goals
        .filter((goal) => goal.usuario_id === where.usuario_id)
        .sort((left, right) => right.meta_data_criacao.getTime() - left.meta_data_criacao.getTime())
        .slice(0, take),
    },
    tb_meta_movimentacao: {
      findMany: async ({ where, orderBy }: any) => movements
        .filter((row) => where.meta_id.in.includes(row.meta_id))
        .filter((row) => !where.meta_movimentacao_data?.lt || row.meta_movimentacao_data < where.meta_movimentacao_data.lt)
        .sort((left, right) => (
          right.meta_movimentacao_data.getTime() - left.meta_movimentacao_data.getTime()
          || right.meta_movimentacao_id - left.meta_movimentacao_id
        ))
        .map((row) => ({ ...row })),
    },
  };
}

test('agrega indicadores por mes no fuso de Sao Paulo com Decimal', async () => {
  const result = await GoalAnalyticsService.analyze(7, {
    periodo: '2026-10',
    meses: 4,
    limite_metas: 10,
    limite_movimentacoes_recentes: 10,
  }, fakeDatabase(), NOW);

  assert.equal(result.timezone, 'America/Sao_Paulo');
  const viagem: any = result.metas.find((goal) => goal.id === 1);
  assert.equal(viagem.valor_reservado, '65.00');
  assert.equal(viagem.valor_restante, '135.00');
  assert.equal(viagem.progresso_percentual, 32.5);
  assert.deepEqual(viagem.indicadores.periodos_mensais.map((period: any) => [period.periodo, period.status]), [
    ['2026-07', 'COM_DEPOSITOS'],
    ['2026-08', 'COM_DEPOSITOS'],
    ['2026-09', 'SEM_DEPOSITOS'],
    ['2026-10', 'COM_DEPOSITOS'],
  ]);
  assert.equal(viagem.indicadores.periodos_mensais[0].total_depositado, '105.00');
  assert.equal(viagem.indicadores.periodos_mensais[1].total_depositado, '50.00');
  assert.equal(viagem.indicadores.periodos_mensais[3].saldo_liquido, '-75.00');
  assert.equal(viagem.indicadores.meses_consecutivos_com_depositos, 1);
  assert.equal(viagem.indicadores.meses_com_movimentacoes_sem_deposito[0], '2026-09');
  assert.equal(viagem.indicadores.frequencia_contribuicoes.total_depositos, 4);
  assert.equal(viagem.ultima_movimentacao.tipo, 'RETIRADA');
  assert.equal(viagem.ultimo_deposito.valor, '25.00');
  assert.equal(viagem.indicadores.periodos_mensais[1].comparacao_com_mes_anterior.envolve_periodo_parcial, true);
});

test('nao trata meses anteriores a criacao como ausencia de economia e identifica excesso de progresso', async () => {
  const result: any = await GoalAnalyticsService.analyze(7, {
    periodo: '2026-10',
    meses: 6,
    limite_metas: 10,
    limite_movimentacoes_recentes: 10,
  }, fakeDatabase(), NOW);
  const course = result.metas.find((goal: any) => goal.id === 2);
  assert.deepEqual(course.indicadores.periodos_mensais.map((period: any) => period.periodo), ['2026-08', '2026-09', '2026-10']);
  assert.deepEqual(course.indicadores.periodos_sem_movimentacoes, ['2026-08', '2026-09', '2026-10']);
  assert.equal(course.indicadores.atingiu_100_porcento, true);
  assert.equal(course.valor_restante, '0.00');
  assert.equal(course.progresso_percentual, 120);
});

test('retorna metas somente do usuario autenticado, limites e periodo atual incompleto', async () => {
  const result: any = await GoalAnalyticsService.analyze(7, {
    periodo: '2026-11',
    meses: 12,
    limite_metas: 2,
    limite_movimentacoes_recentes: 1,
  }, fakeDatabase(), NOW);
  assert.equal(result.metas.length, 2);
  assert.equal(result.metas.some((goal: any) => goal.id === 99), false);
  assert.equal(result.cobertura.metas_limitadas, true);
  assert.equal(result.cobertura.dados_suficientes, false);
  assert.equal(result.cobertura.periodo_referencia_parcial, true);
  assert.equal(result.metas[0].indicadores.periodos_mensais.at(-1).parcial, true);
  assert.equal(result.metas[0].indicadores.periodos_mensais.at(-1).motivo_parcial, 'MES_ATUAL_INCOMPLETO');
  assert.equal(result.metas[0].movimentacoes_recentes.length <= 1, true);
});

test('resultado vazio informa ausencia sem executar escrita', async () => {
  const database: any = fakeDatabase();
  database.tb_meta.findMany = async () => [];
  const result: any = await GoalAnalyticsService.analyze(7, { periodo: '2026-10' }, database, NOW);
  assert.deepEqual(result.metas, []);
  assert.equal(result.cobertura.sem_movimentacoes, true);
  assert.equal(result.cobertura.qualidade, 'SEM_METAS');
  assert.equal(typeof database.tb_meta.create, 'undefined');
  assert.equal(typeof database.tb_meta_movimentacao.create, 'undefined');
});

test('limites e argumentos desconhecidos sao rejeitados por Zod', async () => {
  await assert.rejects(
    () => GoalAnalyticsService.analyze(7, { periodo: '2026-10', meses: 13 }, fakeDatabase(), NOW),
  );
  await assert.rejects(
    () => GoalAnalyticsService.analyze(7, { usuario_id: 8 }, fakeDatabase(), NOW),
  );
});

