import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
let purchase, context, rows, limit, userActive, hook, transactionError, forbidWrites;
const clone = (v) => structuredClone(v);
function transactionClient() {
  const p = clone(purchase),
    c = clone(context),
    l = limit;
  return {
    tb_compra: {
      findFirst: async ({ where }) =>
        p &&
        where.compra_id === p.compra_id &&
        where.usuario_id === p.usuario_id
          ? { ...p, tb_usuario: { usuario_meta_valor_compra: l } }
          : null,
    },
    contexto_compra_revisao: { findFirst: async () => c },
    avaliacao_compra: {
      findMany: async ({ where, take }) => clone(rows.filter(row => row.usuario_id === where.usuario_id &&
        row.compra_id === where.compra_id && (where.avaliacao_id === undefined || row.avaliacao_id < where.avaliacao_id.lt))
        .sort((a,b) => b.avaliacao_id-a.avaliacao_id).slice(0,take)),
      findFirst: async ({ where }) =>
        clone(
          rows
            .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
            .at(-1) ?? null,
        ),
      upsert: async ({ where, create }) => {
        if (forbidWrites) throw Error('READ_ONLY_VERIFICATION');
        if (hook) {
          const fn = hook;
          hook = null;
          await fn();
        }
        const key = where.compra_id_versao_motor_fontes_hash;
        let r = rows.find((r) =>
          Object.entries(key).every(([k, v]) => r[k] === v),
        );
        if (!r) {
          r = {
            ...clone(create),
            avaliacao_id: rows.length + 1,
            criada_em: new Date('2026-10-24T12:00:00Z'),
          };
          rows.push(r);
        }
        return clone(r);
      },
    },
  };
}
const db = {
  tb_usuario: {
    findFirst: async ({ where }) =>
      userActive ? { usuario_id: where.usuario_id } : null,
  },
  $transaction: async (cb) => {
    if (transactionError) {
      const e = transactionError;
      transactionError = null;
      throw e;
    }
    return cb(transactionClient());
  },
};
globalThis.prismaRuntime = { client: db, pool: { end: async () => {} } };
const { AvaliacaoService } = await import(
  '../../src/modules/analise/avaliacao.service.ts'
);
const { contextoRouter } = await import(
  '../../src/modules/analise/contexto.routes.ts'
);
let server, base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/v2/compras', contextoRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/v2/compras`;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
test.beforeEach(() => {
  forbidWrites = false;
  limit = '80';
  userActive = true;
  hook = null;
  rows = [];
  purchase = {
    compra_id: 1,
    usuario_id: 1,
    compra_ativo: 1,
    compra_status: 'CONFIRMADA',
    compra_valor: '100',
    compra_desconto: '0',
    compra_horario: new Date('2026-10-05Z'),
    compra_email: false,
    compra_fonte: 'Loja',
    compra_classificacao: 'PENDENTE',
    tb_compra_item: [
      {
        compra_item_id: 10,
        compra_item_ativo: 1,
        compra_item_nome: 'Livro',
        compra_item_valor: '100',
        compra_item_quantidade: null,
        categoria_id: 1,
      },
    ],
  };
  context = {
    contexto_id: 1,
    revisao: 1,
    respostas: { planejamento: 'NAO', influenciaPromocional: 'SIM' },
    itens: [{ compra_item_id: 10, planejamento: 'NAO' }],
  };
});
const calculate = (body = { revisaoEsperada: 1 }) =>
  AvaliacaoService.calcular(1, 1, body);
