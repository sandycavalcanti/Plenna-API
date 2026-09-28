import assert from 'node:assert/strict';
import { bancoSimulado, fotografia as foto } from './tempo-uso.fixture.js';
import test from 'node:test';
import {
  FotografiaTempoUso,
  sincronizarFotografiasAtomicamente,
} from '../../src/modules/tempo-uso/tempo-uso.sync.js';

function criarBancoEmMemoria() {
  const b = bancoSimulado();
  b.falhar('com.falha.loja');
  return { database: b.runner, dados: b.registros };
}

function fotografia(packageId = 'com.exemplo.loja', duracaoSegundos = 930): FotografiaTempoUso {
  return {
    packageId,
    nomeApp: 'Loja aprovada',
    inicio: new Date('2026-09-11T00:00:00-03:00'),
    fim: new Date('2026-09-12T00:00:00-03:00'),
    dataLocal: new Date('2026-09-11T00:00:00Z'),
    timezone: 'America/Sao_Paulo',
    duracaoSegundos,
  };
}

test('reenvio da mesma chave atualiza a fotografia sem duplicar', async () => {
  const banco = criarBancoEmMemoria();
  await sincronizarFotografiasAtomicamente(banco.database, 7, [fotografia()]);
  await sincronizarFotografiasAtomicamente(banco.database, 7, [fotografia('com.exemplo.loja', 1200)]);
  assert.equal(banco.dados().length, 1);
  assert.equal(banco.dados()[0].tempo_uso_duracao_segundos, 1200);
});

test('reenvio de três dias mantém três snapshots e substitui durações sem somar', async () => {
  const banco = criarBancoEmMemoria();
  const fotografias = [11, 10, 9].map(dia => ({
    ...fotografia(),
    inicio: new Date(`2026-09-${String(dia).padStart(2, '0')}T00:00:00-03:00`),
    fim: new Date(`2026-09-${String(dia + 1).padStart(2, '0')}T00:00:00-03:00`),
    dataLocal: new Date(`2026-09-${String(dia).padStart(2, '0')}T00:00:00Z`),
  }));
  await sincronizarFotografiasAtomicamente(banco.database, 7, fotografias);
  const atualizadas = fotografias.map(f => ({ ...f, duracaoSegundos: 1200 }));
  await sincronizarFotografiasAtomicamente(banco.database, 7, atualizadas);
  await sincronizarFotografiasAtomicamente(banco.database, 7, atualizadas);
  assert.equal(banco.dados().length, 3);
  assert.ok(banco.dados().every(r => r.tempo_uso_duracao_segundos === 1200));
});

test('a chave idempotente permanece isolada por usuário', async () => {
  const banco = criarBancoEmMemoria();
  await sincronizarFotografiasAtomicamente(banco.database, 7, [fotografia()]);
  await sincronizarFotografiasAtomicamente(banco.database, 8, [fotografia()]);
  assert.equal(banco.dados().length, 2);
});

test('falha em um item desfaz atomicamente todo o lote', async () => {
  const banco = criarBancoEmMemoria();
  await assert.rejects(() => sincronizarFotografiasAtomicamente(
    banco.database,
    7,
    [fotografia(), fotografia('com.falha.loja')],
  ));
  assert.equal(banco.dados().length, 0);
});


test('conflito com existente rejeita todo lote antes das escritas', async () => {
  const b = bancoSimulado();
  await sincronizarFotografiasAtomicamente(b.runner, 7, [foto()]);
  const conflitante = { ...foto(), inicio: new Date('2026-09-11T02:00:00Z') };
  await assert.rejects(sincronizarFotografiasAtomicamente(b.runner, 7, [foto('com.nova.loja'), conflitante]), { statusCode: 409 });
  assert.equal(b.registros().length, 1);
  assert.equal(b.chamadas.filter(c => c === 'upsert').length, 1);
});
test('sobreposição do lote rejeita mesmo package, permite outro e isola usuário', async () => {
  const b = bancoSimulado();
  const conflitante = { ...foto(), inicio: new Date('2026-09-11T02:00:00Z') };
  await assert.rejects(sincronizarFotografiasAtomicamente(b.runner, 7, [foto(), conflitante]), { statusCode: 400 });
  assert.equal(b.registros().length, 0);
  await sincronizarFotografiasAtomicamente(b.runner, 7, [foto(), foto('com.outra.loja')]);
  await sincronizarFotografiasAtomicamente(b.runner, 8, [conflitante]);
  assert.equal(b.registros().length, 3);
});
test('mesma chave é atualizada; uma consulta de conflitos por lote', async () => {
  const b = bancoSimulado();
  await sincronizarFotografiasAtomicamente(b.runner, 7, [foto(), foto('com.outra.loja')]);
  assert.deepEqual(b.chamadas, ['lock', 'consentimento', 'conflitos', 'upsert', 'upsert']);
  await sincronizarFotografiasAtomicamente(b.runner, 7, [{ ...foto(), duracaoSegundos: 123 }]);
  assert.equal(b.registros().length, 2);
  assert.equal(b.registros()[0].tempo_uso_duracao_segundos, 123);
});
test('falha posterior desfaz atualizações e inserções anteriores', async () => {
  const b = bancoSimulado();
  await sincronizarFotografiasAtomicamente(b.runner, 7, [foto()]);
  b.falhar('com.falha.loja');
  await assert.rejects(sincronizarFotografiasAtomicamente(b.runner, 7, [{ ...foto(), duracaoSegundos: 999 }, foto('com.falha.loja')]));
  assert.equal(b.registros().length, 1);
  assert.equal(b.registros()[0].tempo_uso_duracao_segundos, 930);
});
