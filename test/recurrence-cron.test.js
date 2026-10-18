import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.DIRECT_URL = 'postgresql://localhost:1/recurrence_cron_offline';
process.env.DATABASE_URL = process.env.DIRECT_URL;
process.env.CRON_SECRET = 'offline-cron-secret';
process.env.RECURRENCE_CRON_ENABLED = 'false';

const runtimeClient = { $disconnect: async () => {} };
globalThis.prismaRuntime = { client: runtimeClient, pool: { end: async () => {} } };

const distRoot = process.env.PLENNA_TEST_DIST
  ? resolve(process.env.PLENNA_TEST_DIST)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const compiled = (relativePath) => pathToFileURL(resolve(distRoot, relativePath)).href;

const { disconnectPrisma } = await import(compiled('src/lib/prisma.js'));
const { env } = await import(compiled('src/lib/env.js'));
const { RecorrenciaCronController } = await import(compiled('src/modules/recorrencia/recorrencia.cron.controller.js'));

function requestWithAuthorization(value) {
  return {
    headers: value === undefined ? {} : { authorization: value },
    header(name) {
      return this.headers[name.toLowerCase()];
    },
  };
}

function responseRecorder() {
  const result = { statusCode: 200, body: undefined };
  return {
    result,
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };
}

after(disconnectPrisma);

test('recusa chamada do cron sem segredo e com segredo inválido antes do motor', async () => {
  env.recurrenceCronEnabled = true;
  let calls = 0;
  const processDue = async () => {
    calls += 1;
    return {};
  };

  const missingResponse = responseRecorder();
  await RecorrenciaCronController.process(requestWithAuthorization(), missingResponse, processDue);
  const invalidResponse = responseRecorder();
  await RecorrenciaCronController.process(
    requestWithAuthorization('Bearer invalid'),
    invalidResponse,
    processDue,
  );

  assert.equal(missingResponse.result.statusCode, 401);
  assert.equal(invalidResponse.result.statusCode, 401);
  assert.equal(calls, 0);
});

test('cron desabilitado autentica, mas não chama o motor nem cria compras', async () => {
  env.recurrenceCronEnabled = false;
  let calls = 0;
  const response = responseRecorder();
  await RecorrenciaCronController.process(
    requestWithAuthorization(`Bearer ${process.env.CRON_SECRET}`),
    response,
    async () => {
      calls += 1;
      return {};
    },
  );

  assert.equal(response.result.statusCode, 200);
  assert.deepEqual(response.result.body, { enabled: false, processed: false });
  assert.equal(calls, 0);
});

test('cron habilitado chama o motor exatamente uma vez e retorna somente contadores', async () => {
  env.recurrenceCronEnabled = true;
  let calls = 0;
  const response = responseRecorder();
  await RecorrenciaCronController.process(
    requestWithAuthorization(`Bearer ${process.env.CRON_SECRET}`),
    response,
    async () => {
      calls += 1;
      return {
        dataAtual: '2026-10-20',
        consideradas: 2,
        geradas: 1,
        jaExistentes: 1,
        ignoradas: 0,
        falhas: 0,
        falhasRecorrenciaIds: [99],
      };
    },
  );

  assert.equal(response.result.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(response.result.body.processed, true);
  assert.equal(response.result.body.geradas, 1);
  assert.equal('falhasRecorrenciaIds' in response.result.body, false);
});

test('falha do motor retorna erro genérico sem expor payload ou segredo', async () => {
  env.recurrenceCronEnabled = true;
  const response = responseRecorder();
  await RecorrenciaCronController.process(
    requestWithAuthorization(`Bearer ${process.env.CRON_SECRET}`),
    response,
    async () => {
      throw new Error('sensitive database payload');
    },
  );

  assert.equal(response.result.statusCode, 500);
  assert.deepEqual(Object.keys(response.result.body), ['error', 'executionId']);
  assert.equal(JSON.stringify(response.result.body).includes('sensitive'), false);
});

test('rota e configuração preservam cron jobs existentes e deixam recorrência desabilitada', async () => {
  const vercel = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../vercel.json'), 'utf8'));
  const paths = vercel.crons.map((cron) => cron.path);
  assert.deepEqual(paths.slice(0, 2), ['/email/sync/cron', '/notifications/seasonal/cron']);
  assert.equal(paths.includes('/recorrencias/cron'), true);
  assert.equal(vercel.crons.find((cron) => cron.path === '/recorrencias/cron').schedule, '0 * * * *');

  const appSource = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../src/app.ts'), 'utf8');
  assert.equal(appSource.includes("app.get('/recorrencias/cron'"), true);
  assert.equal(appSource.includes("app.use('/recorrencias', recorrenciaRouter)"), true);
});

