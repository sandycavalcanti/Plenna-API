import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const jwt = require('jsonwebtoken');
const testKey = 'rf017-test-only-not-a-real-secret';

async function setup() {
  const calls = [];
  const deny = () => { throw new Error('Unexpected database operation'); };
  const prisma = new Proxy({
    tb_tempo_uso: new Proxy({
      findFirst: async ({ where }) => {
        calls.push(where);
        assert.equal(where.tempo_uso_id, 123);
        assert.equal(where.usuario_id, 7);
        return { tempo_uso_id: 123 };
      },
    }, { get: (target, key) => key in target ? target[key] : deny }),
  }, { get: (target, key) => key in target ? target[key] : deny });
  // No real environment, dotenv, Prisma client or database is loaded.
  const context = vm.createContext({ process: { env: { JWT_SECRET: testKey } } });
  const cache = new Map();
  async function load(name) {
    if (cache.has(name)) return cache.get(name);
    let mod;
    if (name === 'src/lib/prisma.ts' || name === 'src/modules/consentimento/consentimento.service.ts' || !name.endsWith('.ts')) {
      const exports = name === 'src/lib/prisma.ts' ? { prisma }
        : name === 'src/modules/consentimento/consentimento.service.ts'
          ? { ConsentimentoService: new Proxy({}, { get: () => deny }) }
          : { ...require(name), default: require(name) };
      mod = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context, identifier: name });
    } else {
      const source = await readFile(new URL(name, root), 'utf8');
      mod = new vm.SourceTextModule(ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
      }).outputText, { context, identifier: name });
    }
    cache.set(name, mod);
    await mod.link((specifier, parent) => {
      if (!specifier.startsWith('.')) return load(specifier);
      const resolved = new URL(specifier, new URL(parent.identifier, root));
      return load(resolved.href.slice(root.href.length).replace(/\.js$/, '.ts'));
    });
    return mod;
  }
  const mod = await load('src/modules/tempo-uso/tempo-uso.routes.ts');
  await mod.evaluate();
  const router = mod.namespace.tempoUsoRouter;
  const token = jwt.sign({ userId: 7 }, testKey, { expiresIn: '5m' });
  function get(path, authorization) {
    return new Promise((resolve, reject) => {
      const req = { method: 'GET', url: path, headers: authorization ? { authorization } : {} };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body: JSON.parse(JSON.stringify(body)) }); return this; },
      };
      router.handle(req, res, error => error ? reject(error) : resolve({ status: 404 }));
    });
  }
  return { get, calls, authorization: 'Bearer ' + token };
}

test('authenticated catalog returns exactly the official contract without Prisma queries', async () => {
  const { get, calls, authorization } = await setup();
  assert.deepEqual(await get('/aplicativos', authorization), {
    status: 200,
    body: { versao: 1, aplicativos: [
      { packageId: 'com.shopee.br', nomeApp: 'Shopee' },
      { packageId: 'com.mercadolibre', nomeApp: 'Mercado Livre' },
      { packageId: 'com.zzkko', nomeApp: 'SHEIN' },
    ] },
  });
  assert.equal(calls.length, 0);
});

test('catalog without JWT preserves Production authentication response', async () => {
  const { get, calls } = await setup();
  assert.deepEqual(await get('/aplicativos'), { status: 401, body: { error: 'Token não informado' } });
  assert.equal(calls.length, 0);
});

test('invalid JWT remains rejected without database access', async () => {
  const { get, calls } = await setup();
  assert.deepEqual(await get('/aplicativos', 'Bearer invalid-test-token'), {
    status: 401, body: { error: 'Token inválido' },
  });
  assert.equal(calls.length, 0);
});

test('numeric path still uses findById', async () => {
  const { get, calls, authorization } = await setup();
  assert.deepEqual(await get('/123', authorization), { status: 200, body: { tempo_uso_id: 123 } });
  assert.equal(calls.length, 1);
});

test('valid JWT without userId remains rejected', async () => {
  const { get, calls } = await setup();
  const token = jwt.sign({}, testKey, { expiresIn: '5m' });
  assert.deepEqual(await get('/aplicativos', 'Bearer ' + token), {
    status: 401, body: { error: 'Token inválido' },
  });
  assert.equal(calls.length, 0);
});
