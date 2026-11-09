import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTool } from '../../src/modules/ai/ai.executor.js';
import { ToolRegistry } from '../../src/modules/ai/ai.registry.js';
import { createFinancialToolDefinitions, type FinancialToolDependencies } from '../../src/modules/ai/financial.tools.js';
import { PLENNA_CHAT_SYSTEM_PROMPT } from '../../src/modules/chat/chat.prompt.js';

function dependencies(calls: unknown[], metaRows: unknown[] = []): FinancialToolDependencies {
  return {
    financeSummary: async () => ({}),
    listPurchases: async () => ({ itens: [], totalRetornado: 0 }),
    getPurchase: async () => ({ compra: {} }),
    spendingByCategory: async () => [],
    spendingByPayment: async () => [],
    impulsivity: async () => [],
    analytics: async () => ({ mode: 'month', timezone: 'America/Sao_Paulo', periodos: [], comparacao: null }),
    limits: async () => ({}),
    metas: async () => metaRows,
    analisarMetas: async (userId, args) => {
      calls.push({ userId, args });
      return {
        periodo_referencia: '2026-10',
        meses_solicitados: 6,
        timezone: 'America/Sao_Paulo',
        cobertura: {
          inicio: '2026-05-01T03:00:00.000Z',
          fim_exclusivo: '2026-11-01T03:00:00.000Z',
          metas_retornadas: 0,
          metas_limitadas: false,
          dados_suficientes: true,
          saldo_historico_disponivel: false,
          movimentos_considerados: 0,
          sem_movimentacoes: true,
          periodo_referencia_parcial: false,
          qualidade: 'SEM_METAS',
        },
        limitacoes: ['Nenhuma meta disponivel.'],
        metas: [],
      };
    },
    recurrences: async () => [],
    upcoming: async () => ({ ocorrencias: [] }),
    usage: async () => ({ periodo: '2026-10', itens: [], autorizado: true }),
    interactions: async () => ({ mensagens: [] }),
    profile: async () => ({ nome: 'Teste', limiteCompra: null, metaMensal: null, metaPorCompra: null, metaTempo: null }),
    consents: async () => ({ consentimentos: [] }),
  };
}

test('registra analisar_metas e usa somente identidade autenticada', async () => {
  const calls: unknown[] = [];
  const registry = new ToolRegistry();
  for (const definition of createFinancialToolDefinitions(dependencies(calls))) registry.register(definition);
  assert.equal(registry.has('analisar_metas'), true);
  assert.equal(registry.has('listar_metas'), true);

  const result = await executeTool(registry, {
    name: 'analisar_metas',
    arguments: { periodo: '2026-10', meses: 6, limite_metas: 10, limite_movimentacoes_recentes: 10 },
  }, { usuario_id: 42 });
  assert.equal((result.result as any).cobertura.qualidade, 'SEM_METAS');
  assert.deepEqual(calls, [{
    userId: 42,
    args: { periodo: '2026-10', meses: 6, limite_metas: 10, limite_movimentacoes_recentes: 10 },
  }]);
});

test('listar_metas expõe o objetivo na mesma unidade real do contrato da API', async () => {
  const registry = new ToolRegistry();
  for (const definition of createFinancialToolDefinitions(dependencies([], [{
    meta_id: 2,
    meta_titulo: 'Cadeira Gamer',
    meta_descricao: null,
    meta_valor: '500.00',
    meta_data: null,
    meta_completado: false,
  }]))) registry.register(definition);

  const result: any = await executeTool(registry, { name: 'listar_metas', arguments: {} }, { usuario_id: 1 });
  assert.deepEqual(result.result, {
    itens: [{ id: 2, titulo: 'Cadeira Gamer', descricao: null, valor: 500, data: null, completado: false }],
  });
});

test('rejeita usuario_id enviado pelo modelo e nao oferece operacao de escrita', async () => {
  const registry = new ToolRegistry();
  for (const definition of createFinancialToolDefinitions(dependencies([]))) registry.register(definition);
  await assert.rejects(
    () => executeTool(registry, { name: 'analisar_metas', arguments: { usuario_id: 99 } }, { usuario_id: 42 }),
    { code: 'TOOL_ARGUMENTS_INVALID' },
  );
  assert.equal(registry.has('analisar_metas_depositar'), false);
  assert.equal(registry.has('analisar_metas_retirar'), false);
});

test('prompt orienta uso contextual, evidenciado e simbolico das reservas', () => {
  assert.match(PLENNA_CHAT_SYSTEM_PROMPT, /analisar_metas/);
  assert.match(PLENNA_CHAT_SYSTEM_PROMPT, /nao invente fatos/);
  assert.match(PLENNA_CHAT_SYSTEM_PROMPT, /dinheiro disponivel em conta bancaria/);
  assert.match(PLENNA_CHAT_SYSTEM_PROMPT, /companheira de planejamento financeiro/);
  assert.match(PLENNA_CHAT_SYSTEM_PROMPT, /nao termine todas as respostas com uma pergunta/);
  assert.match(PLENNA_CHAT_SYSTEM_PROMPT, /sem decidir por ela/);
  assert.match(PLENNA_CHAT_SYSTEM_PROMPT, /acolhimento nao exige respostas longas/);
});

