import assert from 'node:assert/strict';
import test from 'node:test';
import { analisarPeriodo } from '../../src/modules/analise/comportamento.engine.js';
import { recomendar } from '../../src/modules/recomendacao/recomendacao.engine.js';
import { ProactiveMessageService } from '../../src/modules/proatividade/proatividade.text.js';

function purchase(id = 1, value = 250) {
  return {
    id,
    usuarioId: 1,
    ativa: true,
    status: 'CONFIRMADA',
    horario: '2026-10-05T12:00:00Z',
    precisaoHorario: 'APROXIMADO',
    valorLiquido: value,
    categorias: [2],
    origem: 'MANUAL',
    referencias: [`manual:${id}`],
  };
}

function analysis(overrides: Record<string, unknown> = {}) {
  return analisarPeriodo({
    versaoContrato: 1,
    usuarioId: 1,
    janela: { periodo: '2026-10', observadoAte: '2026-10-11T00:00:00Z', cobertura: 'COMPLETA' },
    compras: [purchase()],
    limiteIndividual: { valor: 80, vigencia: 'ATUAL_SEM_HISTORICO', referencia: 'limite:atual' },
    orcamentoMensal: { valor: 200, vigencia: 'ATUAL_SEM_HISTORICO', referencia: 'orcamento:atual' },
    ...overrides,
  });
}

test('oferece orientação prática sem sugerir alterar o limite como solução', () => {
  const result = recomendar(analysis());
  const limit = result.recomendacoes.find((item) => item.codigo === 'REVISAR_LIMITE_INDIVIDUAL');
  const budget = result.recomendacoes.find((item) => item.codigo === 'ACOMPANHAR_ORCAMENTO_EXCEDIDO');
  assert.ok(limit);
  assert.ok(budget);
  assert.doesNotMatch(`${limit.titulo} ${limit.mensagem}`, /revise seu limite|aumente|aumentar|modifique|modificar/i);
  assert.match(limit.mensagem, /analis|alternativas|planejamento/i);
  assert.match(budget.mensagem, /despesas|economizar|pr[oó]ximas compras/i);
});

test('mantém a ressalva de vigência e usa tom acolhedor para metas', () => {
  const result = recomendar(analysis({
    compras: [purchase(1, 10)],
    limiteIndividual: { valor: null, vigencia: 'ATUAL_SEM_HISTORICO', referencia: 'limite:atual' },
    orcamentoMensal: { valor: null, vigencia: 'ATUAL_SEM_HISTORICO', referencia: 'orcamento:atual' },
  }), {
    metas: [{ id: 3, titulo: 'Cadeira Gamer', valor: 1000, concluida: false, data: null }],
    enableExpandedRules: true,
  });
  const goal = result.recomendacoes.find((item) => item.codigo === 'ATENCAO_META');
  assert.ok(goal);
  assert.match(goal.mensagem, /continua em andamento|pr[oó]ximos gastos|planejamento/i);
  assert.doesNotMatch(goal.mensagem, /diagn[oó]stico|culpa|sempre|nunca/i);
});

test('fallback proativo não usa o prefixo burocrático e convida à conversa', async () => {
  const service = new ProactiveMessageService();
  const result = await service.generate({
    tipo: 'REVISAR_LIMITE_INDIVIDUAL',
    titulo: 'Observe gastos acima do limite',
    texto: 'Algumas compras registradas ficaram acima do limite por compra atualmente informado.',
    referencias: ['compra:1'],
    limitacoes: ['VIGENCIA_DO_LIMITE_NAO_COMPROVADA_NESTE_CONTRATO'],
  });
  assert.equal(result.fonte, 'DETERMINISTICA');
  assert.doesNotMatch(result.texto, /Quero compartilhar uma observação baseada em dados registrados/i);
  assert.match(result.texto, /analisarmos|planejamento/i);
});
