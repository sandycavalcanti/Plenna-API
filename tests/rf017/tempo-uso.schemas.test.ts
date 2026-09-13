import assert from 'node:assert/strict';
import test from 'node:test';
import { criarSyncTempoUsoSchema } from '../../src/modules/tempo-uso/tempo-uso.schemas.js';

const agora = new Date('2026-09-11T15:00:00-03:00');
const registroValido = {
  packageId: 'com.exemplo.loja',
  dataLocal: '2026-09-11',
  timezone: 'America/Sao_Paulo',
  inicio: '2026-09-11T00:00:00-03:00',
  fim: '2026-09-12T00:00:00-03:00',
  duracaoSegundos: 930,
};

test('aceita fotografia diária válida', () => {
  const resultado = criarSyncTempoUsoSchema(agora).safeParse({ schemaVersion: 1, registros: [registroValido] });
  assert.equal(resultado.success, true);
});

test('rejeita campos de identidade e origem controlados pelo servidor', () => {
  const resultado = criarSyncTempoUsoSchema(agora).safeParse({
    schemaVersion: 1,
    usuarioId: 99,
    registros: [{ ...registroValido, nomeApp: 'Nome enviado pelo cliente' }],
  });
  assert.equal(resultado.success, false);
});

test('rejeita duração incompatível, data futura, intervalo longo e duplicata no lote', () => {
  const schema = criarSyncTempoUsoSchema(agora);
  assert.equal(schema.safeParse({
    schemaVersion: 1,
    registros: [{ ...registroValido, duracaoSegundos: 90_000 }],
  }).success, false);
  assert.equal(schema.safeParse({
    schemaVersion: 1,
    registros: [{ ...registroValido, dataLocal: '2026-09-12', inicio: '2026-09-12T00:00:00-03:00', fim: '2026-09-13T00:00:00-03:00' }],
  }).success, false);
  assert.equal(schema.safeParse({
    schemaVersion: 1,
    registros: [{ ...registroValido, fim: '2026-09-13T00:00:00-03:00' }],
  }).success, false);
  assert.equal(schema.safeParse({
    schemaVersion: 1,
    registros: [registroValido, registroValido],
  }).success, false);
});

test('aceita dia de 23 horas em transição de horário de verão', () => {
  const resultado = criarSyncTempoUsoSchema(new Date('2026-03-08T12:00:00-04:00')).safeParse({
    schemaVersion: 1,
    registros: [{
      ...registroValido,
      dataLocal: '2026-03-08',
      timezone: 'America/New_York',
      inicio: '2026-03-08T00:00:00-05:00',
      fim: '2026-03-09T00:00:00-04:00',
    }],
  });
  assert.equal(resultado.success, true);
});

test('rejeita timezone inválido e lote acima do limite', () => {
  assert.equal(criarSyncTempoUsoSchema(agora).safeParse({
    schemaVersion: 1,
    registros: [{ ...registroValido, timezone: 'timezone-inexistente' }],
  }).success, false);
  assert.equal(criarSyncTempoUsoSchema(agora).safeParse({
    schemaVersion: 1,
    registros: Array.from({ length: 201 }, (_, indice) => ({
      ...registroValido,
      packageId: `com.exemplo.loja${indice}`,
    })),
  }).success, false);
});
