import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTool } from '../../src/modules/ai/ai.executor.js';
import { ToolRegistry } from '../../src/modules/ai/ai.registry.js';
import { createFinancialToolDefinitions, type FinancialToolDependencies } from '../../src/modules/ai/financial.tools.js';

const summary = {
  periodo: '2026-10', timezone: 'UTC', inicio: '2026-10-01T00:00:00.000Z', fimExclusivo: '2026-11-01T00:00:00.000Z',
  totalConhecido: 0, total: 0, qualidade: 'SEM_COMPRAS', comprasConfirmadas: 0, comprasComValor: 0, comprasSemValor: 0,
  mediaConhecida: null, orcamentoMensal: null, estadoOrcamento: 'SEM_ORCAMENTO', limitePorCompra: null, comprasAcimaLimiteIndividual: null,
};

function dependencies(calls: unknown[] = []): FinancialToolDependencies {
  return {
    financeSummary: async (userId, periodo) => { calls.push(['summary', userId, periodo]); return summary; },
    listPurchases: async (userId, args) => { calls.push(['list', userId, args]); return { itens: [], totalRetornado: 0 }; },
    getPurchase: async (userId, id) => { calls.push(['get', userId, id]); return { compra: { id, valor: 10, desconto: 0, horario: new Date('2026-10-01T00:00:00.000Z'), fonte: null, classificacao: 'NAO_IMPULSIVA', itens: [] } }; },
    spendingByCategory: async () => [],
    spendingByPayment: async () => [],
    impulsivity: async () => [],
    analytics: async () => ({ mode: 'month', timezone: 'America/Sao_Paulo', periodos: [], comparacao: null }),
    limits: async () => ({ periodo: '2026-10', orcamentoMensal: null, estadoOrcamento: 'SEM_ORCAMENTO', limitePorCompra: null, comprasAcimaLimiteIndividual: null, comprasAcimaLimite: 0, comprasDentroLimite: 0 }),
    goals: async () => [],
    recurrences: async () => [],
    upcoming: async () => ({ ocorrencias: [] }),
    usage: async () => ({ periodo: '2026-10', itens: [], autorizado: true }),
    interactions: async () => ({ mensagens: [] }),
    profile: async () => ({ nome: 'Usuário', limiteCompra: null, metaMensal: null, metaPorCompra: null, metaTempo: null }),
    consents: async () => ({ consentimentos: [{ codigo: 'IA_MEMORIA', ativo: true }] }),
  };
}

function buildRegistry(calls: unknown[] = []) {
  const registry = new ToolRegistry();
  for (const definition of createFinancialToolDefinitions(dependencies(calls))) registry.register(definition);
  return registry;
}

test('registra tools financeiras úteis e usa somente a identidade do contexto', async () => {
  const calls: unknown[] = [];
  const registry = buildRegistry(calls);
  assert.ok(registry.has('finance_summary'));
  assert.ok(registry.has('purchase_list'));
  assert.ok(registry.has('purchase_get'));
  assert.ok(registry.has('spending_by_category'));
  assert.ok(registry.has('finance_analytics'));
  assert.ok(registry.has('goals_list'));
  assert.ok(registry.has('recurrences_list'));
  assert.ok(registry.has('usage_summary'));

  await executeTool(registry, { name: 'finance_summary', arguments: { periodo: '2026-10' } }, { usuario_id: 42 });
  await executeTool(registry, { name: 'purchase_get', arguments: { compra_id: 17 } }, { usuario_id: 42 });
  assert.deepEqual(calls, [['summary', 42, '2026-10'], ['get', 42, 17]]);
});

test('aplica defaults, limites e filtros sem permitir identidade do modelo', async () => {
  const calls: unknown[] = [];
  const toolRegistry = buildRegistry(calls);
  const listResult = await executeTool(toolRegistry, { name: 'purchase_list', arguments: {} }, { usuario_id: 7 });
  assert.deepEqual(listResult.result, { itens: [], totalRetornado: 0 });
  assert.deepEqual(calls[0], ['list', 7, { limite: 20 }]);

  await assert.rejects(
    () => executeTool(toolRegistry, { name: 'purchase_list', arguments: { usuario_id: 99 } }, { usuario_id: 7 }),
    { code: 'TOOL_ARGUMENTS_INVALID' },
  );
  await assert.rejects(
    () => executeTool(toolRegistry, { name: 'purchase_list', arguments: { limite: 51 } }, { usuario_id: 7 }),
    { code: 'TOOL_ARGUMENTS_INVALID' },
  );
});

test('representa ausência de dados sem inventar zero financeiro', async () => {
  const toolRegistry = buildRegistry();
  const result: any = await executeTool(toolRegistry, { name: 'finance_summary', arguments: {} }, { usuario_id: 42 });
  assert.equal(result.result.qualidade, 'SEM_COMPRAS');
  assert.equal(result.result.orcamentoMensal, null);
  assert.equal(result.result.estadoOrcamento, 'SEM_ORCAMENTO');
});

test('sinaliza compromissos recorrentes parciais quando os limites impedem cobertura total', async () => {
  const manyRecurrences = dependencies();
  manyRecurrences.recurrences = async () => Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    itens: [{ valor: 10 }],
  }));
  manyRecurrences.upcoming = async () => ({
    ocorrencias: [{ dataPrevista: '2026-01-15' }, { dataPrevista: '2026-02-15' }],
  });
  const manyRegistry = new ToolRegistry();
  for (const definition of createFinancialToolDefinitions(manyRecurrences)) manyRegistry.register(definition);

  const manyResult: any = await executeTool(manyRegistry, {
    name: 'recurrence_commitments',
    arguments: { inicio: '2026-01-01T00:00:00.000Z', fim: '2026-12-31T00:00:00.000Z', limite: 20 },
  }, { usuario_id: 42 });
  assert.equal(manyResult.result.parcial, true);
  assert.equal(manyResult.result.total, null);
  assert.equal(manyResult.result.total_parcial, 400);

  const manyOccurrences = dependencies();
  manyOccurrences.recurrences = async () => [{ id: 1, itens: [{ valor: 7 }] }];
  manyOccurrences.upcoming = async () => ({
    ocorrencias: Array.from({ length: 50 }, () => ({ dataPrevista: '2026-01-15' })),
  });
  const occurrencesRegistry = new ToolRegistry();
  for (const definition of createFinancialToolDefinitions(manyOccurrences)) occurrencesRegistry.register(definition);

  const occurrencesResult: any = await executeTool(occurrencesRegistry, {
    name: 'recurrence_commitments',
    arguments: { inicio: '2026-01-01T00:00:00.000Z', fim: '2026-12-31T00:00:00.000Z', limite: 20 },
  }, { usuario_id: 42 });
  assert.equal(occurrencesResult.result.parcial, true);
  assert.equal(occurrencesResult.result.total, null);
  assert.equal(occurrencesResult.result.total_parcial, 350);
});
