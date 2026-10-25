import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
let rows,
  recurrences,
  active,
  fail,
  calls,
  assessments,
  consent,
  usageRows,
  usageCalls,
  failUsage;
const clone = (value) => structuredClone(value);
const db = {
  tb_consentimento: {
    findFirst: async ({ where }) => {
      assert.equal(where.usuario_id, 1);
      assert.equal(where.consentimento_status, true);
      return consent;
    },
  },
  tb_tempo_uso: {
    findMany: async ({ where }) => {
      usageCalls++;
      assert.equal(where.usuario_id, 1);
      assert.equal(where.tempo_uso_origem, 'ANDROID_USAGE_STATS');
      if (failUsage) throw Error('private-usage-error');
      return usageRows;
    },
  },
  tb_usuario: {
    findFirst: async ({ where }) =>
      active && where.usuario_id === 1
        ? {
            usuario_id: 1,
            usuario_meta_valor_mensal: '500',
            usuario_meta_valor_compra: '80',
            usuario_data_criacao: new Date('2025-01-01T00:00:00Z'),
          }
        : null,
  },
  tb_compra: {
    findMany: async ({ where, select }) => {
      calls.push({ where, select });
      if (fail) throw Error('private-history-database-failure');
      return clone(
        rows
          .filter(
            (r) =>
              r.usuario_id === where.usuario_id &&
              r.compra_ativo === where.compra_ativo &&
              r.compra_status === where.compra_status &&
              r.compra_horario >= where.compra_horario.gte &&
              r.compra_horario < where.compra_horario.lt,
          )
          .map((r) => ({
            ...r,
            tb_compra_item: r.tb_compra_item.filter(
              (i) => i.compra_item_ativo === 1,
            ),
            tb_rf018_contexto_revisao: [...r.tb_rf018_contexto_revisao]
              .sort((a, b) => b.revisao - a.revisao)
              .slice(0, 1),
          })),
      );
    },
    findFirst: async ({ where }) => {
      const r = rows.find(
        (r) =>
          r.compra_id === where.compra_id &&
          r.usuario_id === where.usuario_id &&
          r.compra_ativo === 1,
      );
      return r
        ? clone({ ...r, tb_usuario: { usuario_meta_valor_compra: '80' } })
        : null;
    },
    update: async () => {
      throw Error('NO_WRITES_ALLOWED');
    },
  },
  tb_compra_recorrencia: {
    findMany: async ({ where }) =>
      clone(recurrences.filter((r) => r.usuario_id === where.usuario_id)),
  },
  tb_rf018_contexto_revisao: {
    findFirst: async ({ where }) =>
      clone(
        rows
          .find(
            (r) =>
              r.compra_id === where.compra_id &&
              r.usuario_id === where.usuario_id,
          )
          ?.tb_rf018_contexto_revisao.at(-1) ?? null,
      ),
  },
  tb_rf018_avaliacao: {
    findFirst: async ({ where }) =>
      clone(
        assessments
          .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
          .at(-1) ?? null,
      ),
    upsert: async ({ create }) => {
      const r = {
        ...clone(create),
        avaliacao_id: assessments.length + 1,
        criada_em: new Date('2026-10-24T12:00:00Z'),
      };
      assessments.push(r);
      return clone(r);
    },
  },
  $transaction: async (callback, options) => {
    assert.equal(options.isolationLevel, 'RepeatableRead');
    return callback(db);
  },
};
globalThis.prismaRuntime = { client: db, pool: { end: async () => {} } };
const { HistoricoService } = await import(
  '../../src/modules/rf018/historico.service.ts'
);
const { AvaliacaoService } = await import(
  '../../src/modules/rf018/avaliacao.service.ts'
);
const { analisesRouter } = await import(
  '../../src/modules/rf018/rf018.routes.ts'
);
const { contextoRouter } = await import(
  '../../src/modules/rf018/contexto.routes.ts'
);
const now = new Date('2026-10-24T12:00:00Z');
const row = (id, date = '2026-10-05T12:00:00Z', extra = {}) => ({
  compra_id: id,
  usuario_id: 1,
  compra_ativo: 1,
  compra_status: 'CONFIRMADA',
  compra_horario: new Date(date),
  compra_valor: '100',
  compra_desconto: '20',
  compra_email: false,
  compra_recorrencia_id: null,
  tb_compra_item: [
    {
      compra_item_id: id * 10,
      categoria_id: 2,
      compra_item_nome: 'Livro',
      compra_item_ativo: 1,
      compra_item_valor: '100',
      compra_item_quantidade: null,
    },
  ],
  tb_rf018_contexto_revisao: [],
  ...extra,
});
let server, base;
test.before(async () => {
  const app = express();
  app.use('/analises', analisesRouter);
  app.use('/v2/compras', contextoRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
test.beforeEach(() => {
  rows = [];
  recurrences = [];
  active = true;
  fail = false;
  calls = [];
  assessments = [];
  consent = null;
  usageRows = [];
  usageCalls = 0;
  failUsage = false;
});
const token = () =>
  jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
const request = (
  path = '/analises/historico?periodo=2020-01',
  auth = token(),
) =>
  fetch(base + path, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
  });
const consult = (periodo = '2026-10') =>
  HistoricoService.consultar(1, { periodo }, now);

test('existing contextual-1 persisted assessment stays current and byte-equivalent after independent history changes', async () => {
  rows = [
    row(1),
    row(2, '2026-09-02T00:00:00Z'),
    row(3, '2026-10-02T00:00:00Z'),
  ];
  const assessment = await AvaliacaoService.calcular(1, 1, {});
  const before = clone(assessments);
  await HistoricoService.complementarCompra(1, 1, now);
  rows[1].compra_ativo = 0;
  rows[2].compra_valor = '900';
  recurrences = [
    {
      compra_recorrencia_id: 1,
      usuario_id: 1,
      compra_recorrencia_status: 'PAUSADA',
    },
  ];
  await HistoricoService.complementarCompra(1, 1, now);
  assert.deepEqual(await AvaliacaoService.consultar(1, 1), assessment);
  assert.equal(assessment.atualidade, 'VIGENTE');
  assert.deepEqual(assessments, before);
});

test('automatic findings exist without answers; optional Android source obeys consent and failures preserve financial history', async () => {
  rows = [row(1), row(2, '2026-09-02T00:00:00Z')];
  const first = await HistoricoService.complementarCompra(1, 1, now);
  assert.ok(first.descobertas.itens.length);
  assert.equal(first.contextual.declaracoes.length, 0);
  assert.equal(first.monitoramento.disponibilidade, 'SEM_AUTORIZACAO');
  assert.equal(usageCalls, 0);
  consent = { consentimento_data_criacao: new Date('2026-10-01') };
  failUsage = true;
  const failed = await HistoricoService.complementarCompra(1, 1, now);
  assert.equal(failed.monitoramento.disponibilidade, 'INDISPONIVEL');
  assert.equal(failed.historico.qualidade.comprasHistorico, 1);
  assert.ok(failed.descobertas.itens.length);
  assert.ok(!JSON.stringify(failed).includes('private-usage-error'));
});

test('persisted event metadata reaches automatic findings and historical coverage without becoming a planning answer or financial adjustment', async () => {
  rows = [
    row(1, undefined, {
      tb_rf018_contexto_revisao: [
        {
          revisao: 1,
          respostas: {
            __rf018_eventos_v1: { versao: 1, eventos: ['DEVOLUCAO'] },
          },
          itens: [],
        },
      ],
    }),
    row(2, '2026-09-02T00:00:00Z', {
      tb_rf018_contexto_revisao: [
        {
          revisao: 1,
          respostas: {
            __rf018_eventos_v1: { versao: 1, eventos: ['ARREPENDIMENTO'] },
          },
          itens: [],
        },
      ],
    }),
  ];
  const before = clone(rows);
  const r = await HistoricoService.complementarCompra(1, 1, now);
  assert.deepEqual(r.descobertas.eventosPosteriores, ['DEVOLUCAO']);
  assert.equal(r.descobertas.itens[0].codigo, 'EVENTO_DECLARADO');
  assert.equal(r.historico.eventosPosteriores.comprasComDeclaracao, 1);
  assert.equal(r.historico.eventosPosteriores.contagens.ARREPENDIMENTO, 1);
  assert.equal(r.historico.planejamento.historico.conhecidas, 0);
  assert.equal(r.historico.financeiro.totalConhecido, 0);
  assert.equal(r.comparacaoValorCompra.valorLiquidoCentavos, 10000);
  assert.deepEqual(rows, before);
  assert.deepEqual(assessments, []);
});

test('historical dependency fingerprint refreshes changes without writing individual assessments', async () => {
  rows = [
    row(1),
    row(2, '2026-09-02T00:00:00Z'),
    row(3, '2026-10-02T00:00:00Z'),
  ];
  const get = () => HistoricoService.complementarCompra(1, 1, now);
  const original = await get();
  const hash = (r) => r.dependenciasHistoricas.fontesHash;
  const later = await HistoricoService.complementarCompra(
    1,
    1,
    new Date('2026-10-25T12:00:00Z'),
  );
  assert.equal(hash(original), hash(later));
  assert.notEqual(original.consultadoEm, later.consultadoEm);
  rows[1].compra_valor = '300';
  let updated = await get();
  assert.notEqual(hash(original), hash(updated));
  const financial = hash(updated);
  rows[1].compra_ativo = 0;
  updated = await get();
  assert.notEqual(financial, hash(updated));
  assert.equal(updated.reflexoesHistoricas.estado, 'DADOS_INSUFICIENTES');
  rows[1].compra_ativo = 1;
  const restored = await get();
  recurrences = [
    {
      compra_recorrencia_id: 1,
      usuario_id: 1,
      compra_recorrencia_status: 'ATIVA',
    },
  ];
  updated = await get();
  assert.notEqual(hash(restored), hash(updated));
  assert.ok(
    updated.reflexoesHistoricas.itens.some((i) => i.codigo === 'RECORRENCIAS'),
  );
  const prior = hash(updated);
  rows[2].tb_rf018_contexto_revisao = [
    { revisao: 1, respostas: { planejamento: 'SIM' }, itens: [] },
  ];
  assert.notEqual(prior, hash(await get()));
  rows[0].compra_horario = new Date('2026-09-10T00:00:00Z');
  updated = await get();
  assert.equal(updated.dependenciasHistoricas.periodo, '2026-09');
  assert.equal(updated.historico.qualidade.comprasAtual, 1);
  assert.deepEqual(
    original.contextual,
    (await HistoricoService.complementarCompra(1, 1, now)).contextual,
  );
});

test('historical queries are bounded, user-owned, active/confirmed, in a consistent read snapshot', async () => {
  rows = [
    row(1),
    row(2, undefined, { usuario_id: 2 }),
    row(3, undefined, { compra_ativo: 0 }),
    row(4, undefined, { compra_status: 'AGUARDANDO_CONFIRMACAO' }),
    row(5, '2026-10-25T00:00:00Z'),
  ];
  const r = await consult();
  assert.equal(r.frequencia.compras, 1);
  assert.equal(r.financeiro.totalConhecido, 100);
  assert.equal(calls[0].where.usuario_id, 1);
  assert.equal(calls[0].where.compra_ativo, 1);
  assert.equal(calls[0].where.compra_status, 'CONFIRMADA');
  assert.equal(
    calls[0].where.compra_horario.gte.toISOString(),
    '2026-04-01T00:00:00.000Z',
  );
  assert.equal(
    calls[0].where.compra_horario.lt.toISOString(),
    now.toISOString(),
  );
  assert.equal(calls[0].select.tb_rf018_contexto_revisao.take, 1);
});

test('liquid amount is not reduced by stored discount; email origins retain day-only precision', async () => {
  rows = [
    row(1, undefined, {
      compra_email: true,
      compra_valor: '19.90',
      compra_desconto: '10',
    }),
    row(2, '2026-10-06T12:00:00Z'),
  ];
  const r = await consult();
  assert.equal(r.financeiro.totalConhecido, 119.9);
  assert.equal(r.qualidade.importadasEmailAtual, 1);
  assert.equal(r.intervalos.pares[0].segundosExatos, null);
  assert.equal(r.politicaTemporal.compras.datasDeMensagemEmail, 1);
  assert.equal(r.politicaTemporal.compras.continuidadeComprovada, false);
  assert.equal(calls[0].select.compra_data_criacao, true);
  assert.equal(
    calls[0].select.tb_rf018_contexto_revisao.select.criada_em,
    true,
  );
});

test('latest revision is used once and inactive item answers never enter item denominators', async () => {
  rows = [
    row(1, undefined, {
      tb_rf018_contexto_revisao: [
        { revisao: 1, respostas: { planejamento: 'SIM' }, itens: [] },
        {
          revisao: 2,
          respostas: {
            planejamento: 'NAO',
            influenciaPromocional: 'PREFIRO_NAO_RESPONDER',
          },
          itens: [
            { compra_item_id: 10, planejamento: 'SIM' },
            { compra_item_id: 99, planejamento: 'NAO' },
          ],
        },
      ],
    }),
  ];
  const r = await consult();
  assert.equal(r.planejamento.contagens.NAO, 1);
  assert.equal(r.planejamento.contagens.SIM, 0);
  assert.equal(r.planejamento.porItem.conhecidas, 1);
  assert.equal(r.planejamento.porItem.contagens.NAO, 0);
  assert.equal(r.influenciaPromocional.conhecidas, 0);
  assert.deepEqual(r.qualidade.revisoesUtilizadas, [
    { compraId: 1, revisao: 2 },
  ]);
});

test('past period never receives current monthly budget and recurrence catalog is user-scoped', async () => {
  rows = [row(1, '2026-09-05T00:00:00Z', { compra_recorrencia_id: 1 })];
  recurrences = [
    {
      compra_recorrencia_id: 1,
      usuario_id: 1,
      compra_recorrencia_status: 'PAUSADA',
    },
    {
      compra_recorrencia_id: 2,
      usuario_id: 2,
      compra_recorrencia_status: 'ATIVA',
    },
  ];
  const r = await consult('2026-09');
  assert.equal(r.financeiro.orcamentoMensal, null);
  assert.equal(r.recorrencias.cadastradas, 1);
  assert.equal(r.recorrencias.comprasVinculadasAtual, 1);
});

test('read-only contextual complement excludes target, later purchases and same-day events', async () => {
  rows = [
    row(1),
    row(2, '2026-09-05T00:00:00Z', { compra_valor: '10' }),
    row(3, '2026-09-06T00:00:00Z', { compra_valor: '30' }),
    row(4, '2026-10-05T01:00:00Z'),
    row(5, '2026-10-06T00:00:00Z'),
  ];
  const before = clone(rows);
  const result = await HistoricoService.complementarCompra(1, 1, now);
  assert.equal(result.contextual.versaoMotor, 'contextual-2');
  assert.equal(result.persistido, false);
  assert.equal(result.historico.qualidade.comprasHistorico, 2);
  assert.equal(result.historico.qualidade.comprasAtual, 0);
  assert.equal(result.comparacaoValorCompra.medianaHistoricaCentavos, 2000);
  assert.equal(result.comparacaoValorCompra.diferencaCentavos, 8000);
  assert.deepEqual(rows, before);
});

test('first-day purchase supports an empty current window and never includes itself', async () => {
  rows = [row(1, '2026-10-01T12:00:00Z'), row(2, '2026-09-05T00:00:00Z')];
  const result = await HistoricoService.complementarCompra(1, 1, now);
  assert.equal(result.historico.frequencia.diasObservados, 0);
  assert.equal(result.historico.frequencia.comprasPorDia, null);
});

test('purchase value reference also includes earlier days of its own month, never the target day', async () => {
  rows = [
    row(1),
    row(2, '2026-10-01T00:00:00Z', { compra_valor: '10' }),
    row(3, '2026-10-02T00:00:00Z', { compra_valor: '30' }),
  ];
  const result = await HistoricoService.complementarCompra(1, 1, now);
  assert.equal(result.comparacaoValorCompra.amostra, 2);
  assert.equal(result.comparacaoValorCompra.medianaHistoricaCentavos, 2000);
  assert.equal(result.comparacaoValorCompra.disponibilidade, 'PARCIAL');
});

test('foreign inactive pending and future purchases cannot get contextual historical complement', async () => {
  for (const extra of [{ usuario_id: 2 }, { compra_ativo: 0 }]) {
    rows = [row(1, undefined, extra)];
    await assert.rejects(
      HistoricoService.complementarCompra(1, 1, now),
      (error) => error.statusCode === 404,
    );
  }
  rows = [row(1, undefined, { compra_status: 'AGUARDANDO_CONFIRMACAO' })];
  await assert.rejects(
    HistoricoService.complementarCompra(1, 1, now),
    (error) => error.statusCode === 409,
  );
  rows = [row(1, '2026-11-01T00:00:00Z')];
  await assert.rejects(
    HistoricoService.complementarCompra(1, 1, now),
    (error) => error.statusCode === 409,
  );
});

test('HTTP authentication, strict queries, versions and no-store are enforced', async () => {
  assert.equal((await request(undefined, null)).status, 401);
  assert.equal((await request(undefined, 'bad')).status, 401);
  for (const query of [
    '',
    '?periodo=2026-13',
    '?periodo=2020-01&usuarioId=2',
    '?periodo=2020-01&mesesHistorico=0',
    '?periodo=2020-01&mesesHistorico=13',
    '?periodo=2020-01&periodo=2020-02',
    '?periodo=9999-01',
  ]) {
    assert.equal((await request('/analises/historico' + query)).status, 400);
  }
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).versaoIndicadores, 'historicos-1');
  active = false;
  assert.equal((await request()).status, 401);
});

test('HTTP purchase complement validates ownership, params and no-store; internal failures are sanitized', async () => {
  rows = [row(1, '2020-01-05T00:00:00Z')];
  assert.equal(
    (await request('/v2/compras/0/indicadores-historicos')).status,
    400,
  );
  assert.equal(
    (await request('/v2/compras/1/indicadores-historicos?usuarioId=2')).status,
    400,
  );
  const response = await request('/v2/compras/1/indicadores-historicos');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(
    (await response.json()).versaoComplemento,
    'contextual-historico-1',
  );
  fail = true;
  const failure = await request();
  assert.equal(failure.status, 500);
  assert.doesNotMatch(
    await failure.text(),
    /private-history|DATABASE|postgresql/,
  );
});

test('invalid persisted context fails as a sanitized server error, never a client validation error', async () => {
  rows = [
    row(1, '2020-01-05T00:00:00Z', {
      tb_rf018_contexto_revisao: [
        { revisao: 1, respostas: { privateField: 'private-value' }, itens: [] },
      ],
    }),
  ];
  const response = await request();
  assert.equal(response.status, 500);
  assert.doesNotMatch(
    await response.text(),
    /privateField|private-value|CONTEXT_INVALID/,
  );
});
