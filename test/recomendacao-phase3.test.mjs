import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { recomendar } from '../src/modules/recomendacao/recomendacao.engine.ts';
import { RecommendationTextService } from '../src/modules/recomendacao/recomendacao.text.ts';
import { RecommendationService, recommendationDedupeKey } from '../src/modules/recomendacao/recomendacao.service.ts';

function analysis(overrides = {}) {
  return {
    versaoContrato: 1, versaoIndicadores: 'descritivos-1', escopo: 'PERIODO', periodo: '2026-10', timezone: 'UTC', observadoAte: '2026-10-24T12:00:00.000Z',
    avaliacao: { estado: 'DADOS_INSUFICIENTES', regrasAplicadas: [], justificativas: [] },
    qualidade: { cobertura: 'COMPLETA', comprasSemHorario: 0, horariosImprecisos: 0 },
    indicadores: {
      frequencia: { disponibilidade: 'DISPONIVEL', compras: 12, diasObservados: 24, comprasPorDia: 0.5 },
      comparacao: { disponibilidade: 'DISPONIVEL', motivo: null, periodoAnterior: '2026-09', comprasAnterior: 14, diferenca: -2, variacaoRelativa: -0.14 },
      categorias: { disponibilidade: 'DISPONIVEL', comprasCategorizadas: 12, comprasSemCategoria: 0, grupos: [{ categoriaId: 3, compras: 8, participacao: 2 / 3 }, { categoriaId: 4, compras: 4, participacao: 1 / 3 }] },
      limiteIndividual: { disponibilidade: 'DISPONIVEL', limiteCentavos: 5000, vigencia: 'ATUAL_SEM_HISTORICO', comprasSemValor: 0, desvios: [{ compraId: 10, excessoCentavos: 1200 }] },
      financeiro: { totalConhecido: 700, total: 700, qualidade: 'COMPLETO', comprasConfirmadas: 12, comprasComValor: 12, comprasSemValor: 0, mediaConhecida: 58.33, orcamentoMensal: 500, estadoOrcamento: 'EXCEDIDO' },
      orcamento: { disponibilidade: 'DISPONIVEL', vigencia: 'ATUAL_SEM_HISTORICO', estadoNoUniversoObservado: 'EXCEDIDO' },
    },
    evidencias: [
      { codigo: 'ORCAMENTO_MENSAL', natureza: 'DECLARADO', referencias: ['perfil:orcamento'] },
      { codigo: 'LIMITE_INDIVIDUAL', natureza: 'DECLARADO', referencias: ['perfil:limite'] },
      { codigo: 'COMPRA_10', natureza: 'OBSERVADO', referencias: ['compra:10'] },
    ],
    limitacoes: [],
    ...overrides,
  };
}

test('motor determinístico produz alertas, recomendações positivas e nenhuma ação explícita', () => {
  const result = recomendar(analysis(), {
    maxCandidates: 10, enableExpandedRules: true,
    comprasImpulsivas: { quantidade: 2, valorConhecido: 30 },
    metas: [{ id: 1, titulo: 'Reserva', valor: 1000, concluida: false, data: null }],
    recorrencias: [{ id: 8, proximaOcorrencia: '2026-10-25', valorMensalConhecido: 100 }],
  });
  assert.equal(result.estado, 'COM_RECOMENDACOES');
  assert.ok(result.recomendacoes.some((item) => item.codigo === 'ACOMPANHAR_ORCAMENTO_EXCEDIDO'));
  assert.ok(result.recomendacoes.some((item) => item.codigo === 'COMPARACAO_POSITIVA'));
  assert.ok(result.recomendacoes.some((item) => item.codigo === 'ATENCAO_META'));
  assert.equal(recomendar(analysis({ indicadores: { ...analysis().indicadores, financeiro: { ...analysis().indicadores.financeiro, estadoOrcamento: 'DENTRO' }, orcamento: { ...analysis().indicadores.orcamento, estadoNoUniversoObservado: 'DENTRO' }, categorias: { ...analysis().indicadores.categorias, disponibilidade: 'INDISPONIVEL' }, frequencia: { ...analysis().indicadores.frequencia, disponibilidade: 'INDISPONIVEL' }, comparacao: { ...analysis().indicadores.comparacao, disponibilidade: 'INDISPONIVEL' }, limiteIndividual: { ...analysis().indicadores.limiteIndividual, disponibilidade: 'INDISPONIVEL', desvios: [] } }, evidencias: [] }), { maxCandidates: 10 }).estado, 'SEM_RECOMENDACOES_ELEGIVEIS');
});

