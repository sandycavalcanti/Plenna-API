import assert from 'node:assert/strict';
import test from 'node:test';
import { bancoSimulado, fotografia } from './tempo-uso.fixture.js';
import { sincronizarFotografiasAtomicamente as sync } from '../../src/modules/tempo-uso/tempo-uso.sync.js';
test('SIMULADO: revogação confirmada antes do sync impede escrita', async () => {
  const b = bancoSimulado();
  await b.client.$transaction(async (tx: any) => { await tx.$queryRaw`SELECT usuario_id FROM public.tb_usuario FOR UPDATE`; b.consentir(false); });
  await assert.rejects(sync(b.runner, 7, [fotografia()]), { statusCode: 403 });
  assert.equal(b.registros().length, 0);
});
test('SIMULADO: sync com lock primeiro termina antes da revogação', async () => {
  const b = bancoSimulado();
  let liberar!: () => void;
  let iniciou!: () => void;
  const inicio = new Promise<void>(r => { iniciou = r; });
  const gate = new Promise<void>(r => { liberar = r; });
  const original = b.client.tb_tempo_uso.upsert;
  b.client.tb_tempo_uso.upsert = async (args: any) => { iniciou(); await gate; return original(args); };
  const envio = sync(b.runner, 7, [fotografia()]);
  await inicio;
  let revogou = false;
  const revogacao = b.client.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT usuario_id FROM public.tb_usuario FOR UPDATE`;
    b.consentir(false); revogou = true;
  });
  assert.equal(revogou, false);
  liberar(); await envio; await revogacao;
  assert.equal(b.registros().length, 1);
  await assert.rejects(sync(b.runner, 7, [fotografia()]), { statusCode: 403 });
});
test('PostgreSQL real: ordens de lock/revogação', { skip: 'NÃO EXECUTADO: PostgreSQL isolado não disponível; nenhum acesso ao Neon' }, () => {});
