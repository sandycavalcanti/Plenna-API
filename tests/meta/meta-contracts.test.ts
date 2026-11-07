import assert from 'node:assert/strict';
import test from 'node:test';
import {
  metaMovimentacaoCreateResponseSchema,
  metaMovimentacaoErrorSchema,
  metaMoneyInputSchema,
  metaMovimentacaoInputSchema,
  metaMovimentacaoListQuerySchema,
  metaMovimentacaoListResponseSchema,
} from '../../src/modules/meta/meta.schemas.js';
import { serializeMetaMoney } from '../../src/modules/meta/meta.money.js';
import { serializeMeta } from '../../src/modules/meta/meta.service.js';

const operationId = '00000000-0000-4000-8000-000000000000';

test('contrato de criação e edição usa reais, sem conversão implícita para centavos', () => {
  assert.equal(metaMoneyInputSchema.parse('500.00'), '500.00');
  assert.equal(metaMoneyInputSchema.parse(500), '500.00');
  assert.equal(metaMoneyInputSchema.parse(50000), '50000.00');
  assert.equal(serializeMetaMoney('0'), '0.00');
  assert.equal(metaMoneyInputSchema.safeParse('50000.001').success, false);
  assert.equal(metaMoneyInputSchema.safeParse('0.00').success, false);
});

test('GET /metas serializa Decimal persistido como reais com duas casas', () => {
  const meta = serializeMeta({
    meta_id: 2,
    meta_valor: '500.00',
    meta_valor_reservado: '0',
  });
  assert.equal(meta.meta_valor, '500.00');
  assert.equal(meta.meta_valor_reservado, '0.00');
});


test('contrato de movimentação aceita valor decimal textual e UUID', () => {
  assert.deepEqual(metaMovimentacaoInputSchema.parse({
    tipo: 'DEPOSITO',
    valor: '123.45',
    operacao_id: operationId,
  }), {
    tipo: 'DEPOSITO',
    valor: '123.45',
    operacao_id: operationId,
  });
});

test('contrato de movimentação rejeita tipo, valor e UUID inválidos', () => {
  for (const value of [
    { tipo: 'TRANSFERENCIA', valor: '10.00', operacao_id: operationId },
    { tipo: 'RETIRADA', valor: '0.00', operacao_id: operationId },
    { tipo: 'RETIRADA', valor: '10.001', operacao_id: operationId },
    { tipo: 'RETIRADA', valor: '10.00', operacao_id: 'not-a-uuid' },
  ]) {
    assert.equal(metaMovimentacaoInputSchema.safeParse(value).success, false);
  }
});

test('consulta paginada aplica limite padrão e teto compartilhado', () => {
  assert.deepEqual(metaMovimentacaoListQuerySchema.parse({}), { limit: 20 });
  assert.deepEqual(metaMovimentacaoListQuerySchema.parse({ limit: '100', cursor: 'opaque-cursor' }), { limit: 100, cursor: 'opaque-cursor' });
  assert.equal(metaMovimentacaoListQuerySchema.safeParse({ limit: 101 }).success, false);
});

test('respostas congelam serialização monetária e cursor', () => {
  const movement = {
    meta_movimentacao_id: 7,
    meta_id: 3,
    meta_movimentacao_operacao_id: operationId,
    meta_movimentacao_tipo: 'DEPOSITO' as const,
    meta_movimentacao_valor: '123.45',
    meta_movimentacao_data: '2026-11-06T12:00:00.000Z',
  };
  const summary = {
    meta_id: 3,
    meta_valor: '1000.00',
    meta_valor_reservado: '123.45',
    progresso_percentual: 12.345,
    valor_restante: '876.55',
    ultima_movimentacao: movement,
    ultimo_deposito: movement,
  };

  assert.equal(metaMovimentacaoCreateResponseSchema.safeParse({ movimentacao: movement, meta: summary }).success, true);
  assert.equal(metaMovimentacaoListResponseSchema.safeParse({ itens: [movement], nextCursor: null }).success, true);
  assert.equal(metaMovimentacaoCreateResponseSchema.safeParse({ movimentacao: movement, meta: { ...summary, meta_valor: 1000 } }).success, false);
});

test('erro de movimentação mantém código e detalhes de validação', () => {
  assert.deepEqual(metaMovimentacaoErrorSchema.parse({
    message: 'Saldo insuficiente',
    code: 'SALDO_INSUFICIENTE',
  }), {
    message: 'Saldo insuficiente',
    code: 'SALDO_INSUFICIENTE',
    errors: [],
  });
});
