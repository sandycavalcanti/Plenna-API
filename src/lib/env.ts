import "dotenv/config";
/**
 * Recupera uma variável de ambiente obrigatória.
 *
 * Configurações essenciais são validadas durante a inicialização para
 * evitar que a aplicação descubra a ausência delas somente em runtime.
 */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const portRaw = process.env.PORT ?? "3000";
const port = Number(portRaw);
// Os limites da sincronização são configuráveis para controlar a quantidade
// de trabalho realizada por uma única execução serverless.
const emailSyncLookbackDaysRaw = process.env.EMAIL_SYNC_LOOKBACK_DAYS ?? "30";
const emailSyncBatchSizeRaw = process.env.EMAIL_SYNC_BATCH_SIZE ?? "25";
const emailSyncMaxUsersPerRunRaw = process.env.EMAIL_SYNC_MAX_USERS_PER_RUN ?? "10";
const geminiTimeoutMsRaw = process.env.GEMINI_TIMEOUT_MS ?? "8000";
const emailSyncEnabledRaw = process.env.EMAIL_SYNC_ENABLED ?? "true";

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT value: ${portRaw}`);
}
/**
 * Converte e valida configurações que precisam ser inteiros positivos,
 * como limites de lote, quantidade de usuários e timeouts.
 */
function requirePositiveInteger(name: string, raw: string): number {
  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }

  return value;
}

function parseStrictBoolean(name: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Invalid ${name} value: ${raw}`);
}
/**
 * Centraliza as configurações da aplicação.
 *
 * Os demais módulos consomem este objeto em vez de acessar `process.env`
 * diretamente, mantendo defaults e validações em um único ponto.
 */
export const env = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  port,
  dbUrl: process.env.DIRECT_URL ?? requireEnv("DATABASE_URL"),
  apiBaseUrl: process.env.API_BASE_URL ?? "https://plenna-api-orpin.vercel.app",
  googleClientId: requireEnv("GOOGLE_CLIENT_ID"),
  googleClientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
  googleRedirectUri: requireEnv("GOOGLE_REDIRECT_URI"),
  emailSyncEnabled: parseStrictBoolean("EMAIL_SYNC_ENABLED", emailSyncEnabledRaw),
  emailSyncLookbackDays: requirePositiveInteger("EMAIL_SYNC_LOOKBACK_DAYS", emailSyncLookbackDaysRaw),
  emailSyncBatchSize: requirePositiveInteger("EMAIL_SYNC_BATCH_SIZE", emailSyncBatchSizeRaw),
  emailSyncMaxUsersPerRun: requirePositiveInteger("EMAIL_SYNC_MAX_USERS_PER_RUN", emailSyncMaxUsersPerRunRaw),
  cronSecret: process.env.CRON_SECRET ?? "",
  // Gemini é opcional porque a classificação determinística continua disponível.
  // A ausência da chave só impede o fallback de IA em casos ambíguos.
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
  geminiTimeoutMs: requirePositiveInteger("GEMINI_TIMEOUT_MS", geminiTimeoutMsRaw),
};
