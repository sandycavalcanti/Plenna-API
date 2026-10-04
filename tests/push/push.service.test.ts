import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

process.env.DATABASE_URL = 'postgresql://localhost:1/offline';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'phase-4-test-secret';
process.env.GOOGLE_CLIENT_ID = 'phase-4-client';
process.env.GOOGLE_CLIENT_SECRET = 'phase-4-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost/callback';

type Device = {
  dispositivo_id: number;
  usuario_id: number;
  dispositivo_push_token: string;
  dispositivo_plataforma: string;
  dispositivo_ativo: number;
  dispositivo_ultimo_erro: string | null;
  dispositivo_ultima_tentativa_em: Date | null;
  dispositivo_ultima_utilizacao_em: Date | null;
  dispositivo_data_criacao: Date;
  dispositivo_data_modificacao: Date;
};

let devices: Device[] = [];
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchImplementation: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
let failDeviceUpdate = false;

const db = {
  tb_dispositivo: {
    findMany: async ({ where }: any) => devices.filter((device) =>
      device.usuario_id === where.usuario_id && device.dispositivo_ativo === where.dispositivo_ativo),
    updateMany: async ({ where, data }: any) => {
      if (failDeviceUpdate) throw new Error('operational update failure');
      const matches = devices.filter((device) => device.dispositivo_id === where.dispositivo_id);
      matches.forEach((device) => Object.assign(device, data));
      return { count: matches.length };
    },
  },
};

(globalThis as any).prismaRuntime = { client: db, pool: { end: async () => {} } };

const { PushService } = await import('../../src/modules/notification/push.service.ts');

const notification = (notificationId: number, type = 'LIMITE_MENSAL') => ({ notificationId, type });

function makeDevice(id: number, overrides: Partial<Device> = {}): Device {
  return {
    dispositivo_id: id,
    usuario_id: 1,
    dispositivo_push_token: `ExponentPushToken[token-${id}]`,
    dispositivo_plataforma: 'android',
    dispositivo_ativo: 1,
    dispositivo_ultimo_erro: 'previous error',
    dispositivo_ultima_tentativa_em: null,
    dispositivo_ultima_utilizacao_em: new Date('2026-01-01'),
    dispositivo_data_criacao: new Date('2026-01-01'),
    dispositivo_data_modificacao: new Date('2026-01-01'),
    ...overrides,
  };
}

function expoResponse(status: number, data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(handler: (body: any, init: RequestInit) => Response | Promise<Response> = (body) =>
  expoResponse(200, body.map(() => ({ status: 'ok', id: 'ticket' })))) {
  return async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    const body = JSON.parse(String(init.body));
    return handler(body, init);
  };
}

function makeService(settings: Record<string, unknown> = {}) {
  return new PushService({
    db: db as any,
    fetchImplementation: (fetchImplementation ?? makeFetch()) as any,
    settings: {
      enabled: true,
      timeoutMs: 100,
      batchSize: 100,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      ...settings,
    },
    sleep: async () => {},
  });
}

function sentMessages() {
  return fetchCalls.flatMap((call) => JSON.parse(String(call.init.body)));
}

beforeEach(() => {
  devices = [];
  fetchCalls = [];
  fetchImplementation = null;
  failDeviceUpdate = false;
});

test('sem devices ativos não chama o Expo', async () => {
  const result = await makeService().dispatchForUser(1, [notification(1)]);
  assert.deepEqual(result, { attempted: 0, succeeded: 0, failed: 0, deactivated: 0, skipped: 1 });
  assert.equal(fetchCalls.length, 0);
});

test('envia para um device ativo', async () => {
  devices.push(makeDevice(1));
  const result = await makeService().dispatchForUser(1, [notification(10)]);
  assert.equal(result.attempted, 1);
  assert.equal(result.succeeded, 1);
});

