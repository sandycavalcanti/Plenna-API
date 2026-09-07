import "dotenv/config";
/**
 * Recupera uma variável de ambiente obrigatória.
 *
 * Configurações essenciais são validadas durante a inicialização para
 * evitar que a aplicação descubra a ausência delas somente em runtime.
 */
function requireEnv(name) {
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
const emailSyncInitialMessagesRaw = process.env.EMAIL_SYNC_INITIAL_MESSAGES ?? "30";
const emailSyncBatchSizeRaw = process.env.EMAIL_SYNC_BATCH_SIZE ?? "25";
const emailSyncMaxMessagesPerRunRaw = process.env.EMAIL_SYNC_MAX_MESSAGES_PER_RUN ?? "25";
const emailSyncMaxUsersPerRunRaw = process.env.EMAIL_SYNC_MAX_USERS_PER_RUN ?? "10";
const emailPurchaseReconciliationWindowHoursRaw = process.env.EMAIL_PURCHASE_RECONCILIATION_WINDOW_HOURS ?? "48";
const emailAttachmentMaxBytesRaw = process.env.EMAIL_ATTACHMENT_MAX_BYTES ?? "10485760";
const requestyTimeoutMsRaw = process.env.REQUESTY_TIMEOUT_MS ?? "8000";
const geminiTimeoutMsRaw = process.env.GEMINI_TIMEOUT_MS ?? "8000";
const geminiRateLimitCooldownMsRaw = process.env.GEMINI_RATE_LIMIT_COOLDOWN_MS ?? "60000";
const emailSyncEnabledRaw = process.env.EMAIL_SYNC_ENABLED ?? "true";
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${portRaw}`);
}
/**
 * Converte e valida configurações que precisam ser inteiros positivos,
 * como limites de lote, quantidade de usuários e timeouts.
 */
function requirePositiveInteger(name, raw) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid ${name} value: ${raw}`);
    }
    return value;
}
function parseStrictBoolean(name, raw) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true')
        return true;
    if (normalized === 'false')
        return false;
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
    emailSyncInitialMessages: requirePositiveInteger("EMAIL_SYNC_INITIAL_MESSAGES", emailSyncInitialMessagesRaw),
    emailSyncBatchSize: requirePositiveInteger("EMAIL_SYNC_BATCH_SIZE", emailSyncBatchSizeRaw),
    emailSyncMaxMessagesPerRun: requirePositiveInteger("EMAIL_SYNC_MAX_MESSAGES_PER_RUN", emailSyncMaxMessagesPerRunRaw),
    emailSyncMaxUsersPerRun: requirePositiveInteger("EMAIL_SYNC_MAX_USERS_PER_RUN", emailSyncMaxUsersPerRunRaw),
    emailPurchaseReconciliationWindowHours: requirePositiveInteger("EMAIL_PURCHASE_RECONCILIATION_WINDOW_HOURS", emailPurchaseReconciliationWindowHoursRaw),
    emailAttachmentMaxBytes: requirePositiveInteger("EMAIL_ATTACHMENT_MAX_BYTES", emailAttachmentMaxBytesRaw),
    cronSecret: process.env.CRON_SECRET ?? "",
    requestyApiKey: process.env.REQUESTY_API_KEY ?? "",
    requestyEmailModel: process.env.REQUESTY_EMAIL_MODEL ?? "nvidia/nemotron-3-nano-30b-a3b",
    requestyTimeoutMs: requirePositiveInteger("REQUESTY_TIMEOUT_MS", requestyTimeoutMsRaw),
    // Gemini é opcional porque a classificação determinística continua disponível.
    // A ausência da chave só impede o fallback de IA em casos ambíguos.
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    geminiModel: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
    geminiTimeoutMs: requirePositiveInteger("GEMINI_TIMEOUT_MS", geminiTimeoutMsRaw),
    geminiRateLimitCooldownMs: requirePositiveInteger("GEMINI_RATE_LIMIT_COOLDOWN_MS", geminiRateLimitCooldownMsRaw),
};
