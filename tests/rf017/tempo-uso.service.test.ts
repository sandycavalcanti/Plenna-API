import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { bancoSimulado } from './tempo-uso.fixture.js';
process.env.DATABASE_URL = 'postgresql://localhost:1/offline';
process.env.DIRECT_URL = process.env.DATABASE_URL;
let banco = bancoSimulado();
const proxy = new Proxy({}, { get: (_, p) => banco.client[p] });
(globalThis as any).prismaRuntime = { client: proxy, pool: {} };
const { TempoUsoService: Service } = await import('../../src/modules/tempo-uso/tempo-uso.service.js');
beforeEach(() => { banco = bancoSimulado(); });
const entrada = { nome: 'Loja', minutos: 1.5, data: new Date('2026-01-01') };
test('create escreve duração canônica após lock/consentimento e lê minutos derivados', async () => {
  const r = await Service.create(7, entrada);
  assert.equal(r.tempo_uso_duracao_segundos, 90);
  assert.equal(r.tempo_uso_minutos, 1.5);
  assert.deepEqual(banco.chamadas, ['lock', 'consentimento', 'create']);
});
test('update minutos e update de nome preservam duração canônica', async () => {
  const r = await Service.create(7, entrada);
  await Service.update(7, r.tempo_uso_id, { minutos: 0.01 });
  await Service.update(7, r.tempo_uso_id, { nome: 'Novo nome' });
  assert.equal(banco.registros()[0].tempo_uso_duracao_segundos, 1);
  assert.equal(banco.registros()[0].tempo_uso_minutos, 0.02);
  assert.equal((await Service.findById(7, r.tempo_uso_id)).tempo_uso_minutos, 1 / 60);
});
test('edição de outro campo reconcilia apenas o legado tocado', async () => {
  const r = await Service.create(7, entrada);
  banco.registros()[0].tempo_uso_minutos = 999;
  await Service.update(7, r.tempo_uso_id, { nome: 'Novo' });
  assert.equal(banco.registros()[0].tempo_uso_minutos, 1.5);
});
test('legado sem segundos e Android novo são lidos canonicamente', async () => {
  const r = await Service.create(7, entrada);
  banco.registros()[0].tempo_uso_duracao_segundos = null;
  assert.equal((await Service.findById(7, r.tempo_uso_id)).tempo_uso_duracao_segundos, 90);
  banco.registros()[0].tempo_uso_origem = 'ANDROID_USAGE_STATS';
  banco.registros()[0].tempo_uso_duracao_segundos = 120;
  assert.equal((await Service.findById(7, r.tempo_uso_id)).tempo_uso_minutos, 2);
  await assert.rejects(Service.update(7, r.tempo_uso_id, { minutos: 4 }), { statusCode: 409 });
});
test('sem consentimento create/update não gravam', async () => {
  banco.consentir(false);
  await assert.rejects(Service.create(7, entrada), { statusCode: 403 });
  await assert.rejects(Service.update(7, 1, { nome: 'Novo' }), { statusCode: 403 });
  assert.equal(banco.registros().length, 0);
});
test('usuário inválido e leitura de outro usuário são rejeitados', async () => {
  await assert.rejects(Service.create(0, entrada), { statusCode: 401 });
  const r = await Service.create(7, entrada);
  await assert.rejects(Service.update(8, r.tempo_uso_id, { minutos: 4 }), { statusCode: 404 });
});
test('sync rejeita package fora do catálogo dentro da transação sem escrita', async () => {
  const hoje = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const amanha = new Date(Date.parse(hoje) + 86400000).toISOString().slice(0, 10);
  await assert.rejects(Service.sync(7, { schemaVersion: 1, registros: [{ packageId: 'com.exemplo.loja',
    dataLocal: hoje, timezone: 'UTC', inicio: hoje + 'T00:00:00Z', fim: amanha + 'T00:00:00Z', duracaoSegundos: 1 }] }), { statusCode: 422 });
  assert.equal(banco.registros().length, 0);
});

test('GET aplicativos expõe o catálogo canônico e todos os seus packages são aceitos pelo sync', async () => {
  const { APLICATIVOS_COMPRA } = await import('../../src/modules/tempo-uso/aplicativos-compra.catalog.js');
  const { TempoUsoController } = await import('../../src/modules/tempo-uso/tempo-uso.controller.js');
  let resposta: any;
  TempoUsoController.listarAplicativosCompra({ userId: 7 } as any, {
    json(body: unknown) { resposta = body; return this; },
  } as any);
  assert.deepEqual(resposta, { versao: 1, aplicativos: APLICATIVOS_COMPRA });
  for (const app of resposta.aplicativos) {
    assert.deepEqual(Object.keys(app).sort(), ['nomeApp', 'packageId']);
  }
  const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const hoje = new Date(Date.parse(ontem) + 86400000).toISOString().slice(0, 10);
  const registros = resposta.aplicativos.map((app: { packageId: string }) => ({
    packageId: app.packageId, dataLocal: ontem, timezone: 'UTC',
    inicio: ontem + 'T00:00:00Z', fim: hoje + 'T00:00:00Z', duracaoSegundos: 60,
  }));
  if (registros.length > 0) {
    assert.deepEqual(await Service.sync(7, { schemaVersion: 1, registros }), {
      recebidos: registros.length, persistidos: registros.length,
    });
    assert.equal(banco.registros().length, registros.length);
  }
});

test('controller rejeita sync sem usuário autenticado', async () => {
  const { TempoUsoController } = await import('../../src/modules/tempo-uso/tempo-uso.controller.js');
  let status = 0;
  const res = { status(n: number) { status = n; return this; }, json() { return this; } };
  await TempoUsoController.sync({ body: {} } as any, res as any);
  assert.equal(status, 401);
  assert.equal(banco.chamadas.length, 0);
});
test('create e update rejeitam valor que arredonda para zero sem escrita', async () => {
  await assert.rejects(Service.create(7, { ...entrada, minutos: 0.001 }), { statusCode: 400 });
  const r = await Service.create(7, entrada);
  await assert.rejects(Service.update(7, r.tempo_uso_id, { minutos: 0.001 }), { statusCode: 400 });
  assert.equal(banco.registros()[0].tempo_uso_duracao_segundos, 90);
});
