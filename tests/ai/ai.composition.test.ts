import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://localhost:1/plenna_phase2_composition';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.GOOGLE_CLIENT_ID = 'composition-client';
process.env.GOOGLE_CLIENT_SECRET = 'composition-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://example.test/callback';
process.env.JWT_SECRET = 'composition-jwt-secret';

(globalThis as any).prismaRuntime = {
  client: {},
  pool: { end: async () => {} },
};

const { aiToolRegistry } = await import('../../src/modules/ai/ai.registry.js');
await import('../../src/app.js');
const { AIOrchestrator } = await import('../../src/modules/ai/ai.orchestrator.js');
const { ToolRegistry } = await import('../../src/modules/ai/ai.registry.js');
const { createFinancialToolDefinitions } = await import('../../src/modules/ai/financial.tools.js');

const financialToolNames = [
  'profile_get',
  'finance_summary',
  'purchase_list',
  'purchase_get',
  'spending_by_category',
  'spending_by_payment',
  'impulsive_purchase_summary',
  'finance_analytics',
  'limits_status',
  'goals_list',
  'recurrences_list',
  'recurrence_commitments',
  'usage_summary',
  'interaction_recent',
  'consent_status',
];
const memoryToolNames = ['memory_list', 'memory_save', 'memory_update'];

test('composição real registra 15 tools financeiras e 3 de memória sem duplicação', async () => {
  const registeredNames = aiToolRegistry.definitions().map((definition) => definition.name);
  assert.equal(registeredNames.length, 18);
  assert.equal(new Set(registeredNames).size, 18);
  assert.deepEqual(new Set(registeredNames), new Set([...financialToolNames, ...memoryToolNames]));

  let providerTools: any[] = [];
  const provider = {
    classifyEmail: async () => ({ classificacao: 'IGNORAR' as const }),
    suggestCategory: async () => ({ categoryId: null }),
    chat: async () => 'fallback',
    chatWithTools: async (_messages: any[], tools: any[]) => {
      providerTools = tools;
      return { content: 'Composição carregada.', tool_calls: [] };
    },
  };

  const result = await new AIOrchestrator(aiToolRegistry, {
    maxCalls: 8,
    maxRounds: 2,
    timeoutMs: 100,
    toolTimeoutMs: 50,
    maxToolResultChars: 2_000,
  }).run(provider, [{ role: 'user', content: 'teste de composição' }], { usuario_id: 42 });

  assert.equal(result.text, 'Composição carregada.');
  assert.equal(providerTools.length, 18);
  assert.deepEqual(new Set(providerTools.map((tool) => tool.function.name)), new Set([...financialToolNames, ...memoryToolNames]));
});

test('orquestra duas consultas financeiras do catálogo com identidade autenticada', async () => {
  const calls: unknown[] = [];
  const dependencies: any = {
    financeSummary: async (userId: number, periodo?: string) => {
      calls.push(['finance_summary', userId, periodo]);
      return {
        periodo: periodo ?? '2026-10', timezone: 'UTC', inicio: '2026-10-01T00:00:00.000Z', fimExclusivo: '2026-11-01T00:00:00.000Z',
        totalConhecido: 100, total: 100, qualidade: 'COMPLETO', comprasConfirmadas: 1, comprasComValor: 1, comprasSemValor: 0,
        mediaConhecida: 100, orcamentoMensal: null, estadoOrcamento: 'SEM_ORCAMENTO', limitePorCompra: null, comprasAcimaLimiteIndividual: null,
      };
    },
    listPurchases: async () => ({ itens: [], totalRetornado: 0 }),
    getPurchase: async () => ({ compra: { id: 1, valor: 100, desconto: 0, horario: new Date('2026-10-01T00:00:00.000Z'), fonte: null, classificacao: 'NAO_IMPULSIVA', itens: [] } }),
    spendingByCategory: async (userId: number, periodo?: string) => {
      calls.push(['spending_by_category', userId, periodo]);
      return [{ categoria_nome: 'Casa', total: 100 }];
    },
    spendingByPayment: async () => [],
    impulsivity: async () => [],
    analytics: async () => ({ mode: 'month', timezone: 'UTC', periodos: [], comparacao: null }),
    limits: async () => ({ periodo: '2026-10', orcamentoMensal: null, estadoOrcamento: 'SEM_ORCAMENTO', limitePorCompra: null, comprasAcimaLimiteIndividual: null, comprasAcimaLimite: 0, comprasDentroLimite: 0 }),
    goals: async () => [],
    recurrences: async () => [],
    upcoming: async () => ({ ocorrencias: [] }),
    usage: async () => ({ periodo: '2026-10', itens: [], autorizado: true }),
    interactions: async () => ({ mensagens: [] }),
    profile: async () => ({ nome: 'Teste', limiteCompra: null, metaMensal: null, metaPorCompra: null, metaTempo: null }),
    consents: async () => ({ consentimentos: [] }),
  };
  const registry = new ToolRegistry();
  for (const definition of createFinancialToolDefinitions(dependencies)) registry.register(definition);

  let round = 0;
  const provider = {
    classifyEmail: async () => ({ classificacao: 'IGNORAR' as const }),
    suggestCategory: async () => ({ categoryId: null }),
    chat: async () => 'fallback',
    chatWithTools: async () => {
      round += 1;
      return round === 1
        ? {
          content: '',
          tool_calls: [
            { id: 'finance-1', type: 'function' as const, function: { name: 'finance_summary', arguments: '{"periodo":"2026-10"}' } },
            { id: 'finance-2', type: 'function' as const, function: { name: 'spending_by_category', arguments: '{"periodo":"2026-10"}' } },
          ],
        }
        : { content: 'Gasto mensal consultado.', tool_calls: [] };
    },
  };

  const result = await new AIOrchestrator(registry, {
    maxCalls: 4, maxRounds: 3, timeoutMs: 100, toolTimeoutMs: 50, maxToolResultChars: 2_000,
  }).run(provider, [{ role: 'user', content: 'Quanto gastei e qual categoria liderou?' }], { usuario_id: 42 });

  assert.equal(result.text, 'Gasto mensal consultado.');
  assert.deepEqual(calls, [
    ['finance_summary', 42, '2026-10'],
    ['spending_by_category', 42, '2026-10'],
  ]);
});