test('texto por provider mockado só é aceito quando preserva a base e variações usam fallback determinístico', async () => {
  const provider = { chat: async (messages) => { assert.ok(messages[1].content.length < 1000); return JSON.stringify({ titulo: 'Base', texto: 'Base factual' }); } };
  const generated = await new RecommendationTextService(provider, { enabled: true }).generate({ codigo: 'X', titulo: 'Base', mensagem: 'Base factual', referencias: ['periodo:2026-10'], limitacoes: [] });
  assert.equal(generated.fonte, 'IA');
  const fallback = await new RecommendationTextService({ chat: async () => JSON.stringify({ titulo: 'Base', texto: 'Base factual com R$ 9999 inventados' }) }, { enabled: true }).generate({ codigo: 'X', titulo: 'Base', mensagem: 'Base factual', referencias: ['x'], limitacoes: [] });
  assert.equal(fallback.fonte, 'DETERMINISTICA_FALLBACK');
});

test('serviço exige consentimento e trata deduplicação por usuário/chave sem sobrescrever o registro', async () => {
  const records = [];
  const repository = {
    list: async () => records,
    findById: async (_user, id) => records.find((row) => row.ai_recomendacao_id === id) ?? null,
    findByKey: async (user, key) => records.find((row) => row.usuario_id === user && row.ai_recomendacao_chave === key) ?? null,
    create: async (data) => {
      if (records.some((row) => row.usuario_id === data.usuario_id && row.ai_recomendacao_chave === data.ai_recomendacao_chave)) throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '7' });
      const row = { ai_recomendacao_id: records.length + 1, ...data };
      records.push(row);
      return row;
    },
    updateStatus: async (user, id, status) => { const row = records.find((item) => item.usuario_id === user && item.ai_recomendacao_id === id); if (!row) return false; row.ai_recomendacao_status = status; return true; },
  };
  const consent = { temConsentimentoAtivo: async () => true };
  const service = new RecommendationService(repository, new RecommendationTextService(), consent, async () => ({ analise: analysis(), context: { maxCandidates: 1, enableExpandedRules: true } }));
  const first = await service.generateForUser(7, '2026-10', new Date('2026-10-24T12:00:00Z'));
  const second = await service.generateForUser(7, '2026-10', new Date('2026-10-24T12:00:00Z'));
  assert.equal(first.itens.length, 1);
  assert.equal(second.itens.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].usuario_id, 7);
  assert.equal(recommendationDedupeKey('2026-10', 'X', ['b', 'a']), recommendationDedupeKey('2026-10', 'X', ['a', 'b']));
});

test('sem consentimento o serviço não calcula nem persiste recomendação', async () => {
  let called = false;
  const service = new RecommendationService({ list: async () => [], findById: async () => null, findByKey: async () => null, create: async () => { throw new Error('não esperado'); }, updateStatus: async () => false }, undefined, { temConsentimentoAtivo: async () => false }, async () => { called = true; return { analise: analysis(), context: {} }; });
  await assert.rejects(() => service.generateForUser(9, '2026-10'), /Consentimento/);
  assert.equal(called, false);
});

