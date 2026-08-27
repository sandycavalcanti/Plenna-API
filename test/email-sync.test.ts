import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? 'postgresql://localhost:5432/plenna_test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? 'client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? 'client-secret';
process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? 'https://example.com/callback';
process.env.EMAIL_SYNC_CRON_SECRET = process.env.EMAIL_SYNC_CRON_SECRET ?? 'cron-secret';

test('buildGmailQuery gera janela incremental', async () => {
  const { buildGmailQuery } = await import('../src/modules/email/email-sync.service.js');
  const query = buildGmailQuery(new Date('2026-08-01T10:00:00Z'), new Date('2026-08-01T12:30:00Z'));
  assert.match(query, /after:/);
  assert.match(query, /before:/);
});

test('sync cron rejeita secret ausente', async () => {
  const { EmailController } = await import('../src/modules/email/email.controller.js');
  const req = { header: () => undefined } as any;
  const res = fakeResponse();

  await EmailController.syncCron(req, res as any);

  assert.equal(res.statusCode, 401);
});

test('GeminiProvider rejeita ausência de API key', async () => {
  process.env.GEMINI_API_KEY = '';
  const { GeminiProvider } = await import('../src/modules/email/gemini.provider.js');
  const provider = new GeminiProvider();
  await assert.rejects(() => provider.classifyMessage('teste'));
});

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    redirect(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}