const current = () => AvaliacaoService.consultar(1, 1);
async function http(
  path = '/1/avaliacoes/atual',
  method = 'GET',
  body,
  token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' }),
) {
  return fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
test('GET without prior assessment never writes', async () => {
  assert.equal((await current()).atualidade, 'SEM_AVALIACAO');
  assert.equal(rows.length, 0);
});

test('explicação opt-in projeta múltiplos fatores persistidos sem alterar resposta legada ou registros', async () => {
  const saved = await calculate();
  forbidWrites = true;
  const before = clone(rows);
  const legacy = await current();
  assert.equal('explicacao' in legacy, false);
  const expanded = await AvaliacaoService.consultar(1,1,undefined,true);
  assert.deepEqual(expanded.resultado,legacy.resultado);
  assert.equal(expanded.explicacao.resumo,saved.resultado.interpretacao.mensagem);
  assert.deepEqual(new Set(expanded.explicacao.fatores.map(f=>f.natureza)),new Set(['REGISTRADO','DECLARADO','INTERPRETADO']));
  assert.ok(expanded.explicacao.fatores.some(f=>f.campo==='planejamento'));
  assert.ok(expanded.explicacao.fatores.some(f=>f.campo==='influenciaPromocional'));
  assert.ok(expanded.explicacao.fatores.some(f=>f.itemId===10));
  assert.equal(expanded.explicacao.fatoresCompletos,true);
  assert.equal(expanded.explicacao.historicoCompras,'NAO_REGISTRADO_NESTE_RESULTADO');
  assert.equal('classificacao' in expanded.explicacao,false);
  assert.deepEqual(rows,before);
});

test('histórico expandido pagina prévias dos resultados originais, inclusive legados, sem recalcular', async () => {
  await calculate();
  forbidWrites = true;
  const original=clone(rows[0]);
  rows=Array.from({length:25},(_,i)=>({...clone(original),avaliacao_id:i+1}));
  rows[24].versao_motor='contextual-1';rows[24].resultado.versaoMotor='contextual-1';
  const before=clone(rows);limit='200';context.respostas={planejamento:'SIM'};
  const page=await AvaliacaoService.historico(1,1,undefined,true);
  assert.equal(page.avaliacoes.length,20);
  assert.equal(page.avaliacoes[0].atualidade,'DESATUALIZADA');
  const e=page.avaliacoes[0].explicacao;
  assert.equal(e.fatores.length,3);assert.ok(e.totalFatores>3);assert.equal(e.fatoresCompletos,false);
  assert.equal(e.resumo,original.resultado.interpretacao.mensagem);
  const detail=await AvaliacaoService.consultar(1,1,25,true);
  assert.equal(detail.explicacao.fatores.length,e.totalFatores);
  assert.deepEqual(rows,before);
});

test('GET expandido valida parâmetros, autenticação, exclusão e ausência sem gravar', async () => {
  assert.equal((await http('/1/avaliacoes/atual?explicacao=2')).status,400);
  assert.equal((await http('/1/avaliacoes/historico?explicacao=1','GET',undefined,'')).status,401);
  const empty=await (await http('/1/avaliacoes/atual?explicacao=1')).json();
  assert.equal(empty.explicacao,null);assert.equal(rows.length,0);
  await calculate();const before=clone(rows);
  const response=await http('/1/avaliacoes/historico?explicacao=1');
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.ok((await response.json()).avaliacoes[0].explicacao);
  purchase.compra_ativo=0;
  assert.equal((await AvaliacaoService.consultar(1,1,1,true)).explicacao,null);
  assert.equal((await AvaliacaoService.historico(1,1,undefined,true)).avaliacoes[0].explicacao,null);
  await assert.rejects(AvaliacaoService.historico(2,1,undefined,true),e=>e.statusCode===404);
  assert.deepEqual(rows,before);
});

test('F33: histórico pagina avaliações próprias sem recalcular ou expor snapshots', async () => {
  await calculate();
  const original = clone(rows[0]);
  rows = Array.from({length:25}, (_, index) => ({...clone(original), avaliacao_id:index+1}));
  rows.push({...clone(original), avaliacao_id:100, usuario_id:2});
  const before = clone(rows);
  const first = await AvaliacaoService.historico(1,1);
  assert.equal(first.avaliacoes.length,20);assert.equal(first.proximoAntes,6);
  assert.equal(first.avaliacoes[0].avaliacaoId,25);
  assert.equal(first.avaliacoes[0].atualidade,'VIGENTE');
  assert.equal('dados_utilizados' in first.avaliacoes[0],false);
  const last = await AvaliacaoService.historico(1,1,first.proximoAntes);
  assert.deepEqual(last.avaliacoes.map(row=>row.avaliacaoId),[5,4,3,2,1]);assert.equal(last.proximoAntes,null);
  limit='200';assert.equal((await AvaliacaoService.historico(1,1)).avaliacoes[0].atualidade,'DESATUALIZADA');
  await assert.rejects(AvaliacaoService.historico(2,1),error=>error.statusCode===404);
  assert.deepEqual(rows,before);
});

test('F33: rota do histórico exige sessão e rejeita cursores inválidos', async () => {
  assert.equal((await http('/1/avaliacoes/historico?antes=0')).status,400);
  assert.equal((await http('/1/avaliacoes/historico','GET',undefined,'')).status,401);
  assert.deepEqual((await (await http('/1/avaliacoes/historico')).json()).avaliacoes,[]);
});
test('serialization/unique race retries in a new transaction', async () => {
  for (const code of ['P2034', 'P2002']) {
    transactionError = new Prisma.PrismaClientKnownRequestError(
      'simulated race',
      { code, clientVersion: 'test' },
    );
    assert.equal((await calculate()).atualidade, 'VIGENTE');
  }
  assert.equal(rows.length, 1);
});
test('persists version, context FK/revision, source snapshot and evidence without classification changes', async () => {
  const before = clone(purchase);
  const r = await calculate();
  assert.equal(r.atualidade, 'VIGENTE');
  assert.equal(rows[0].contexto_id, 1);
  assert.equal(rows[0].contexto_revisao, 1);
  assert.equal(rows[0].versao_motor, 'contextual-2');
  assert.equal(rows[0].fontes_hash.length, 64);
  assert.equal(rows[0].dados_utilizados.limite, '80');
  assert.ok(rows[0].resultado.evidencias.length);
  assert.deepEqual(purchase, before);
});
test('same snapshot and concurrent calculations deduplicate; read-only consultation stays stable', async () => {
  const [a, b] = await Promise.all([calculate(), calculate()]);
  assert.equal(a.avaliacaoId, b.avaliacaoId);
  assert.equal(rows.length, 1);
  assert.deepEqual(await current(), a);
});
test('purchase edits status confirmation timing value discount and source invalidate lazily', async () => {
  for (const [key, value] of [
    ['compra_valor', '150'],
    ['compra_status', 'IGNORADA'],
    ['compra_horario', new Date('2026-10-06Z')],
    ['compra_desconto', '5'],
    ['compra_fonte', 'Outra loja'],
    ['compra_email', true],
  ]) {
    rows = [];
    const old = purchase[key];
    await calculate();
    purchase[key] = value;
    assert.equal((await current()).atualidade, 'DESATUALIZADA', key);
    purchase[key] = old;
  }
});
test('confirmation invalidates prior non-assessable result', async () => {
  purchase.compra_status = 'AGUARDANDO_CONFIRMACAO';
  assert.equal((await calculate()).resultado.estado, 'NAO_AVALIAVEL');
  purchase.compra_status = 'CONFIRMADA';
  assert.equal((await current()).atualidade, 'DESATUALIZADA');
});
test('individual reference changes including removal invalidate without rewriting history', async () => {
  await calculate();
  limit = null;
  assert.equal((await current()).atualidade, 'DESATUALIZADA');
  assert.equal(rows[0].dados_utilizados.limite, '80');
  assert.equal((await calculate()).resultado.observacoes.length, 0);
});
test('context revision invalidates even if answer value unchanged; stale context expectation conflicts', async () => {
  await calculate();
  context.revisao = 2;
  context.contexto_id = 2;
  assert.equal((await current()).atualidade, 'DESATUALIZADA');
  await assert.rejects(calculate(), (e) => e.statusCode === 409);
  assert.equal(rows.length, 1);
});
test('deleted item omitted from next interpretation and replacement never inherits context', async () => {
  await calculate();
  purchase.tb_compra_item[0].compra_item_ativo = 0;
  purchase.tb_compra_item.push({
    ...purchase.tb_compra_item[0],
    compra_item_id: 11,
    compra_item_ativo: 1,
  });
  assert.equal((await current()).atualidade, 'DESATUALIZADA');
  const r = await calculate();
  assert.equal(
    r.resultado.declaracoes.filter((d) => d.campo === 'planejamentoItem')
      .length,
    0,
  );
});
test('soft deletion makes previous assessment stale and suppresses result', async () => {
  await calculate();
  purchase.compra_ativo = 0;
  const r = await current();
  assert.equal(r.atualidade, 'DESATUALIZADA');
  assert.equal(r.resultado, null);
  await assert.rejects(calculate(), (e) => e.statusCode === 409);
});
test('reconciliation updates consumed item data invalidates', async () => {
  await calculate();
  purchase.tb_compra_item[0].compra_item_quantidade = '2';
  assert.equal((await current()).atualidade, 'DESATUALIZADA');
});
test('changes during calculation are detected by fresh post-persistence snapshot', async () => {
  hook = async () => {
    limit = '200';
  };
  const r = await calculate();
  assert.equal(r.atualidade, 'DESATUALIZADA');
  assert.equal(rows[0].dados_utilizados.limite, '80');
});
test('engine version change invalidates; exact earlier snapshot can be current again', async () => {
  const first = await calculate();
  limit = '200';
  await calculate();
  limit = '80';
  assert.equal((await current()).avaliacaoId, first.avaliacaoId);
  rows.forEach((r) => (r.versao_motor = 'old'));
  assert.equal((await current()).atualidade, 'DESATUALIZADA');
});
test('purchase and assessment ownership are checked', async () => {
  await calculate();
  await assert.rejects(
    AvaliacaoService.consultar(2, 1),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    AvaliacaoService.calcular(2, 1, {}),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    AvaliacaoService.consultar(1, 1, 999),
    (e) => e.statusCode === 404,
  );
});
test('no context or unknown value is supported with explicit limitations', async () => {
  context = null;
  purchase.compra_valor = null;
  const r = await calculate({ revisaoEsperada: 0 });
  assert.equal(r.resultado.estado, 'DADOS_INSUFICIENTES');
  assert.equal(rows[0].contexto_id, null);
  assert.equal(rows[0].contexto_revisao, 0);
  assert.ok(r.resultado.limitacoes.includes('VALOR_DESCONHECIDO'));
});
test('HTTP auth contracts no-store POST current and individual reads', async () => {
  assert.equal((await http(undefined, 'GET', undefined, null)).status, 401);
  assert.equal(
    (await http('/1/avaliacoes', 'POST', { extra: true })).status,
    400,
  );
  assert.equal((await http('/x/avaliacoes/atual')).status, 400);
  const res = await http('/1/avaliacoes', 'POST', { revisaoEsperada: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal((await http(`/1/avaliacoes/${body.avaliacaoId}`)).status, 200);
  assert.equal((await http()).status, 200);
  userActive = false;
  assert.equal((await http()).status, 401);
});
test('HTTP rejects corrupt persisted results with sanitized server error', async () => {
  await calculate();
  rows[0].resultado = {};
  const res = await http();
  assert.equal(res.status, 500);
  assert.doesNotMatch(await res.text(), /OUTPUT_INVALID|fontes_hash/);
});

test('legacy contextual-1 result remains readable and immutable; contextual-2 creates a separate assessment', async () => {
  const first = await calculate();
  rows[0].versao_motor = 'contextual-1';
  rows[0].resultado.versaoMotor = 'contextual-1';
  const legacy = clone(rows[0]);
  const old = await AvaliacaoService.consultar(1, 1, first.avaliacaoId);
  assert.equal(old.atualidade, 'DESATUALIZADA');
  assert.equal(old.resultado.versaoMotor, 'contextual-1');
  assert.ok(old.motivos.includes('VERSAO_MOTOR_ALTERADA'));
  const next = await calculate();
  assert.notEqual(next.avaliacaoId, first.avaliacaoId);
  assert.equal(next.resultado.versaoMotor, 'contextual-2');
  assert.deepEqual(rows[0], legacy);
});