test('envia a mesma notificação para múltiplos devices ativos', async () => {
  devices.push(makeDevice(1), makeDevice(2));
  const result = await makeService().dispatchForUser(1, [notification(10)]);
  assert.equal(result.attempted, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(sentMessages().length, 2);
});

test('respeita batching máximo de 100 mensagens', async () => {
  devices.push(makeDevice(1));
  const result = await makeService({ batchSize: 200 }).dispatchForUser(1, Array.from({ length: 101 }, (_, i) => notification(i + 1)));
  assert.equal(result.succeeded, 101);
  assert.deepEqual(fetchCalls.map((call) => JSON.parse(String(call.init.body)).length), [100, 1]);
});

test('payload usa título e corpo genéricos', async () => {
  devices.push(makeDevice(1));
  await makeService().dispatchForUser(1, [notification(10, 'LIMITE_COMPRA')]);
  const [message] = sentMessages();
  assert.equal(message.title, 'Plenna');
  assert.equal(message.body, 'Você tem uma nova atualização no seu planejamento.');
});

test('payload contém somente identificadores mínimos na data', async () => {
  devices.push(makeDevice(1));
  await makeService().dispatchForUser(1, [notification(10, 'LIMITE_COMPRA')]);
  const [message] = sentMessages();
  assert.deepEqual(message.data, { notificationId: 10, type: 'LIMITE_COMPRA' });
  assert.equal(JSON.stringify(message).includes('userId'), false);
  assert.equal(JSON.stringify(message).includes('idempotency'), false);
  assert.equal(JSON.stringify(message).includes('compra'), false);
});

test('EXPO_PUSH_ENABLED false não realiza chamada externa', async () => {
  devices.push(makeDevice(1));
  const result = await makeService({ enabled: false }).dispatchForUser(1, [notification(1)]);
  assert.equal(result.skipped, 1);
  assert.equal(fetchCalls.length, 0);
});

test('sucesso atualiza última tentativa e limpa erro anterior', async () => {
  devices.push(makeDevice(1));
  await makeService().dispatchForUser(1, [notification(1)]);
  assert.ok(devices[0].dispositivo_ultima_tentativa_em instanceof Date);
  assert.equal(devices[0].dispositivo_ultimo_erro, null);
  assert.equal(devices[0].dispositivo_ativo, 1);
});

test('DeviceNotRegistered desativa o device', async () => {
  devices.push(makeDevice(1));
  fetchImplementation = makeFetch(() => expoResponse(200, [{ status: 'error', details: { error: 'DeviceNotRegistered' } }]));
  const result = await makeService().dispatchForUser(1, [notification(1)]);
  assert.equal(result.deactivated, 1);
  assert.equal(devices[0].dispositivo_ativo, 0);
  assert.equal(devices[0].dispositivo_ultimo_erro, 'DeviceNotRegistered');
});

test('erro de token não loga nem retorna o token completo', async () => {
  devices.push(makeDevice(1));
  fetchImplementation = makeFetch(() => expoResponse(200, [{ status: 'error', details: { error: 'DeviceNotRegistered' } }]));
  const result = await makeService().dispatchForUser(1, [notification(1)]);
  assert.equal(JSON.stringify(result).includes('ExponentPushToken'), false);
  assert.equal(devices[0].dispositivo_ultimo_erro?.includes('ExponentPushToken'), false);
});

test('HTTP 4xx permanente falha sem desativar automaticamente', async () => {
  devices.push(makeDevice(1));
  fetchImplementation = makeFetch(() => expoResponse(400, []));
  const result = await makeService().dispatchForUser(1, [notification(1)]);
  assert.equal(result.failed, 1);
  assert.equal(devices[0].dispositivo_ativo, 1);
});

test('DeviceNotRegistered estruturado em HTTP 4xx também desativa o device', async () => {
  devices.push(makeDevice(1));
  fetchImplementation = makeFetch(() => expoResponse(400, [{ status: 'error', details: { error: 'DeviceNotRegistered' } }]));
  const result = await makeService().dispatchForUser(1, [notification(1)]);
  assert.equal(result.deactivated, 1);
  assert.equal(devices[0].dispositivo_ativo, 0);
});

test('HTTP 429 faz retry limitado e depois entrega', async () => {
  devices.push(makeDevice(1));
  let calls = 0;
  fetchImplementation = makeFetch(() => {
    calls += 1;
    return calls === 1 ? expoResponse(429, []) : expoResponse(200, [{ status: 'ok' }]);
  });
  const result = await makeService({ maxRetries: 1 }).dispatchForUser(1, [notification(1)]);
  assert.equal(calls, 2);
  assert.equal(result.succeeded, 1);
});

test('HTTP 5xx faz retry limitado e depois falha', async () => {
  devices.push(makeDevice(1));
  let calls = 0;
  fetchImplementation = makeFetch(() => {
    calls += 1;
    return expoResponse(503, []);
  });
  const result = await makeService({ maxRetries: 2 }).dispatchForUser(1, [notification(1)]);
  assert.equal(calls, 3);
  assert.equal(result.failed, 1);
  assert.equal(devices[0].dispositivo_ativo, 1);
});

test('falha de rede faz retry e não desativa device', async () => {
  devices.push(makeDevice(1));
  let calls = 0;
  fetchImplementation = async () => {
    calls += 1;
    if (calls === 1) throw new Error('network unavailable');
    return expoResponse(200, [{ status: 'ok' }]);
  };
  const result = await makeService({ maxRetries: 1 }).dispatchForUser(1, [notification(1)]);
  assert.equal(calls, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(devices[0].dispositivo_ativo, 1);
});

test('timeout faz retry limitado', async () => {
  devices.push(makeDevice(1));
  let calls = 0;
  fetchImplementation = async () => {
    calls += 1;
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  const result = await makeService({ maxRetries: 1 }).dispatchForUser(1, [notification(1)]);
  assert.equal(calls, 2);
  assert.equal(result.failed, 1);
  assert.equal(devices[0].dispositivo_ativo, 1);
});

test('envia Authorization somente quando access token está configurado', async () => {
  devices.push(makeDevice(1));
  await makeService({ accessToken: 'expo-secret' }).dispatchForUser(1, [notification(1)]);
  assert.equal((fetchCalls[0].init.headers as Record<string, string>).Authorization, 'Bearer expo-secret');
});

test('não expõe tokens no resultado operacional', async () => {
  devices.push(makeDevice(1));
  const result = await makeService().dispatchForUser(1, [notification(1)]);
  assert.deepEqual(Object.keys(result).sort(), ['attempted', 'deactivated', 'failed', 'skipped', 'succeeded']);
});

test('device inativo não recebe push', async () => {
  devices.push(makeDevice(1, { dispositivo_ativo: 0 }));
  const result = await makeService().dispatchForUser(1, [notification(1)]);
  assert.equal(result.attempted, 0);
  assert.equal(fetchCalls.length, 0);
});

test('lista vazia de notificações não chama devices nem Expo', async () => {
  devices.push(makeDevice(1));
  const result = await makeService().dispatchForUser(1, []);
  assert.deepEqual(result, { attempted: 0, succeeded: 0, failed: 0, deactivated: 0, skipped: 0 });
  assert.equal(fetchCalls.length, 0);
});

test('envia todas as notificações novas para cada device', async () => {
  devices.push(makeDevice(1), makeDevice(2));
  const result = await makeService().dispatchForUser(1, [notification(1), notification(2)]);
  assert.equal(result.attempted, 4);
  assert.equal(result.succeeded, 4);
});

test('mapeia respostas Expo pela posição do lote', async () => {
  devices.push(makeDevice(1), makeDevice(2));
  fetchImplementation = makeFetch(() => expoResponse(200, [
    { status: 'error', details: { error: 'DeviceNotRegistered' } },
    { status: 'ok' },
  ]));
  const result = await makeService().dispatchForUser(1, [notification(1)]);
  assert.equal(result.deactivated, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(devices[0].dispositivo_ativo, 0);
  assert.equal(devices[1].dispositivo_ativo, 1);
});

test('resposta malformada é falha operacional sem desativar token', async () => {
  devices.push(makeDevice(1));
  fetchImplementation = makeFetch(() => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
  const result = await makeService().dispatchForUser(1, [notification(1)]);
  assert.equal(result.failed, 1);
  assert.equal(devices[0].dispositivo_ativo, 1);
});

test('falha ao atualizar estado operacional não derruba o dispatch', async () => {
  devices.push(makeDevice(1));
  failDeviceUpdate = true;
  const result = await makeService().dispatchForUser(1, [notification(1)]);
  assert.equal(result.succeeded, 1);
});

test('erro individual diferente de DeviceNotRegistered não desativa token', async () => {
  devices.push(makeDevice(1));
  fetchImplementation = makeFetch(() => expoResponse(200, [{ status: 'error', details: { error: 'MessageRateExceeded' } }]));
  const result = await makeService().dispatchForUser(1, [notification(1)]);
  assert.equal(result.failed, 1);
  assert.equal(result.deactivated, 0);
  assert.equal(devices[0].dispositivo_ativo, 1);
});

test('resultado de sucesso mantém device ativo', async () => {
  devices.push(makeDevice(1, { dispositivo_ativo: 1 }));
  await makeService().dispatchForUser(1, [notification(1)]);
  assert.equal(devices[0].dispositivo_ativo, 1);
});
