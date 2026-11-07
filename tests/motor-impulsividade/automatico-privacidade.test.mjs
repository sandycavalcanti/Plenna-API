import test from 'node:test';
import assert from 'node:assert/strict';
const now = new Date('2026-10-25T12:00:00Z');
const purchase = (id, value = 10) => ({
  compra_id: id, usuario_id: 1, compra_ativo: 1, compra_status: 'CONFIRMADA',
  compra_horario: new Date(id === 99 ? '2026-10-15T12:00:00Z' : '2026-09-10T12:00:00Z'),
  compra_valor: String(value), compra_email: false, compra_recorrencia_id: null,
  tb_compra_item: [{ compra_item_id: id * 10, categoria_id: 1, tb_categoria: { categoria_nome: 'Privado' } }], contexto_compra_revisao: [],
});
let rows, events, calls;
function reset(size = 6) {
  rows = Array.from({ length: size }, (_, i) => purchase(i + 1000, (i % 6 + 1) * 10));
  rows.push(purchase(99, 450)); events = []; calls = [];
}
const event = (compra_id, tipo, extra = {}) => ({
  compra_id, evento_id: events.length + 1, compra_item_id: null, tipo, dados: {},
  corrige_evento_id: null, anulado: false, revisao: events.length + 1, efetiva_em: null, ...extra,
});
const db = {
  tb_usuario: { findFirst: async ({ where }) => { calls.push('user'); assert.equal(where.usuario_id, 1); return { usuario_meta_valor_mensal: null, usuario_meta_valor_compra: 100, usuario_data_criacao: new Date('2020-01-01') }; } },
  tb_compra: {
    findFirst: async ({ where }) => { calls.push('target'); return rows.find(r => r.compra_id === where.compra_id && r.usuario_id === where.usuario_id && r.compra_ativo === where.compra_ativo) ?? null; },
    findMany: async ({ where, select }) => {
      calls.push('window'); assert.equal(where.usuario_id, 1);
      assert.ok(where.compra_horario.gte > new Date('2026-01-01'));
      return rows.filter(r => r.usuario_id === where.usuario_id && r.compra_ativo === 1 && r.compra_status === 'CONFIRMADA' && r.compra_horario >= where.compra_horario.gte && r.compra_horario < where.compra_horario.lt);
    },
  },
  tb_compra_evento: { findMany: async ({ where, orderBy }) => {
    calls.push('events'); assert.equal(where.usuario_id, 1);
    if (where.compra) { assert.equal(where.compra.usuario_id, 1); assert.equal(where.compra_id, undefined); }
    return events.filter(e => (typeof where.compra_id === 'number' ? e.compra_id === where.compra_id : rows.some(r => r.compra_id === e.compra_id && r.usuario_id === where.compra.usuario_id && r.compra_ativo === 1 && r.compra_status === 'CONFIRMADA' && r.compra_horario >= where.compra.compra_horario.gte && r.compra_horario < where.compra.compra_horario.lt)) && (!where.tipo || where.tipo.in.includes(e.tipo)))
      .sort((a, b) => orderBy.revisao === 'desc' ? b.revisao - a.revisao : a.revisao - b.revisao);
  } },
  tb_referencia_financeira: { findMany: async () => { calls.push('references'); return []; } },
  contexto_compra_revisao: { findFirst: async () => { calls.push('context'); return null; } },
  tb_compra_recorrencia: { findMany: async () => { calls.push('recurrences'); return []; } },
  $transaction: async fn => fn(db),
};
globalThis.prismaRuntime = { client: db, pool: { end: async () => {} } };
const { AnaliseAutomaticaService: service } = await import('../../src/modules/analise/analise-automatica.service.ts');
const { snapshot, HistoricoService } = await import('../../src/modules/analise/historico.service.ts');
const { AnaliseComportamentalService } = await import('../../src/modules/analise/comportamento.service.ts');

