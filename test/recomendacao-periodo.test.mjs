import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaRecommendationRepository, RecommendationService, recommendationQuerySchema } from '../src/modules/recomendacao/recomendacao.service.ts';

test('recommendation list filters persisted records by optional period', async () => {
  let captured;
  const repository = new PrismaRecommendationRepository({
    tb_ai_recomendacao: {
      findMany: async (args) => { captured = args; return []; },
    },
  });
  const now = new Date('2026-10-24T12:00:00Z');

  assert.equal(recommendationQuerySchema.parse({ periodo: '2026-09' }).periodo, '2026-09');
  await repository.list(7, { limit: 10, now, periodo: '2026-09' });
  assert.deepEqual(captured.where.ai_recomendacao_evidencias, { path: ['periodo'], equals: '2026-09' });

  await repository.list(7, { limit: 10, now });
  assert.equal(captured.where.ai_recomendacao_evidencias, undefined);
  assert.throws(() => recommendationQuerySchema.parse({ periodo: '2026-13' }));
});

test('recommendation service forwards period only to user listing', async () => {
  const calls = [];
  const repository = {
    list: async (_user, options) => { calls.push(options); return []; },
    findById: async () => null,
    findByKey: async () => null,
    create: async () => { throw new Error('unexpected'); },
    updateStatus: async () => false,
  };
  const consent = { temConsentimentoAtivo: async () => true };
  const service = new RecommendationService(repository, undefined, consent);

  await service.list(7, { limite: 10, periodo: '2026-09' }, new Date('2026-10-24T12:00:00Z'));
  await service.listEligibleForProactivity(7, 10, new Date('2026-10-24T12:00:00Z'));

  assert.equal(calls[0].periodo, '2026-09');
  assert.equal(calls[1].periodo, undefined);
});
