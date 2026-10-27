import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventoCompraSchema } from '../../src/modules/compra/eventos.schemas.ts';
import {
  validarEventoFinanceiro,
  eventosVigentes,
  resumirEventos,
} from '../../src/modules/compra/eventos.engine.ts';
globalThis.prismaRuntime = { client: {}, pool: { end: async () => {} } };
const { referenciaNaData, ReferenciasService } = await import(
  '../../src/modules/compra/referencias.service.ts'
);
const now = new Date('2026-10-25T12:00:00Z'),
  purchase = {
    valorCentavos: 10000,
    itens: [
      { id: 10, quantidade: 2, valorUnitarioCentavos: 5000 },
      { id: 11, quantidade: null, valorUnitarioCentavos: 2000 },
    ],
  };
const body = (extra) =>
  eventoCompraSchema.parse({
    versaoContrato: 1,
    operacaoId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    revisaoEsperada: 0,
    dataEfetiva: null,
    ...extra,
  });
const row = (id, tipo, dados, extra = {}) => ({
  evento_id: id,
  compra_item_id: null,
  tipo,
  dados,
  revisao: id,
  corrige_evento_id: null,
  anulado: false,
  efetiva_em: null,
  ...extra,
});
const validate = (data, rows = []) =>
  validarEventoFinanceiro(body(data), rows, purchase, now);
