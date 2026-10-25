// Creates a NEW loopback-only cluster, with synthetic data. Never loads .env or a dump.
import './test-gestao-env.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const mobileRoot = process.env.RF018_MOBILE_ROOT;
if (!mobileRoot)
  throw Error(
    'Informe RF018_MOBILE_ROOT com a worktree Mobile para o teste integrado.',
  );
const mobileModule = (name) =>
  pathToFileURL(resolve(mobileRoot, 'src/services', name)).href;
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import express from 'express';
import jwt from 'jsonwebtoken';
const exec = promisify(execFile),
  bin = 'C:/Program Files/PostgreSQL/18/bin',
  port = 55449;
const motorAutomatico = process.argv.includes('--motor-automatico');
const dir = resolve('.validation', 'gestao-sintetica-' + Date.now()),
  cluster = join(dir, 'cluster');
const safeEnv = Object.fromEntries(
  ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
const report = {
  banco: 'plenna_gestao_sintetica',
  host: '127.0.0.1',
  port,
  producaoAcessada: false,
  cenarios: [],
};
let started = false,
  client,
  pool,
  server;
const run = (name, args) =>
  exec(join(bin, name + '.exe'), args, {
    env: safeEnv,
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
const check = (name) => report.cenarios.push(name);
try {
  await mkdir(dir, { recursive: true });
  await run('initdb', [
    '-D',
    cluster,
    '-U',
    'plenna_ux',
    '--auth-host=trust',
    '--auth-local=trust',
    '--encoding=UTF8',
    '--no-locale',
  ]);
  await run('pg_ctl', [
    '-D',
    cluster,
    '-l',
    join(dir, 'postgres.log'),
    '-o',
    `-h 127.0.0.1 -p ${port}`,
    '-w',
    'start',
  ]);
  started = true;
  await run('createdb', [
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-U',
    'plenna_ux',
    report.banco,
  ]);
  pool = new pg.Pool({
    host: '127.0.0.1',
    port,
    user: 'plenna_ux',
    database: report.banco,
    max: 5,
  });
  const identity = (
    await pool.query(
      'SELECT current_database() AS database,inet_server_addr()::text AS host',
    )
  ).rows[0];
  assert.equal(identity.database, report.banco);
  assert.match(identity.host, /^127\.0\.0\.1(?:\/32)?$/);
  report.identidade = identity;
  await pool.query(await readFile('.expo/gestao-baseline.sql', 'utf8'));
  await pool.query(
    await readFile(
      'prisma/migrations/20261025120000_gestao_eventos_referencias/migration.sql',
      'utf8',
    ),
  );
  check('migration aditiva aplicada somente no banco local novo');
  client = new PrismaClient({ adapter: new PrismaPg(pool) });
  globalThis.prismaRuntime = { client, pool };
  const { EventosCompraService: E } = await import(
    '../src/modules/compra/eventos.service.ts'
  );
  const { ReferenciasService: R } = await import(
    '../src/modules/compra/referencias.service.ts'
  );
  const { ContextoService: C } = await import(
    '../src/modules/rf018/contexto.service.ts'
  );
  const user = await client.tb_usuario.create({
    data: {
      usuario_email: 'sintetico@example.invalid',
      usuario_nome: 'Teste sintético',
      usuario_senha: 'nao-e-uma-credencial-real',
      usuario_meta_valor_compra: 650,
    },
  });
  const other = await client.tb_usuario.create({
    data: {
      usuario_email: 'outro@example.invalid',
      usuario_nome: 'Outro sintético',
      usuario_senha: 'nao-e-uma-credencial-real',
    },
  });
  const purchase = await client.tb_compra.create({
    data: {
      usuario_id: user.usuario_id,
      compra_classificacao: 'PENDENTE',
      compra_horario: new Date('2026-10-15T12:00:00Z'),
      compra_valor: 100,
      compra_email: false,
      tb_compra_item: {
        create: [
          {
            compra_item_nome: 'Item A',
            compra_item_valor: 60,
            compra_item_quantidade: 1,
          },
          {
            compra_item_nome: 'Item B',
            compra_item_valor: 40,
            compra_item_quantidade: 1,
          },
        ],
      },
    },
    include: { tb_compra_item: true },
  });
  let revision = 0;
  const save = async (extra) => {
    const result = await E.registrar(user.usuario_id, purchase.compra_id, {
      versaoContrato: 1,
      operacaoId: randomUUID(),
      revisaoEsperada: revision,
      dataEfetiva: null,
      ...extra,
    });
    revision = result.evento.revisao;
    return result;
  };
  const a = purchase.tb_compra_item[0].compra_item_id;
  const refundBody = {
    versaoContrato: 1,
    operacaoId: randomUUID(),
    revisaoEsperada: 0,
    dataEfetiva: null,
    tipo: 'REEMBOLSO',
    valorCentavos: 3000,
  };
  const refund = await E.registrar(
    user.usuario_id,
    purchase.compra_id,
    refundBody,
  );
  revision = refund.evento.revisao;
  assert.deepEqual(
    await E.registrar(user.usuario_id, purchase.compra_id, refundBody),
    refund,
  );
  assert.equal(await client.tb_compra_evento.count(), 1);
  check('reenvio após confirmação perdida não duplica reembolso');
  await save({ tipo: 'CANCELAMENTO', itemId: a, quantidade: 0.5 });
  await save({ tipo: 'DEVOLUCAO', itemId: a, quantidade: 0.25 });
  assert.equal(
    String(
      (
        await client.tb_compra.findUnique({
          where: { compra_id: purchase.compra_id },
        })
      ).compra_valor,
    ),
    '100',
  );
  check('cancelamento/devolução parciais preservam decisão e valor original');
  await assert.rejects(
    save({ tipo: 'REEMBOLSO', valorCentavos: 9000 }),
    (e) => e.statusCode === 422,
  );
  check('reembolso acima do valor é recusado');
  await save({
    tipo: 'REEMBOLSO',
    valorCentavos: 2000,
    corrigeEventoId: refund.evento.id,
  });
  let state = await E.consultar(user.usuario_id, purchase.compra_id);
  assert.equal(state.resumo.reembolsadoCentavos, 2000);
  assert.equal(state.resumo.valorAposReembolsosCentavos, 8000);
  assert.equal(state.eventos.length, 4);
  check('correção preserva evento original e ajusta projeção');
  await assert.rejects(
    E.consultar(other.usuario_id, purchase.compra_id),
    (e) => e.statusCode === 404,
  );
  check('isolamento entre usuários');
  await save({ tipo: 'OCULTACAO', oculto: true });
  assert.equal(
    (await E.consultar(user.usuario_id, purchase.compra_id)).resumo.oculto,
    true,
  );
  assert.equal(
    (
      await client.tb_compra.findUnique({
        where: { compra_id: purchase.compra_id },
      })
    ).compra_ativo,
    1,
  );
  check('ocultação não exclui compra dos cálculos');
  await save({ tipo: 'CLASSIFICACAO', classificacao: 'IMPULSIVA' });
  await save({
    tipo: 'CLASSIFICACAO',
    classificacao: 'PREFIRO_NAO_CLASSIFICAR',
  });
  assert.equal(
    (
      await client.tb_compra.findUnique({
        where: { compra_id: purchase.compra_id },
      })
    ).compra_classificacao,
    'PENDENTE',
  );
  check('classificação opcional revisada mantém histórico e enum legado');
  const context = await C.atualizar(user.usuario_id, purchase.compra_id, {
    versaoContrato: 1,
    operacaoId: randomUUID(),
    revisaoEsperada: 0,
    respostas: {
      planejamento: 'PARCIALMENTE',
      autopercepcaoImpulsividade: 'SIM',
    },
    itens: [{ itemId: a, planejamento: 'SIM' }],
  });
  assert.equal(context.revisao, 1);
  assert.equal(context.itens[0].itemId, a);
  assert.equal(
    (await C.consultar(user.usuario_id, purchase.compra_id)).revisao,
    1,
  );
  check(
    'PATCH RF018 com item persiste e reabre usando Prisma/PostgreSQL reais',
  );
  assert.equal(
    (await R.consultar(user.usuario_id, purchase.compra_id))
      .limiteHistoricoCentavos,
    null,
  );
  await R.registrar(
    user.usuario_id,
    {
      versaoContrato: 1,
      operacaoId: randomUUID(),
      tipo: 'LIMITE_COMPRA',
      valorCentavos: 65000,
      aplicacao: 'AGORA',
    },
    new Date('2026-10-10T12:00:00Z'),
  );
  await R.registrar(
    user.usuario_id,
    {
      versaoContrato: 1,
      operacaoId: randomUUID(),
      tipo: 'LIMITE_COMPRA',
      valorCentavos: 90000,
      aplicacao: 'AGORA',
    },
    new Date('2026-10-25T12:00:00Z'),
  );
  const limits = await R.consultar(user.usuario_id, purchase.compra_id);
  assert.equal(limits.limiteHistoricoCentavos, 65000);
  assert.equal(limits.limiteAtualCentavos, 90000);
  check('limite da época difere do limite atual sem fabricar passado');
  await R.registrar(
    user.usuario_id,
    {
      versaoContrato: 1,
      operacaoId: randomUUID(),
      tipo: 'ORCAMENTO_MENSAL',
      valorCentavos: 100000,
      aplicacao: 'MES_INTEIRO',
      periodo: '2026-10',
    },
    new Date('2026-10-25T12:00:00Z'),
  );
  check('orçamento de mês inteiro explicitamente escolhido');
  const invalid = await client.tb_compra.create({
    data: {
      usuario_id: user.usuario_id,
      compra_classificacao: 'PENDENTE',
      compra_horario: new Date(),
      compra_valor: 10,
      compra_email: false,
    },
  });
  await E.registrar(user.usuario_id, invalid.compra_id, {
    versaoContrato: 1,
    operacaoId: randomUUID(),
    revisaoEsperada: 0,
    tipo: 'EXCLUSAO_REGISTRO',
    motivo: 'DUPLICADO',
    dataEfetiva: null,
  });
  assert.equal(
    (
      await client.tb_compra.findUnique({
        where: { compra_id: invalid.compra_id },
      })
    ).compra_ativo,
    0,
  );
  assert.equal(
    (await E.consultar(user.usuario_id, invalid.compra_id)).eventos[0].dados
      .motivo,
    'DUPLICADO',
  );
  check('exclusão lógica mantém motivo no histórico');
  const { UsersService } = await import('../src/modules/user/user.service.ts');
  await UsersService.update(other.usuario_id, { metaValorMensal: 500 });
  const refsBefore = await client.tb_referencia_financeira.count({
    where: { usuario_id: other.usuario_id },
  });
  await UsersService.update(other.usuario_id, {
    metaValorMensal: 500,
    orcamentoVigencia: 'MES_INTEIRO',
  });
  assert.equal(
    await client.tb_referencia_financeira.count({
      where: { usuario_id: other.usuario_id },
    }),
    refsBefore + 1,
  );
  await UsersService.update(other.usuario_id, {
    metaValorMensal: 500,
    orcamentoVigencia: 'MES_INTEIRO',
  });
  assert.equal(
    await client.tb_referencia_financeira.count({
      where: { usuario_id: other.usuario_id },
    }),
    refsBefore + 1,
  );
  check(
    'vigência explícita com mesmo valor é registrada uma vez, inclusive após reenvio',
  );
  const whole = await client.tb_compra.create({
    data: {
      usuario_id: user.usuario_id,
      compra_classificacao: 'PENDENTE',
      compra_horario: new Date(),
      compra_valor: 90,
      compra_email: false,
      tb_compra_item: {
        create: {
          compra_item_nome: 'Item sintético',
          compra_item_valor: 30,
          compra_item_quantidade: 3,
        },
      },
    },
    include: { tb_compra_item: true },
  });
  const wholeBody = {
    versaoContrato: 1,
    operacaoId: randomUUID(),
    revisaoEsperada: 0,
    tipo: 'CANCELAMENTO',
    dataEfetiva: null,
  };
  const cancelled = await E.registrar(
    user.usuario_id,
    whole.compra_id,
    wholeBody,
  );
  await assert.rejects(
    E.registrar(user.usuario_id, whole.compra_id, {
      ...wholeBody,
      operacaoId: randomUUID(),
      revisaoEsperada: 1,
      itemId: whole.tb_compra_item[0].compra_item_id,
      quantidade: 1,
    }),
    (e) => e.statusCode === 409,
  );
  check('cancelamento total impede sobreposição parcial');
  await E.registrar(user.usuario_id, whole.compra_id, {
    ...wholeBody,
    operacaoId: randomUUID(),
    revisaoEsperada: 1,
    corrigeEventoId: cancelled.evento.id,
    anulado: true,
  });
  assert.equal(
    (await E.consultar(user.usuario_id, whole.compra_id)).resumo.cancelamentos,
    0,
  );
  assert.equal(
    await client.tb_compra_evento.count({
      where: { compra_id: whole.compra_id },
    }),
    2,
  );
  check('anulação preserva auditoria e remove somente o efeito do evento');
  // Actual Mobile writer -> HTTP -> JWT middleware -> routes -> Prisma -> isolated PostgreSQL.
  const { eventosCompraRouter } = await import(
    '../src/modules/compra/eventos.routes.ts'
  );
  const { criarGravadorEvento } = await import(
    mobileModule('gestaoCompraService.js')
  );
  const app = express();
  app.use(express.json());
  app.use('/v2/compras', eventosCompraRouter);
  if (motorAutomatico) {
    const { analisesRouter } = await import(
      '../src/modules/rf018/rf018.routes.ts'
    );
    app.use('/analises', analisesRouter);
  }
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ userId: user.usuario_id }, process.env.JWT_SECRET, {
    expiresIn: '5m',
  });
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  const route = `/v2/compras/${purchase.compra_id}/eventos`;
  assert.equal((await fetch(base + route)).status, 401);
  check('HTTP real exige autenticação');
  const foreign = jwt.sign(
    { userId: other.usuario_id },
    process.env.JWT_SECRET,
    { expiresIn: '5m' },
  );
  assert.equal(
    (
      await fetch(base + route, {
        headers: { authorization: `Bearer ${foreign}` },
      })
    ).status,
    404,
  );
  check('HTTP real isola compras privadas');
  const before = await client.tb_compra_evento.count();
  let loseAck = true;
  const posted = [];
  const controller = new AbortController(),
    session = { id: 1, signal: controller.signal };
  const options = {
    compraId: purchase.compra_id,
    uuid: randomUUID,
    storage: {
      captureSession: async () => session,
      assertSession() {
        assert.equal(controller.signal.aborted, false);
      },
    },
    client: {
      post: async (url, body) => {
        posted.push(body);
        const response = await fetch(base + url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok)
          throw Object.assign(Error('HTTP local'), {
            response: { status: response.status, data },
          });
        if (loseAck) {
          loseAck = false;
          throw Error('Network Error');
        }
        return { data };
      },
    },
  };
  const mobileBody = {
    versaoContrato: 1,
    revisaoEsperada: revision,
    tipo: 'REEMBOLSO',
    valorCentavos: 500,
    dataEfetiva: '2026-10-24',
  };
  await assert.rejects(
    criarGravadorEvento(options)(mobileBody),
    /Network Error/,
  );
  const mobileResult = await criarGravadorEvento(options)({
    ...mobileBody,
    revisaoEsperada: revision + 1,
  });
  assert.equal(mobileResult.persistido, true);
  assert.equal(posted[0].operacaoId, posted[1].operacaoId);
  assert.equal(await client.tb_compra_evento.count(), before + 1);
  check(
    'Mobile real confirma persistência HTTP e reenvio após perda de resposta não duplica',
  );
  const reopened = await fetch(base + route, { headers });
  assert.equal(reopened.headers.get('cache-control'), 'no-store');
  assert.equal((await reopened.json()).resumo.reembolsadoCentavos, 2500);
  check('reabertura HTTP lê o reembolso persistido sem cache');
  const invalidHttp = await fetch(base + route, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...mobileBody,
      operacaoId: randomUUID(),
      revisaoEsperada: revision + 1,
      valorCentavos: -1,
    }),
  });
  assert.equal(invalidHttp.status, 400);
  assert.equal(await client.tb_compra_evento.count(), before + 1);
  check('validação HTTP rejeita valor inválido sem escrita');
  const stale = await fetch(base + route, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...mobileBody, operacaoId: randomUUID() }),
  });
  assert.equal(stale.status, 409);
  check('revisão concorrente HTTP retorna conflito sem duplicação');
  const batch = await fetch(
    base + `/v2/compras/resumos?ids=${purchase.compra_id},${invalid.compra_id}`,
    { headers },
  );
  assert.equal(batch.status, 200);
  const summaries = (await batch.json()).resumos;
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].oculto, true);
  check('resumos HTTP preservam ocultação e excluem registros inativos');
  if (motorAutomatico) {
    const { AutomaticoService: A } = await import(
      '../src/modules/rf018/automatico.service.ts'
    );
    const { AvaliacaoService } = await import(
      '../src/modules/rf018/avaliacao.service.ts'
    );
    const { consultarAnaliseAutomatica } = await import(
      mobileModule('analiseAutomaticaService.js')
    );
    const actor = await client.tb_usuario.create({
      data: {
        usuario_email: 'automatico@example.invalid',
        usuario_nome: 'Automático sintético',
        usuario_senha: 'sintetica-sem-uso-real',
      },
    });
    const cat = await client.tb_categoria.create({
      data: { categoria_nome: 'Categoria sintética' },
    });
    const create = async (value, date) =>
      client.tb_compra.create({
        data: {
          usuario_id: actor.usuario_id,
          compra_classificacao: 'PENDENTE',
          compra_horario: new Date(date + 'T00:00:00Z'),
          compra_valor: value,
          compra_email: false,
          tb_compra_item: {
            create: {
              compra_item_nome: 'Item sintético',
              compra_item_valor: value,
              compra_item_quantidade: 1,
              categoria_id: cat.categoria_id,
            },
          },
        },
      });
    let value = 10;
    for (const [i, n] of [1, 2, 1, 3, 2, 1].entries())
      for (let j = 0; j < n; j++)
        await create(value++, '2026-09-' + String(i + 1).padStart(2, '0'));
    const analyzed = await create(708.24, '2026-10-15');
    const previous = await AvaliacaoService.calcular(
      actor.usuario_id,
      analyzed.compra_id,
      {},
    );
    const persistedBefore = await client.tb_rf018_avaliacao.findMany({
      where: { compra_id: analyzed.compra_id },
    });
    let a = await A.compra(actor.usuario_id, analyzed.compra_id);
    assert.equal(a.estado, 'SINAIS_RELEVANTES');
    assert.equal(a.contextoDeclarado.revisao, 0);
    check(
      'A: avaliação automática real identifica valor atípico sem respostas nem classificação',
    );
    await C.atualizar(actor.usuario_id, analyzed.compra_id, {
      versaoContrato: 1,
      operacaoId: randomUUID(),
      revisaoEsperada: 0,
      respostas: { planejamento: 'SIM' },
      itens: [],
    });
    const planned = await A.compra(actor.usuario_id, analyzed.compra_id);
    assert.deepEqual(planned.evidencias, a.evidencias);
    assert.match(planned.contextualizacao, /planejada/);
    check(
      'B: planejamento persistido complementa a avaliação sem apagar fatos',
    );
    for (let i = 0; i < 10; i++) await create(15 + i, '2026-10-05');
    a = await A.compra(actor.usuario_id, analyzed.compra_id);
    assert.equal(a.estado, 'COMBINACAO_SINAIS_RELEVANTES');
    check(
      'C: atualização do histórico produz composição real com duas famílias distintas',
    );
    const fresh = await client.tb_usuario.create({
      data: {
        usuario_email: 'sem-historico@example.invalid',
        usuario_nome: 'Sem histórico',
        usuario_senha: 'sintetica-sem-uso-real',
      },
    });
    const lone = await client.tb_compra.create({
      data: {
        usuario_id: fresh.usuario_id,
        compra_classificacao: 'PENDENTE',
        compra_horario: new Date('2026-10-15T00:00:00Z'),
        compra_valor: 450,
        compra_email: false,
      },
    });
    assert.equal(
      (await A.compra(fresh.usuario_id, lone.compra_id)).estado,
      'DADOS_INSUFICIENTES',
    );
    check(
      'D: banco sem histórico retorna insuficiência, sem simular ausência de sinais',
    );
    const duplicated = await create(9999, '2026-10-05');
    const withDuplicate = await A.compra(actor.usuario_id, analyzed.compra_id);
    await E.registrar(actor.usuario_id, duplicated.compra_id, {
      versaoContrato: 1,
      operacaoId: randomUUID(),
      revisaoEsperada: 0,
      tipo: 'EXCLUSAO_REGISTRO',
      motivo: 'DUPLICADO',
      dataEfetiva: null,
    });
    const afterDelete = await A.compra(actor.usuario_id, analyzed.compra_id);
    assert.equal(
      afterDelete.qualidadeDados.registrosElegiveis,
      withDuplicate.qualidadeDados.registrosElegiveis - 1,
    );
    assert.notEqual(
      afterDelete.dependencias.fontesHash,
      withDuplicate.dependencias.fontesHash,
    );
    check('E: exclusão por duplicidade recalcula elegibilidade e fingerprint');
    const cancel = await E.registrar(actor.usuario_id, analyzed.compra_id, {
      versaoContrato: 1,
      operacaoId: randomUUID(),
      revisaoEsperada: 0,
      tipo: 'CANCELAMENTO',
      dataEfetiva: '2026-10-20',
    });
    const returned = await E.registrar(actor.usuario_id, analyzed.compra_id, {
      versaoContrato: 1,
      operacaoId: randomUUID(),
      revisaoEsperada: cancel.evento.revisao,
      tipo: 'DEVOLUCAO',
      dataEfetiva: '2026-10-21',
    });
    const returnedMoney = await E.registrar(
      actor.usuario_id,
      analyzed.compra_id,
      {
        versaoContrato: 1,
        operacaoId: randomUUID(),
        revisaoEsperada: returned.evento.revisao,
        tipo: 'REEMBOLSO',
        valorCentavos: 3000,
        dataEfetiva: '2026-10-24',
      },
    );
    const afterEvents = await A.compra(actor.usuario_id, analyzed.compra_id);
    assert.deepEqual(afterEvents.evidencias, afterDelete.evidencias);
    assert.equal(afterEvents.eventos.cancelamentos, 1);
    assert.equal(afterEvents.eventos.devolucoes, 1);
    assert.equal(afterEvents.eventos.reembolsadoCentavos, 3000);
    check(
      'F: cancelamento, devolução e reembolso reais preservam decisão e evidências separadas',
    );
    await R.registrar(
      actor.usuario_id,
      {
        versaoContrato: 1,
        operacaoId: randomUUID(),
        tipo: 'LIMITE_COMPRA',
        valorCentavos: 65000,
        aplicacao: 'AGORA',
      },
      new Date('2026-10-10T12:00:00Z'),
    );
    await R.registrar(
      actor.usuario_id,
      {
        versaoContrato: 1,
        operacaoId: randomUUID(),
        tipo: 'LIMITE_COMPRA',
        valorCentavos: 90000,
        aplicacao: 'AGORA',
      },
      new Date('2026-10-25T12:00:00Z'),
    );
    const afterLimit = await A.compra(actor.usuario_id, analyzed.compra_id);
    assert.equal(
      afterLimit.evidencias.find((e) => e.indicador === 'V03').referencia,
      65000,
    );
    assert.equal(afterLimit.referenciasFinanceiras.limiteAtualCentavos, 90000);
    check(
      'G: limite da época comprovado participa, limite atual permanece informativo',
    );
    await C.atualizar(actor.usuario_id, analyzed.compra_id, {
      versaoContrato: 1,
      operacaoId: randomUUID(),
      revisaoEsperada: 1,
      respostas: { autopercepcaoImpulsividade: 'NAO' },
      itens: [],
    });
    const perceived = await A.compra(actor.usuario_id, analyzed.compra_id);
    assert.equal(
      perceived.contextoDeclarado.respostas.autopercepcaoImpulsividade,
      'NAO',
    );
    assert.equal(perceived.estado, afterLimit.estado);
    assert.equal(perceived.contextoDeclarado.revisao, 2);
    check(
      'H: percepção divergente e revisão permanecem separadas da observação automática',
    );
    assert.deepEqual(
      await client.tb_rf018_avaliacao.findMany({
        where: { compra_id: analyzed.compra_id },
      }),
      persistedBefore,
    );
    assert.ok(previous.avaliacaoId);
    check(
      'avaliação contextual persistida anterior permanece byte a byte equivalente',
    );
    const authorization = jwt.sign(
        { userId: actor.usuario_id },
        process.env.JWT_SECRET,
        { expiresIn: '5m' },
      ),
      authHeaders = { authorization: 'Bearer ' + authorization };
    const automaticPath = `/analises/compras/${analyzed.compra_id}/automatica`;
    assert.equal((await fetch(base + automaticPath)).status, 401);
    assert.equal((await fetch(base + automaticPath, { headers })).status, 404);
    assert.equal(
      (await fetch(base + automaticPath + '?extra=1', { headers: authHeaders }))
        .status,
      400,
    );
    check(
      'HTTP automático exige autenticação, isola usuário e valida parâmetros',
    );
    const actualMobile = await consultarAnaliseAutomatica({
      compraId: analyzed.compra_id,
      session,
      storage: options.storage,
      client: {
        get: async (url) => {
          const response = await fetch(base + url, { headers: authHeaders });
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          return { data: await response.json() };
        },
      },
    });
    assert.equal(actualMobile.estado, 'COMBINACAO_SINAIS_RELEVANTES');
    check(
      'contrato do Mobile real validado contra endpoint automático e PostgreSQL reais',
    );
    const summary = await fetch(
      base + '/analises/descobertas?periodo=2026-10',
      { headers: authHeaders },
    );
    assert.equal(summary.status, 200);
    const d = await summary.json();
    assert.equal(d.avaliacaoAutomatica.estado, 'COMBINACAO_SINAIS_RELEVANTES');
    assert.equal(d.descobertas[0].id, 'MUDANCAS_NOS_REGISTROS');
    assert.doesNotMatch(
      JSON.stringify(d.avaliacaoAutomatica),
      /compra_id|compra_fonte|Item sintético/,
    );
    check('Home/Dashboard recebem descoberta composta sem detalhes privados');
    await E.registrar(actor.usuario_id, analyzed.compra_id, {
      versaoContrato: 1,
      operacaoId: randomUUID(),
      revisaoEsperada: returnedMoney.evento.revisao,
      tipo: 'CLASSIFICACAO',
      classificacao: 'IMPULSIVA',
      dataEfetiva: null,
    });
    const classified = await A.compra(actor.usuario_id, analyzed.compra_id);
    assert.equal(classified.classificacaoAutomaticaDefinitiva, false);
    assert.equal(classified.estado, actualMobile.estado);
    check(
      'classificação voluntária não é regravada ou utilizada como resultado automático',
    );
  }
  // Additional revision checks use a separate synthetic purchase, leaving previous scenarios intact.
  const revisionPurchase = await client.tb_compra.create({
    data: {
      usuario_id: user.usuario_id,
      compra_classificacao: 'PENDENTE',
      compra_horario: new Date('2026-10-15T12:00:00Z'),
      compra_valor: 100,
      compra_email: false,
      tb_compra_item: {
        create: {
          compra_item_nome: 'Item de revisão',
          compra_item_valor: 100,
          compra_item_quantidade: 1,
        },
      },
    },
    include: { tb_compra_item: true },
  });
  const rp = revisionPurchase.compra_id,
    ri = revisionPurchase.tb_compra_item[0].compra_item_id;
  const { AvaliacaoService: Assess } = await import(
    '../src/modules/rf018/avaliacao.service.ts'
  );
  await C.atualizar(user.usuario_id, rp, {
    versaoContrato: 1,
    operacaoId: randomUUID(),
    revisaoEsperada: 0,
    respostas: { planejamento: 'NAO', influenciaPromocional: 'SIM' },
    itens: [{ itemId: ri, planejamento: 'NAO' }],
  });
  const initialAssessment = await Assess.calcular(user.usuario_id, rp, {
    revisaoEsperada: 1,
  });
  const originalAssessment = await client.tb_rf018_avaliacao.findUnique({
    where: { avaliacao_id: initialAssessment.avaliacaoId },
  });
  await C.atualizar(user.usuario_id, rp, {
    versaoContrato: 1,
    operacaoId: randomUUID(),
    revisaoEsperada: 1,
    respostas: { planejamento: 'SIM', influenciaPromocional: 'NAO' },
    itens: [{ itemId: ri, planejamento: 'SIM' }],
  });
  assert.equal(
    (await Assess.consultar(user.usuario_id, rp)).atualidade,
    'DESATUALIZADA',
  );
  const revisedAssessment = await Assess.calcular(user.usuario_id, rp, {
    revisaoEsperada: 2,
  });
  assert.notEqual(revisedAssessment.avaliacaoId, initialAssessment.avaliacaoId);
  assert.doesNotMatch(
    revisedAssessment.resultado.interpretacao.reflexao,
    /promoção/,
  );
  assert.deepEqual(
    await client.tb_rf018_avaliacao.findUnique({
      where: { avaliacao_id: initialAssessment.avaliacaoId },
    }),
    originalAssessment,
  );
  check(
    'revisão contextual atualiza reflexão sem sobrescrever avaliação histórica',
  );
  const revisions = await C.historico(user.usuario_id, rp);
  assert.deepEqual(
    revisions.revisoes.map((r) => r.respostas.planejamento),
    ['SIM', 'NAO'],
  );
  assert.ok(
    revisions.revisoes.every((r) => r.criadaEm && r.itens[0].itemId === ri),
  );
  await assert.rejects(
    C.historico(other.usuario_id, rp),
    (e) => e.statusCode === 404,
  );
  check('histórico real preserva resposta, item, data e isolamento');
  const { AutomaticoService: Auto } = await import(
    '../src/modules/rf018/automatico.service.ts'
  );
  const beforeClassification = await Auto.compra(user.usuario_id, rp);
  let cr = 0;
  for (const classificacao of ['IMPULSIVA', 'NAO_IMPULSIVA', 'IMPULSIVA']) {
    const result = await E.registrar(user.usuario_id, rp, {
      versaoContrato: 1,
      operacaoId: randomUUID(),
      revisaoEsperada: cr,
      tipo: 'CLASSIFICACAO',
      classificacao,
      dataEfetiva: null,
    });
    cr = result.evento.revisao;
    assert.equal(
      (await E.consultar(user.usuario_id, rp)).resumo.classificacao,
      classificacao,
    );
    assert.deepEqual(
      (await Auto.compra(user.usuario_id, rp)).evidencias,
      beforeClassification.evidencias,
    );
  }
  assert.equal(
    await client.tb_compra_evento.count({
      where: { compra_id: rp, tipo: 'CLASSIFICACAO' },
    }),
    3,
  );
  check(
    'classificação nos dois sentidos preserva três eventos e não altera sinais automáticos',
  );
  await E.registrar(user.usuario_id, rp, {
    versaoContrato: 1,
    operacaoId: randomUUID(),
    revisaoEsperada: cr,
    tipo: 'EXCLUSAO_REGISTRO',
    itemId: ri,
    motivo: 'INCORRETO',
    dataEfetiva: null,
  });
  assert.equal(
    (await C.historico(user.usuario_id, rp)).revisoes[1].itens[0].planejamento,
    'NAO',
  );
  check(
    'item incorreto sai da análise vigente mas permanece no histórico contextual',
  );
  report.sucesso = true;
} catch (e) {
  report.sucesso = false;
  report.erro = String(e.stack ?? e);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await client?.$disconnect().catch(() => {});
  await pool?.end().catch(() => {});
  if (started) {
    await run('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop']);
    report.clusterParado = true;
  }
  await writeFile(
    motorAutomatico
      ? '.validation/validacao-motor-automatico-postgres-local.json'
      : '.validation/validacao-gestao-postgres-local.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
}