test('preview manual não persiste e uma recomendação descartada não interrompe os demais candidatos', async () => {
  const candidates = recomendar(analysis(), { enableExpandedRules: true, maxCandidates: 10 }).recomendacoes;
  const discardedKey = recommendationDedupeKey('2026-10', candidates[0].codigo, candidates[0].referencias);
  const records = [{
    ai_recomendacao_id: 41,
    usuario_id: 7,
    ai_recomendacao_tipo: candidates[0].codigo,
    ai_recomendacao_titulo: 'Descartada',
    ai_recomendacao_texto: 'Não deve ser reativada.',
    ai_recomendacao_evidencias: {},
    ai_recomendacao_chave: discardedKey,
    ai_recomendacao_status: 'DESCARTADA',
    ai_recomendacao_historico_id: null,
    ai_recomendacao_data_expiracao: new Date('2026-11-01T00:00:00Z'),
    ai_recomendacao_data_criacao: new Date('2026-10-24T12:00:00Z'),
  }];
  let writes = 0;
  const repository = {
    list: async (user, options) => records.filter((row) => row.usuario_id === user && row.ai_recomendacao_status !== 'DESCARTADA' && (!row.ai_recomendacao_data_expiracao || row.ai_recomendacao_data_expiracao > options.now)).slice(0, options.limit),
    findById: async (user, id) => records.find((row) => row.usuario_id === user && row.ai_recomendacao_id === id) ?? null,
    findByKey: async (user, key) => records.find((row) => row.usuario_id === user && row.ai_recomendacao_chave === key) ?? null,
    create: async (data) => {
      writes += 1;
      if (records.some((row) => row.usuario_id === data.usuario_id && row.ai_recomendacao_chave === data.ai_recomendacao_chave)) {
        throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '7' });
      }
      const row = { ai_recomendacao_id: 41 + records.length, ...data };
      records.push(row);
      return row;
    },
    updateStatus: async (user, id, status) => {
      const row = records.find((item) => item.usuario_id === user && item.ai_recomendacao_id === id);
      if (!row) return false;
      row.ai_recomendacao_status = status;
      return true;
    },
  };
  let personalizationEnabled = true;
  const consent = { temConsentimentoAtivo: async () => personalizationEnabled };
  const service = new RecommendationService(repository, new RecommendationTextService(), consent, async () => ({ analise: analysis(), context: { maxCandidates: 10, enableExpandedRules: true } }));
  const preview = await service.previewForUser(7, '2026-10', new Date('2026-10-24T12:00:00Z'));
  assert.equal(writes, 0);
  assert.ok(preview.itens.length > 0);
  const generated = await service.generateForUser(7, '2026-10', new Date('2026-10-24T12:00:00Z'));
  assert.ok(generated.itens.length > 0);
  assert.ok(records.some((row) => row.ai_recomendacao_status === 'NOVA'));
  assert.equal(records.filter((row) => row.ai_recomendacao_status === 'DESCARTADA').length, 1);
  const firstActive = generated.itens.find((item) => item.status === 'NOVA');
  await service.updateStatus(7, firstActive.id, 'DESCARTADA');
  assert.equal((await service.list(7, { limite: 10 }, new Date('2026-10-24T12:00:00Z'))).itens.some((item) => item.id === firstActive.id), false);
  const discardedCount = records.filter((row) => row.ai_recomendacao_chave === discardedKey).length;
  await service.generateForUser(7, '2026-10', new Date('2026-10-24T12:00:00Z'));
  assert.equal(records.filter((row) => row.ai_recomendacao_chave === discardedKey).length, discardedCount);
  personalizationEnabled = false;
  assert.deepEqual((await service.list(7, { limite: 10 }, new Date('2026-10-24T12:00:00Z'))).itens, []);
  await assert.rejects(() => service.generateForUser(7, '2026-10'), (error) => error?.statusCode === 403);
});

test('revogação entre análise e persistência bloqueia a escrita com 403', async () => {
  let checks = 0;
  let writes = 0;
  const repository = {
    list: async () => [],
    findById: async () => null,
    findByKey: async () => null,
    create: async () => { writes += 1; throw new Error('não esperado'); },
    updateStatus: async () => false,
  };
  const service = new RecommendationService(repository, new RecommendationTextService(), {
    temConsentimentoAtivo: async () => ++checks < 2,
  }, async () => ({ analise: analysis(), context: { maxCandidates: 1, enableExpandedRules: true } }));
  await assert.rejects(
    () => service.generateForUser(7, '2026-10', new Date('2026-10-24T12:00:00Z')),
    (error) => error?.statusCode === 403,
  );
  assert.equal(writes, 0);
});