test('refunds require evidence and cannot exceed original purchase; cancellation never manufactures a refund', () => {
  validate({ tipo: 'REEMBOLSO', valorCentavos: 10000 });
  assert.throws(
    () => validate({ tipo: 'REEMBOLSO', valorCentavos: 10001 }),
    (e) => e.statusCode === 422,
  );
  const events = [row(1, 'CANCELAMENTO', {}), row(2, 'DEVOLUCAO', {})];
  assert.equal(resumirEventos(events).reembolsadoCentavos, 0);
  assert.equal(resumirEventos(events).cancelamentos, 1);
});
test('partial returns respect item scope and recorded quantity; unknown quantity is not fabricated', () => {
  validate({ tipo: 'DEVOLUCAO', itemId: 10, quantidade: 0.5 });
  assert.throws(
    () => validate({ tipo: 'DEVOLUCAO', itemId: 10, quantidade: 2.001 }),
    (e) => e.statusCode === 422,
  );
  assert.throws(
    () => validate({ tipo: 'DEVOLUCAO', itemId: 11, quantidade: 1 }),
    (e) => e.statusCode === 422,
  );
  assert.throws(
    () => validate({ tipo: 'DEVOLUCAO', itemId: 99 }),
    (e) => e.statusCode === 404,
  );
  assert.throws(
    () => validate({ tipo: 'DEVOLUCAO', quantidade: 1 }),
    (e) => e.statusCode === 400,
  );
});
test('whole and partial events cannot be counted twice, while legitimate partial operations accumulate', () => {
  const prior = [
    row(1, 'DEVOLUCAO', { quantidade: 1.5 }, { compra_item_id: 10 }),
  ];
  validate({ tipo: 'DEVOLUCAO', itemId: 10, quantidade: 0.5 }, prior);
  assert.throws(() =>
    validate({ tipo: 'DEVOLUCAO', itemId: 10, quantidade: 0.6 }, prior),
  );
  assert.throws(
    () => validate({ tipo: 'DEVOLUCAO' }, prior),
    (e) => e.statusCode === 409,
  );
  assert.throws(
    () => validate({ tipo: 'CANCELAMENTO' }, [row(1, 'CANCELAMENTO', {})]),
    (e) => e.statusCode === 409,
  );
});
test('corrections replace the projected event while preserving the original ledger and support annulment', () => {
  const a = row(1, 'REEMBOLSO', { valorCentavos: 6000 }),
    b = row(2, 'REEMBOLSO', { valorCentavos: 3000 }, { corrige_evento_id: 1 });
  validate({ tipo: 'REEMBOLSO', valorCentavos: 4000, corrigeEventoId: 2 }, [
    a,
    b,
  ]);
  assert.equal(resumirEventos([a, b]).reembolsadoCentavos, 3000);
  assert.equal(eventosVigentes([a, b]).length, 1);
  assert.throws(
    () =>
      validate({ tipo: 'REEMBOLSO', valorCentavos: 1000, corrigeEventoId: 1 }, [
        a,
        b,
      ]),
    (e) => e.statusCode === 409,
  );
  assert.equal(
    resumirEventos([
      a,
      b,
      row(
        3,
        'REEMBOLSO',
        { valorCentavos: 3000 },
        { corrige_evento_id: 2, anulado: true },
      ),
    ]).reembolsadoCentavos,
    0,
  );
  assert.throws(() =>
    validate({ tipo: 'REEMBOLSO', valorCentavos: 1000, anulado: true }),
  );
});
test('hidden records do not become deleted or behavioral evidence and item visibility remains scoped', () => {
  const h = resumirEventos([
    row(1, 'OCULTACAO', { oculto: true }),
    row(2, 'OCULTACAO', { oculto: true }, { compra_item_id: 10 }),
    row(3, 'OCULTACAO', { oculto: false }),
  ]);
  assert.equal(h.oculto, false);
  assert.deepEqual(h.itensOcultos, [10]);
  assert.equal(h.cancelamentos, 0);
  assert.equal(h.reembolsadoCentavos, 0);
});
test('classification is explicit and separate; legacy enum remains unchanged', () => {
  validate({ tipo: 'CLASSIFICACAO', classificacao: 'PREFIRO_NAO_CLASSIFICAR' });
  assert.throws(() =>
    validate({ tipo: 'CLASSIFICACAO', classificacao: 'IMPULSIVA', itemId: 10 }),
  );
  assert.throws(() =>
    body({ tipo: 'CLASSIFICACAO', classificacao: 'COMPULSIVA' }),
  );
  assert.equal(
    resumirEventos([
      row(1, 'CLASSIFICACAO', { classificacao: 'IMPULSIVA' }),
      row(2, 'CLASSIFICACAO', { classificacao: 'PREFIRO_NAO_CLASSIFICAR' }),
    ]).classificacao,
    'PREFIRO_NAO_CLASSIFICAR',
  );
});
test('effective date is optional, validated and distinct from registration; unknown date is explicit', () => {
  validate({ tipo: 'REEMBOLSO', valorCentavos: 1000 });
  assert.equal(
    resumirEventos([row(1, 'REEMBOLSO', { valorCentavos: 1000 })])
      .reembolsosSemData,
    1,
  );
  assert.throws(() =>
    body({ tipo: 'CANCELAMENTO', dataEfetiva: '2026-02-31' }),
  );
  assert.throws(() =>
    validate({ tipo: 'CANCELAMENTO', dataEfetiva: '2026-10-26' }),
  );
});
test('temporal references preserve changes on beginning, middle and last day without inventing order within a day', () => {
  const rows = [
    ['2026-10-01T12:00:00Z', 650],
    ['2026-10-15T12:00:00Z', 900],
    ['2026-10-31T23:00:00Z', 1000],
  ].map(([at, valor]) => ({
    tipo: 'LIMITE_COMPRA',
    categoria_id: null,
    valor,
    vigente_desde: new Date(at),
    aplicacao: 'AGORA',
    periodo: null,
  }));
  for (const [date, expected] of [
    ['2026-09-30', null],
    ['2026-10-01', null],
    ['2026-10-02', 650],
    ['2026-10-15', null],
    ['2026-10-16', 900],
    ['2026-10-31', null],
    ['2026-11-01', 1000],
  ])
    assert.equal(
      referenciaNaData(rows, 'LIMITE_COMPRA', new Date(date + 'T12:00:00Z'))
        ?.valor ?? null,
      expected,
    );
  assert.equal(
    referenciaNaData(rows, 'CATEGORIA', new Date('2026-10-16'), 2),
    null,
  );
});
test('monthly aggregation never invents prorating, future scheduling or historical budget', async () => {
  await assert.rejects(
    ReferenciasService.registrar(
      1,
      {
        versaoContrato: 1,
        operacaoId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        tipo: 'ORCAMENTO_MENSAL',
        valorCentavos: 90000,
        aplicacao: 'AGORA',
        periodo: '2026-10',
      },
      now,
    ),
    (e) => e.statusCode === 422,
  );
  await assert.rejects(
    ReferenciasService.registrar(
      1,
      {
        versaoContrato: 1,
        operacaoId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        tipo: 'ORCAMENTO_MENSAL',
        valorCentavos: 90000,
        aplicacao: 'MES_INTEIRO',
        periodo: '2026-09',
      },
      now,
    ),
    (e) => e.statusCode === 422,
  );
});
test('migration is additive, changes only the two new tables and contains no backfill or enum alteration', () => {
  const sql = readFileSync(
    new URL(
      '../../prisma/migrations/20261025120000_gestao_eventos_referencias/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(
    sql.replace(/ON (DELETE|UPDATE) NO ACTION/g, ''),
    /\bDROP\b|\bTRUNCATE\b|\bUPDATE\b|\bDELETE\b|INSERT INTO|ALTER TYPE/,
  );
  for (const match of sql.matchAll(/ALTER TABLE "(?:public"\.\")?([^".]+)"/g))
    assert.ok(
      ['tb_compra_evento', 'tb_referencia_financeira'].includes(match[1]),
    );
  assert.match(sql, /tb_compra_evento_compra_id_operacao_id_key/);
  assert.match(sql, /corrige_evento_id/);
});
