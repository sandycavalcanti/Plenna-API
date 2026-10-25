// Impede que dotenv carregue configuracoes reais durante o teste sintetico.
process.env.DOTENV_CONFIG_PATH = '.absent-offline-env';
// Explicit synthetic environment; never load the configured connection or credentials.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://127.0.0.1:1/never_used',
  DIRECT_URL: 'postgresql://127.0.0.1:1/never_used',
  JWT_SECRET: 'isolated-synthetic-only',
  GOOGLE_CLIENT_ID: 'synthetic',
  GOOGLE_CLIENT_SECRET: 'synthetic',
  GOOGLE_REDIRECT_URI: 'https://example.invalid',
  EMAIL_SYNC_ENABLED: 'false',
  RECURRENCE_CRON_ENABLED: 'false',
  EXPO_PUSH_ENABLED: 'false',
  RF018_LOCAL: 'false',
});
