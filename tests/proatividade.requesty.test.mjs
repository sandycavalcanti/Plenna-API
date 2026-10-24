import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://localhost:1/plenna_requesty_test';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.GOOGLE_CLIENT_ID = 'requesty-client';
process.env.GOOGLE_CLIENT_SECRET = 'requesty-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://example.test/callback';
process.env.AI_PROVIDER = 'requesty';
process.env.REQUESTY_API_KEY = 'offline-test-key';
process.env.AI_PROACTIVITY_ENABLED = 'true';
process.env.AI_PROACTIVITY_AI_ENABLED = 'true';
process.env.AI_PROACTIVITY_EXTERNAL_APPROVED = 'true';

const { createAIProvider } = await import('../.tmp-phase4-compile/src/modules/email/ai-provider.factory.js');
const { createApprovedProactiveMessageService } = await import('../.tmp-phase4-compile/src/modules/proatividade/proatividade.text.js');

const facts = {
  tipo: 'ATENCAO_META',
  titulo: 'Mantenha sua meta no radar',
  texto: 'A meta Cadeira Gamer continua aberta no periodo.',
  periodo: '2026-10',
  referencias: ['meta:3'],
  limitacoes: [],
};

test('fabrica Requesty cria provider sem realizar chamada externa', () => {
  assert.ok(createAIProvider());
});

test('flags habilitadas acionam provider injetado e aceitam redação fundamentada', async () => {
  let calls = 0;
  const service = createApprovedProactiveMessageService(() => ({
    async chat() {
      calls += 1;
      return JSON.stringify({
        titulo: 'Vale acompanhar este objetivo',
        texto: 'A Cadeira Gamer continua aberta. Se quiser, posso ajudar a planejar os proximos passos.',
      });
    },
  }));

  const result = await service.generate(facts);
  assert.equal(result.fonte, 'IA');
  assert.equal(calls, 1);
});

test('provider ausente preserva fallback determinístico e não chama rede', async () => {
  const service = createApprovedProactiveMessageService(() => null);
  const result = await service.generate(facts);
  assert.equal(result.fonte, 'DETERMINISTICA');
});
