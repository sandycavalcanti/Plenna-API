import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
globalThis.prismaRuntime = {
  client: {
    tb_usuario: {
      findFirst: async ({ where }) => ({ usuario_id: where.usuario_id }),
    },
  },
  pool: { end: async () => {} },
};
const { analisarHistorico } = await import(
  '../../src/modules/rf018/historico.engine.ts'
);
const { apresentarDescobertas } = await import(
  '../../src/modules/rf018/descobertas.resumo.ts'
);
const { DescobertasService } = await import(
  '../../src/modules/rf018/descobertas.service.ts'
);
const { HomeService } = await import('../../src/modules/home/home.service.ts');
const { HistoricoService } = await import(
  '../../src/modules/rf018/historico.service.ts'
);
const { analisesRouter } = await import(
  '../../src/modules/rf018/rf018.routes.ts'
);
const { responderIndicadores, consultarRespostaIndicadores } = await import(
  '../../src/modules/chat/chat.indicadores.ts'
);
const row = (id, date = '2026-10-05', extra = {}) => ({
  id,
  usuarioId: 1,
  ativa: true,
  status: 'CONFIRMADA',
  data: date + 'T12:00:00Z',
  precisao: 'DIA',
  valorLiquido: '100',
  origem: 'MANUAL',
  categorias: [2],
  recorrenciaId: null,
  contexto: null,
  ...extra,
});
const history = (compras = [], extra = {}) =>
  analisarHistorico({
    usuarioId: 1,
    periodo: '2026-10',
    mesesHistorico: 6,
    observadoAte: '2026-10-15T12:00:00Z',
    orcamentoAtual: null,
    compras,
    ...extra,
  });
const originalHome = HomeService.consultar,
  originalHistory = HistoricoService.consultar;
test.afterEach(() => {
  HomeService.consultar = originalHome;
  HistoricoService.consultar = originalHistory;
});
test('empty or insufficient history never invents findings or comparisons', () => {
  assert.deepEqual(apresentarDescobertas(history()), []);
  assert.deepEqual(apresentarDescobertas(history([row(1)])), []);
});
test('declarations exclude refusals and absent answers; recurrence is a registered relation', () => {
  const h = history([
    row(1, '2026-10-05', {
      contexto: {
        revisao: 1,
        respostas: { planejamento: 'PREFIRO_NAO_RESPONDER' },
        itens: [],
      },
    }),
    row(2, '2026-10-06', {
      contexto: {
        revisao: 1,
        respostas: { planejamento: 'NAO', influenciaPromocional: 'SIM' },
        itens: [],
      },
    }),
  ]);
  const findings = apresentarDescobertas(h);
  assert.equal(findings.length, 2);
  assert.match(findings[0].informacao, /1 respostas conhecidas/);
  assert.ok(findings.every((d) => d.tipo === 'DECLARADO'));
  const recurring = apresentarDescobertas(
    history([row(1, undefined, { recorrenciaId: 9 })]),
  );
  assert.equal(recurring[0].id, 'RECORRENCIAS');
  assert.equal(recurring[0].tipo, 'REGISTRADO');
});
test('valid equal windows permit a factual comparison; excluded records do not contribute', () => {
  const rows = [
    row(1),
    row(2, '2026-10-06'),
    row(3, '2026-09-05'),
    row(4, undefined, { ativa: false }),
    row(5, undefined, { status: 'AGUARDANDO_CONFIRMACAO' }),
  ];
  assert.ok(
    !apresentarDescobertas(history(rows)).some((d) => d.id === 'FREQUENCIA'),
  );
  const findings = apresentarDescobertas(
    history(rows, { cobertura: 'COMPLETA' }),
  );
  assert.equal(findings[0].id, 'FREQUENCIA');
  assert.match(findings[0].informacao, /2 agora · 1 antes/);
  assert.ok(findings.length <= 2);
  assert.ok(findings.every((d) => d.evidencias.length && d.compraId === null));
});
test('aggregate endpoint isolates the authenticated user, remains available on partial failure and emits no raw records', async () => {
  const calls = [];
  HomeService.consultar = async (user, periodo) => {
    calls.push([user, periodo]);
    throw Error('private-server-error');
  };
  HistoricoService.consultar = async (user, query) => {
    calls.push([user, query.periodo]);
    return history([row(1, undefined, { recorrenciaId: 2 })]);
  };
  const app = express();
  app.use('/analises', analisesRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/analises/descobertas?periodo=2026-10`;
    assert.equal((await fetch(base)).status, 401);
    assert.equal(calls.length, 0);
    const token = jwt.sign({ userId: 27 }, process.env.JWT_SECRET, {
      expiresIn: '5m',
    });
    const response = await fetch(base, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const d = await response.json();
    assert.deepEqual(d.indisponiveis, ['FINANCEIRO']);
    assert.equal(d.descobertas[0].id, 'RECORRENCIAS');
    assert.deepEqual(calls, [
      [27, '2026-10'],
      [27, '2026-10'],
    ]);
    assert.doesNotMatch(
      JSON.stringify(d),
      /private-server-error|compra_id|compra_fonte/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test('chat answers use evidence, never diagnose or count refusals; missing sources remain unavailable', async () => {
  HomeService.consultar = async () => {
    throw Error('unavailable');
  };
  HistoricoService.consultar = async () => history();
  assert.equal(await consultarRespostaIndicadores(1, 'Olá'), null);
  assert.match(
    await consultarRespostaIndicadores(1, 'Estou comprando mais do que antes?'),
    /não há períodos comparáveis/,
  );
  const control = await consultarRespostaIndicadores(
    1,
    'Meu comportamento está ficando compulsivo?',
  );
  assert.match(control, /não determinam/);
  assert.match(control, /não tenho respostas suficientes/);
  assert.match(
    responderIndicadores('Quais compras ultrapassam meu orçamento?', null),
    /Não consegui consultar/,
  );
  assert.match(
    await consultarRespostaIndicadores(1, 'frequência 2026-09 e 2026-10'),
    /um período por vez/,
  );
});
