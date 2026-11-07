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

function aceita(registros: any[], referencia = agora) {
  return criarSyncTempoUsoSchema(referencia).safeParse({ schemaVersion: 1, registros }).success;
}
for (const [nome, mudanca] of [
  ['início igual ao fim', { inicio: registroValido.fim }],
  ['início posterior ao fim', { inicio: '2026-09-13T00:00:00-03:00' }],
  ['data impossível', { dataLocal: '2026-02-30', inicio: '2026-02-30T00:00:00-03:00' }],
  ['instante impossível normalizado pelo JS', { inicio: '2026-02-30T00:00:00-03:00' }],
  ['hora 24', { inicio: '2026-09-10T24:00:00-03:00' }],
  ['offset inválido', { inicio: '2026-09-11T00:00:00+25:00' }],
  ['sem offset', { inicio: '2026-09-11T00:00:00' }],
  ['milissegundos', { inicio: '2026-09-11T00:00:00.001-03:00' }],
  ['zero', { duracaoSegundos: 0 }],
  ['negativo', { duracaoSegundos: -1 }],
  ['dataLocal incompatível', { dataLocal: '2026-09-10' }],
  ['timezone numérico', { timezone: '-03:00' }],
] as const) test(nome + ' é rejeitado', () => assert.equal(aceita([{ ...registroValido, ...mudanca }]), false));
for (const dia of ['09', '10', '11']) test('aceita hoje/D-1/D-2: ' + dia, () => {
  assert.equal(aceita([{ ...registroValido, dataLocal: `2026-09-${dia}`,
    inicio: `2026-09-${dia}T00:00:00-03:00`, fim: `2026-09-${Number(dia) + 1}T00:00:00-03:00` }]), true);
});
test('rejeita D-3 e duração de hoje acima do transcorrido', () => {
  assert.equal(aceita([{ ...registroValido, dataLocal: '2026-09-08', inicio: '2026-09-08T00:00:00-03:00', fim: '2026-09-09T00:00:00-03:00' }]), false);
  assert.equal(aceita([{ ...registroValido, duracaoSegundos: 54001 }]), false);
  assert.equal(aceita([{ ...registroValido, duracaoSegundos: 54000 }]), true);
});
test('offset equivalente aceito isoladamente, mas duplicata lógica rejeitada', () => {
  const utc = { ...registroValido, inicio: '2026-09-11T03:00:00.000Z', fim: '2026-09-12T03:00:00Z' };
  assert.equal(aceita([utc]), true);
  assert.equal(aceita([registroValido, utc]), false);
});
test('sobreposição de mesmo package com fusos diferentes é rejeitada; packages distintos são permitidos', () => {
  const utc = { ...registroValido, timezone: 'UTC', inicio: '2026-09-11T00:00:00Z', fim: '2026-09-12T00:00:00Z' };
  assert.equal(aceita([registroValido, utc]), false);
  assert.equal(aceita([registroValido, { ...utc, packageId: 'com.outra.loja' }]), true);
});
test('dia de 25 horas respeita fronteiras locais', () => {
  assert.equal(aceita([{ ...registroValido, dataLocal: '2026-11-01', timezone: 'America/New_York',
    inicio: '2026-11-01T00:00:00-04:00', fim: '2026-11-02T00:00:00-05:00', duracaoSegundos: 90000 }],
    new Date('2026-11-02T12:00:00Z')), true);
});
