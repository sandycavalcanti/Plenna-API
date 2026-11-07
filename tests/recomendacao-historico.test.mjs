import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://localhost:1/recomendacao_historico_test';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.GOOGLE_CLIENT_ID = 'offline-client';
process.env.GOOGLE_CLIENT_SECRET = 'offline-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://example.invalid/callback';
process.env.EMAIL_SYNC_ENABLED = 'false';
process.env.REQUESTY_API_KEY = 'offline-only';

const { PrismaRecommendationRepository, RecommendationService } = await import('../src/modules/recomendacao/recomendacao.service.ts');

const agoraNovembro = new Date('2026-11-07T12:00:00.000Z');
const recomendacoes = [
  {
    ai_recomendacao_id: 21,
    usuario_id: 1,
    ai_recomendacao_tipo: 'ATENCAO_META',
    ai_recomendacao_titulo: 'Mantenha sua meta no radar',
    ai_recomendacao_texto: 'Acompanhe o objetivo registrado para outubro.',
    ai_recomendacao_evidencias: { versao: 1, fonte: 'DETERMINISTICA', periodo: '2026-10', referencias: ['meta:2'] },
    ai_recomendacao_chave: 'recommendation-21',
    ai_recomendacao_status: 'VISUALIZADA',
    ai_recomendacao_historico_id: 19,
    ai_recomendacao_data_expiracao: new Date('2026-11-01T00:00:00.000Z'),
    ai_recomendacao_data_criacao: new Date('2026-10-24T12:00:00.000Z'),
  },
  {
    ai_recomendacao_id: 20,
    usuario_id: 1,
    ai_recomendacao_tipo: 'REVISAR_LIMITE_INDIVIDUAL',
    ai_recomendacao_titulo: 'Revise seu limite',
    ai_recomendacao_texto: 'Confira o limite registrado.',
    ai_recomendacao_evidencias: { versao: 1, fonte: 'DETERMINISTICA', periodo: '2026-10' },
    ai_recomendacao_chave: 'recommendation-20',
    ai_recomendacao_status: 'DESCARTADA',
    ai_recomendacao_historico_id: null,
    ai_recomendacao_data_expiracao: new Date('2026-11-01T00:00:00.000Z'),
    ai_recomendacao_data_criacao: new Date('2026-10-23T12:00:00.000Z'),
  },
  {
    ai_recomendacao_id: 19,
    usuario_id: 1,
    ai_recomendacao_tipo: 'ACOMPANHAR_ORCAMENTO_EXCEDIDO',
    ai_recomendacao_titulo: 'Acompanhe seu orçamento',
    ai_recomendacao_texto: 'Confira os dados do período.',
    ai_recomendacao_evidencias: { versao: 1, fonte: 'DETERMINISTICA', periodo: '2026-10' },
    ai_recomendacao_chave: 'recommendation-19',
    ai_recomendacao_status: 'DESCARTADA',
    ai_recomendacao_historico_id: null,
    ai_recomendacao_data_expiracao: new Date('2026-11-01T00:00:00.000Z'),
    ai_recomendacao_data_criacao: new Date('2026-10-22T12:00:00.000Z'),
  },
];

function createRepository() {
  const calls = [];
  const db = {
    tb_ai_recomendacao: {
      async findMany(args) {
        calls.push(args);
        const where = args.where;
        return recomendacoes
          .filter((item) => item.usuario_id === where.usuario_id)
          .filter((item) => item.ai_recomendacao_status !== where.ai_recomendacao_status.not)
          .filter((item) => !where.ai_recomendacao_evidencias || item.ai_recomendacao_evidencias.periodo === where.ai_recomendacao_evidencias.equals)
          .filter((item) => !where.OR || where.OR.some((condition) => (
            condition.ai_recomendacao_data_expiracao === null && item.ai_recomendacao_data_expiracao === null
          ) || (
            condition.ai_recomendacao_data_expiracao?.gt && item.ai_recomendacao_data_expiracao > condition.ai_recomendacao_data_expiracao.gt
          )))
          .sort((a, b) => b.ai_recomendacao_id - a.ai_recomendacao_id)
          .slice(0, args.take);
      },
    },
  };
  return { repository: new PrismaRecommendationRepository(db), calls };
}

test('consulta histórica inclui recomendação visualizada expirada, mas mantém descartadas excluídas', async () => {
  const { repository, calls } = createRepository();
  const result = await repository.list(1, { limit: 10, now: agoraNovembro, periodo: '2026-10' });

  assert.deepEqual(result.map((item) => item.ai_recomendacao_id), [21]);
  assert.equal(calls[0].where.usuario_id, 1);
  assert.equal(calls[0].where.ai_recomendacao_status.not, 'DESCARTADA');
  assert.equal(calls[0].where.ai_recomendacao_evidencias.equals, '2026-10');
  assert.equal('OR' in calls[0].where, false);
});

test('consulta do período atual continua aplicando expiração', async () => {
  const { repository, calls } = createRepository();
  const result = await repository.list(1, { limit: 10, now: new Date('2026-10-24T12:00:00.000Z'), periodo: '2026-10' });

  assert.deepEqual(result.map((item) => item.ai_recomendacao_id), [21]);
  assert.ok(Array.isArray(calls[0].where.OR));
});

test('serviço preserva período, status e fonte no contrato da Home', async () => {
  const { repository } = createRepository();
  const service = new RecommendationService(repository, undefined, { temConsentimentoAtivo: async () => true });
  const result = await service.list(1, { limite: 10, periodo: '2026-10' }, agoraNovembro);

  assert.equal(result.consentimentoAtivo, true);
  assert.equal(result.itens.length, 1);
  assert.equal(result.itens[0].id, 21);
  assert.equal(result.itens[0].status, 'VISUALIZADA');
  assert.equal(result.itens[0].evidencias.periodo, '2026-10');
  assert.equal(result.itens[0].evidencias.fonte, 'DETERMINISTICA');
});