test('histórico contextual e comportamento excluem os mesmos registros sem revelar categorias privadas', async () => {
  reset(); events.push(event(1000, 'OCULTACAO', { dados: { oculto: true } }));
  const before = await snapshot(db,1,'2026-10',6,now);
  assert.equal(before.compras.some(p=>p.id===1000),false);
  rows[0].compra_valor='999999.99';rows[0].tb_compra_item[0].categoria_id=999;
  const after=await snapshot(db,1,'2026-10',6,now);
  assert.deepEqual(after.historico,before.historico);
  events.push(event(99,'OCULTACAO',{dados:{oculto:true}}));
  await assert.rejects(HistoricoService.complementarCompra(1,99,now),/não encontrada/);
  const behavior=await AnaliseComportamentalService.consultarSnapshot(db,1,'2026-10',now);
  assert.deepEqual(behavior.categorias,[]);
});

test('alvo oculto ou com item pessoal falha fechado antes de carregar referências', async () => {
  for (const item of [null, 990]) {
    reset(); events.push(event(99, 'OCULTACAO', { compra_item_id: item, dados: { oculto: true } }));
    await assert.rejects(service.compra(1, 99, now), /Compra não encontrada/);
    assert.deepEqual(calls, ['target', 'events']);
  }
});
test('autorização, exclusão, pendência e cancelamento impedem análise individual', async () => {
  reset(); await assert.rejects(service.compra(2, 99, now), /não encontrada/);
  reset(); rows.at(-1).compra_ativo = 0; await assert.rejects(service.compra(1, 99, now), /não encontrada/);
  reset(); rows.at(-1).compra_status = 'IGNORADA'; await assert.rejects(service.compra(1, 99, now), /não elegível/);
  reset(); events.push(event(99, 'CANCELAMENTO')); await assert.rejects(service.compra(1, 99, now), /não elegível/);
});
test('ocultação e cancelamento históricos não vazam por valores, contagens, insights ou hash', async () => {
  for (const type of ['OCULTACAO', 'CANCELAMENTO']) {
    reset(); events.push(event(1000, type, { dados: { oculto: true } }));
    const before = await service.compra(1, 99, now);
    assert.equal(before.qualidadeDados.registrosElegiveis, 5);
    rows[0].compra_valor = '999999.99'; rows[0].tb_compra_item[0].categoria_id = 999;
    const after = await service.compra(1, 99, now);
    assert.deepEqual(after, before);
    assert.doesNotMatch(JSON.stringify(after), /999999|Privado/);
  }
});
test('última visibilidade por escopo e correções anuladas seguem o redutor existente', async () => {
  reset(); events.push(event(1000, 'OCULTACAO', { dados: { oculto: true } }));
  events.push(event(1000, 'OCULTACAO', { dados: { oculto: false } }));
  assert.equal((await service.compra(1, 99, now)).qualidadeDados.registrosElegiveis, 6);
  events.push(event(1000, 'OCULTACAO', { compra_item_id: 10000, dados: { oculto: true } }));
  assert.equal((await service.compra(1, 99, now)).qualidadeDados.registrosElegiveis, 5);
  reset(); events.push(event(1000, 'CANCELAMENTO', { evento_id: 1 }));
  events.push(event(1000, 'CANCELAMENTO', { corrige_evento_id: 1, anulado: true }));
  assert.equal((await service.compra(1, 99, now)).qualidadeDados.registrosElegiveis, 6);
});
test('classificação humana não é entrada circular e consultas não persistem decisões', async () => {
  reset(); const before = await service.compra(1, 99, now);
  rows.at(-1).compra_classificacao = 'NAO_IMPULSIVA';
  events.push(event(99, 'CLASSIFICACAO', { dados: { classificacao: 'NAO_IMPULSIVA' } }));
  assert.deepEqual(await service.compra(1, 99, now), before);
  assert.equal(rows.at(-1).compra_classificacao, 'NAO_IMPULSIVA');
});
test('quantidade de consultas é constante para 6 e 3000 compras; período usa o mesmo universo', async () => {
  for (const size of [6, 3000]) {
    reset(size); await service.compra(1, 99, now);
    assert.equal(calls.length, 7); assert.equal(calls.filter(c => c === 'events').length, 2);
  }
  reset(); events.push(event(1000, 'OCULTACAO', { dados: { oculto: true } }));
  const p = await service.periodo(1, '2026-10', now);
  assert.equal(p.qualidadeDados.registrosElegiveis, 6);
  assert.deepEqual(calls, ['user', 'window', 'events']);
});
