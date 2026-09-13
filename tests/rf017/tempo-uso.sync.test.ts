import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FotografiaTempoUso,
  TempoUsoTransactionRunner,
  sincronizarFotografiasAtomicamente,
} from '../../src/modules/tempo-uso/tempo-uso.sync.js';

function criarBancoEmMemoria() {
  let dados = new Map<string, any>();
  const database: TempoUsoTransactionRunner = {
    async $transaction(callback) {
      const copia = new Map(dados);
      const resultado = await callback({
        tb_tempo_uso: {
          async upsert(argumento: any) {
            const chaveComposta = argumento.where.tempo_uso_usuario_package_periodo_unique;
            if (chaveComposta.tempo_uso_package_id === 'com.falha.loja') throw new Error('falha simulada');
            const chave = `${chaveComposta.usuario_id}:${chaveComposta.tempo_uso_package_id}:${chaveComposta.tempo_uso_inicio.toISOString()}:${chaveComposta.tempo_uso_fim.toISOString()}`;
            copia.set(chave, copia.has(chave)
              ? { ...copia.get(chave), ...argumento.update }
              : argumento.create);
          },
        },
      });
      dados = copia;
      return resultado;
    },
  };
  return { database, dados: () => [...dados.values()] };
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
