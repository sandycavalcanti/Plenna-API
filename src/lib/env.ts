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
const emailSyncInitialMessagesRaw = process.env.EMAIL_SYNC_INITIAL_MESSAGES ?? "30";
const emailSyncBatchSizeRaw = process.env.EMAIL_SYNC_BATCH_SIZE ?? "25";
const emailSyncMaxMessagesPerRunRaw = process.env.EMAIL_SYNC_MAX_MESSAGES_PER_RUN ?? "25";
const emailSyncMaxUsersPerRunRaw = process.env.EMAIL_SYNC_MAX_USERS_PER_RUN ?? "10";
const emailPurchaseReconciliationWindowHoursRaw = process.env.EMAIL_PURCHASE_RECONCILIATION_WINDOW_HOURS ?? "48";
const emailAttachmentMaxBytesRaw = process.env.EMAIL_ATTACHMENT_MAX_BYTES ?? "10485760";
const emailFiscalLinkFetchEnabledRaw = process.env.EMAIL_FISCAL_LINK_FETCH_ENABLED ?? "false";
const emailFiscalLinkMaxBytesRaw = process.env.EMAIL_FISCAL_LINK_MAX_BYTES ?? "5242880";
const emailFiscalLinkTimeoutMsRaw = process.env.EMAIL_FISCAL_LINK_TIMEOUT_MS ?? "8000";
const emailFiscalLinkMaxRedirectsRaw = process.env.EMAIL_FISCAL_LINK_MAX_REDIRECTS ?? "3";
const emailFiscalLinkMaxPerEmailRaw = process.env.EMAIL_FISCAL_LINK_MAX_PER_EMAIL ?? "3";
const requestyTimeoutMsRaw = process.env.REQUESTY_TIMEOUT_MS ?? "8000";
const requestyRateLimitCooldownMsRaw = process.env.REQUESTY_RATE_LIMIT_COOLDOWN_MS ?? "60000";
const aiProvider = process.env.AI_PROVIDER ?? "requesty";
const codexLocalTimeoutMsRaw = process.env.CODEX_LOCAL_TIMEOUT_MS ?? "30000";
const requestyChatModel = process.env.REQUESTY_CHAT_MODEL ?? process.env.REQUESTY_EMAIL_MODEL ?? "nvidia/nemotron-3-nano-30b-a3b";
const chatMaxMessageCharsRaw = process.env.CHAT_MAX_MESSAGE_CHARS ?? "4000";
const chatContextMaxMessagesRaw = process.env.CHAT_CONTEXT_MAX_MESSAGES ?? "30";
const chatContextMaxCharsRaw = process.env.CHAT_CONTEXT_MAX_CHARS ?? "12000";
const aiMemoryAutomaticEnabledRaw = process.env.AI_MEMORY_AUTOMATIC_ENABLED ?? "false";
const aiMemoryAutomaticMaxContextCharsRaw = process.env.AI_MEMORY_AUTOMATIC_MAX_CONTEXT_CHARS ?? "1200";
const aiMemoryAutomaticTimeoutMsRaw = process.env.AI_MEMORY_AUTOMATIC_TIMEOUT_MS ?? "3000";
const aiToolMaxCallsRaw = process.env.AI_TOOL_MAX_CALLS ?? "8";
const aiToolMaxRoundsRaw = process.env.AI_TOOL_MAX_ROUNDS ?? "4";
const aiToolTimeoutMsRaw = process.env.AI_TOOL_TIMEOUT_MS ?? "20000";
const aiToolExecutionTimeoutMsRaw = process.env.AI_TOOL_EXECUTION_TIMEOUT_MS ?? "5000";
const aiToolResultMaxCharsRaw = process.env.AI_TOOL_RESULT_MAX_CHARS ?? "12000";
const recommendationAiEnabledRaw = process.env.AI_RECOMMENDATIONS_AI_ENABLED ?? "false";
const recommendationMaxCandidatesRaw = process.env.AI_RECOMMENDATIONS_MAX_CANDIDATES ?? "3";
const recommendationMaxContextCharsRaw = process.env.AI_RECOMMENDATIONS_MAX_CONTEXT_CHARS ?? "6000";
const recommendationTimeoutMsRaw = process.env.AI_RECOMMENDATIONS_TIMEOUT_MS ?? "5000";
const proactivityAiEnabledRaw = process.env.AI_PROACTIVITY_AI_ENABLED ?? "false";
const proactivityExternalApprovedRaw = process.env.AI_PROACTIVITY_EXTERNAL_APPROVED ?? "false";
const proactivityEnabledRaw = process.env.AI_PROACTIVITY_ENABLED ?? "false";
const proactivityCooldownDaysRaw = process.env.AI_PROACTIVITY_COOLDOWN_DAYS ?? "7";
const proactivityMaxCandidatesRaw = process.env.AI_PROACTIVITY_MAX_CANDIDATES ?? "3";
const proactivityMaxAttemptsRaw = process.env.AI_PROACTIVITY_MAX_ATTEMPTS ?? "1";
const proactivityMaxContextCharsRaw = process.env.AI_PROACTIVITY_MAX_CONTEXT_CHARS ?? "4000";
const proactivityTimeoutMsRaw = process.env.AI_PROACTIVITY_TIMEOUT_MS ?? "5000";
const proactivityQuietStartRaw = process.env.AI_PROACTIVITY_QUIET_START ?? "21:00";
const proactivityQuietEndRaw = process.env.AI_PROACTIVITY_QUIET_END ?? "08:00";
const proactivityTimezoneRaw = process.env.AI_PROACTIVITY_TIMEZONE ?? "America/Sao_Paulo";
const emailSyncEnabledRaw = process.env.EMAIL_SYNC_ENABLED ?? "true";
const expoPushEnabledRaw = process.env.EXPO_PUSH_ENABLED ?? "false";
const expoPushTimeoutMsRaw = process.env.EXPO_PUSH_TIMEOUT_MS ?? "5000";
const expoPushBatchSizeRaw = process.env.EXPO_PUSH_BATCH_SIZE ?? "100";
const expoPushMaxRetriesRaw = process.env.EXPO_PUSH_MAX_RETRIES ?? "2";
const expoPushRetryBaseDelayMsRaw = process.env.EXPO_PUSH_RETRY_BASE_DELAY_MS ?? "250";
const seasonalNotificationUserBatchSizeRaw = process.env.SEASONAL_NOTIFICATION_USER_BATCH_SIZE ?? "100";
const recurrenceCronEnabledRaw = process.env.RECURRENCE_CRON_ENABLED ?? "false";
const recurrenceProcessingBatchSizeRaw = process.env.RECURRENCE_PROCESSING_BATCH_SIZE ?? "25";
const recurrenceProcessingMaxOccurrencesPerRunRaw = process.env.RECURRENCE_PROCESSING_MAX_OCCURRENCES_PER_RUN ?? "25";
const recurrenceProcessingTransactionTimeoutMsRaw = process.env.RECURRENCE_PROCESSING_TRANSACTION_TIMEOUT_MS ?? "10000";
const aiAutomationEnabledRaw = process.env.AI_AUTOMATION_ENABLED ?? "false";
const aiAutomationBatchSizeRaw = process.env.AI_AUTOMATION_BATCH_SIZE ?? "5";
const aiAutomationMaxUsersRaw = process.env.AI_AUTOMATION_MAX_USERS ?? "25";
const aiAutomationTimeoutMsRaw = process.env.AI_AUTOMATION_TIMEOUT_MS ?? "50000";
const aiAutomationMaxErrorsRaw = process.env.AI_AUTOMATION_MAX_ERRORS ?? "5";
const aiAutomationMaxRecommendationCallsRaw = process.env.AI_AUTOMATION_MAX_RECOMMENDATION_CALLS ?? "25";
const aiAutomationMaxProactivityCallsRaw = process.env.AI_AUTOMATION_MAX_PROACTIVITY_CALLS ?? "25";
const aiAutomationTimezoneRaw = process.env.AI_AUTOMATION_TIMEZONE ?? "America/Sao_Paulo";

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

function requireBoundedPositiveInteger(name: string, raw: string, max: number): number {
  const value = requirePositiveInteger(name, raw);
  if (value > max) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  return value;
}

function requireNonNegativeInteger(name: string, raw: string): number {
  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0) {
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

function parseClock(name: string, raw: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw new Error(`Invalid ${name} value: ${raw}`);
  return raw;
}

function parseTimezone(name: string, raw: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw }).format();
  } catch {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  return raw;
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
  // Segredo independente, com ao menos 32 bytes; nunca versionar seu valor.
  rateLimitHmacKey: process.env.RATE_LIMIT_HMAC_KEY,
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
  emailFiscalLinkFetchEnabled: parseStrictBoolean("EMAIL_FISCAL_LINK_FETCH_ENABLED", emailFiscalLinkFetchEnabledRaw),
  emailFiscalLinkMaxBytes: requirePositiveInteger("EMAIL_FISCAL_LINK_MAX_BYTES", emailFiscalLinkMaxBytesRaw),
  emailFiscalLinkTimeoutMs: requirePositiveInteger("EMAIL_FISCAL_LINK_TIMEOUT_MS", emailFiscalLinkTimeoutMsRaw),
  emailFiscalLinkMaxRedirects: requireNonNegativeInteger("EMAIL_FISCAL_LINK_MAX_REDIRECTS", emailFiscalLinkMaxRedirectsRaw),
  emailFiscalLinkMaxPerEmail: requirePositiveInteger("EMAIL_FISCAL_LINK_MAX_PER_EMAIL", emailFiscalLinkMaxPerEmailRaw),
  expoPushEnabled: parseStrictBoolean("EXPO_PUSH_ENABLED", expoPushEnabledRaw),
  expoPushAccessToken: process.env.EXPO_PUSH_ACCESS_TOKEN ?? "",
  expoPushTimeoutMs: requirePositiveInteger("EXPO_PUSH_TIMEOUT_MS", expoPushTimeoutMsRaw),
  expoPushBatchSize: Math.min(requirePositiveInteger("EXPO_PUSH_BATCH_SIZE", expoPushBatchSizeRaw), 100),
  expoPushMaxRetries: requireNonNegativeInteger("EXPO_PUSH_MAX_RETRIES", expoPushMaxRetriesRaw),
  expoPushRetryBaseDelayMs: requireNonNegativeInteger("EXPO_PUSH_RETRY_BASE_DELAY_MS", expoPushRetryBaseDelayMsRaw),
  seasonalNotificationUserBatchSize: Math.min(
    requirePositiveInteger("SEASONAL_NOTIFICATION_USER_BATCH_SIZE", seasonalNotificationUserBatchSizeRaw),
    1000,
  ),
  recurrenceCronEnabled: parseStrictBoolean("RECURRENCE_CRON_ENABLED", recurrenceCronEnabledRaw),
  recurrenceProcessingBatchSize: Math.min(
    requirePositiveInteger("RECURRENCE_PROCESSING_BATCH_SIZE", recurrenceProcessingBatchSizeRaw),
    1000,
  ),
  recurrenceProcessingMaxOccurrencesPerRun: Math.min(
    requirePositiveInteger("RECURRENCE_PROCESSING_MAX_OCCURRENCES_PER_RUN", recurrenceProcessingMaxOccurrencesPerRunRaw),
    1000,
  ),
  recurrenceProcessingTransactionTimeoutMs: requirePositiveInteger(
    "RECURRENCE_PROCESSING_TRANSACTION_TIMEOUT_MS",
    recurrenceProcessingTransactionTimeoutMsRaw,
  ),
  aiAutomationEnabled: parseStrictBoolean("AI_AUTOMATION_ENABLED", aiAutomationEnabledRaw),
  aiAutomationBatchSize: requireBoundedPositiveInteger("AI_AUTOMATION_BATCH_SIZE", aiAutomationBatchSizeRaw, 100),
  aiAutomationMaxUsers: requireBoundedPositiveInteger("AI_AUTOMATION_MAX_USERS", aiAutomationMaxUsersRaw, 1000),
  aiAutomationTimeoutMs: requireBoundedPositiveInteger("AI_AUTOMATION_TIMEOUT_MS", aiAutomationTimeoutMsRaw, 300_000),
  aiAutomationMaxErrors: requireBoundedPositiveInteger("AI_AUTOMATION_MAX_ERRORS", aiAutomationMaxErrorsRaw, 100),
  aiAutomationMaxRecommendationCalls: requireBoundedPositiveInteger("AI_AUTOMATION_MAX_RECOMMENDATION_CALLS", aiAutomationMaxRecommendationCallsRaw, 1000),
  aiAutomationMaxProactivityCalls: requireBoundedPositiveInteger("AI_AUTOMATION_MAX_PROACTIVITY_CALLS", aiAutomationMaxProactivityCallsRaw, 1000),
  aiAutomationTimezone: parseTimezone("AI_AUTOMATION_TIMEZONE", aiAutomationTimezoneRaw),
  cronSecret: process.env.CRON_SECRET ?? "",
  requestyApiKey: process.env.REQUESTY_API_KEY ?? "",
  requestyEmailModel: process.env.REQUESTY_EMAIL_MODEL ?? "nvidia/nemotron-3-nano-30b-a3b",
  requestyChatModel,
  requestyTimeoutMs: requirePositiveInteger("REQUESTY_TIMEOUT_MS", requestyTimeoutMsRaw),
  requestyRateLimitCooldownMs: requirePositiveInteger("REQUESTY_RATE_LIMIT_COOLDOWN_MS", requestyRateLimitCooldownMsRaw),
  aiProvider,
  codexLocalTimeoutMs: requirePositiveInteger("CODEX_LOCAL_TIMEOUT_MS", codexLocalTimeoutMsRaw),
  chatMaxMessageChars: requireBoundedPositiveInteger("CHAT_MAX_MESSAGE_CHARS", chatMaxMessageCharsRaw, 4_000),
  chatContextMaxMessages: requirePositiveInteger("CHAT_CONTEXT_MAX_MESSAGES", chatContextMaxMessagesRaw),
  chatContextMaxChars: requirePositiveInteger("CHAT_CONTEXT_MAX_CHARS", chatContextMaxCharsRaw),
  aiMemoryAutomaticEnabled: parseStrictBoolean("AI_MEMORY_AUTOMATIC_ENABLED", aiMemoryAutomaticEnabledRaw),
  aiMemoryAutomaticMaxContextChars: requireBoundedPositiveInteger("AI_MEMORY_AUTOMATIC_MAX_CONTEXT_CHARS", aiMemoryAutomaticMaxContextCharsRaw, 4_000),
  aiMemoryAutomaticTimeoutMs: requireBoundedPositiveInteger("AI_MEMORY_AUTOMATIC_TIMEOUT_MS", aiMemoryAutomaticTimeoutMsRaw, 10_000),
  aiToolMaxCalls: requireBoundedPositiveInteger("AI_TOOL_MAX_CALLS", aiToolMaxCallsRaw, 32),
  aiToolMaxRounds: requireBoundedPositiveInteger("AI_TOOL_MAX_ROUNDS", aiToolMaxRoundsRaw, 12),
  aiToolTimeoutMs: requirePositiveInteger("AI_TOOL_TIMEOUT_MS", aiToolTimeoutMsRaw),
  aiToolExecutionTimeoutMs: requirePositiveInteger("AI_TOOL_EXECUTION_TIMEOUT_MS", aiToolExecutionTimeoutMsRaw),
  aiToolResultMaxChars: requireBoundedPositiveInteger("AI_TOOL_RESULT_MAX_CHARS", aiToolResultMaxCharsRaw, 50_000),
  recommendationAiEnabled: parseStrictBoolean("AI_RECOMMENDATIONS_AI_ENABLED", recommendationAiEnabledRaw),
  recommendationMaxCandidates: requireBoundedPositiveInteger("AI_RECOMMENDATIONS_MAX_CANDIDATES", recommendationMaxCandidatesRaw, 10),
  recommendationMaxContextChars: requireBoundedPositiveInteger("AI_RECOMMENDATIONS_MAX_CONTEXT_CHARS", recommendationMaxContextCharsRaw, 20_000),
  recommendationTimeoutMs: requireBoundedPositiveInteger("AI_RECOMMENDATIONS_TIMEOUT_MS", recommendationTimeoutMsRaw, 30_000),
  proactivityEnabled: parseStrictBoolean("AI_PROACTIVITY_ENABLED", proactivityEnabledRaw),
  proactivityAiEnabled: parseStrictBoolean("AI_PROACTIVITY_AI_ENABLED", proactivityAiEnabledRaw),
  proactivityExternalApproved: parseStrictBoolean("AI_PROACTIVITY_EXTERNAL_APPROVED", proactivityExternalApprovedRaw),
  proactivityCooldownDays: requireBoundedPositiveInteger("AI_PROACTIVITY_COOLDOWN_DAYS", proactivityCooldownDaysRaw, 365),
  proactivityMaxCandidates: requireBoundedPositiveInteger("AI_PROACTIVITY_MAX_CANDIDATES", proactivityMaxCandidatesRaw, 10),
  proactivityMaxAttempts: requireBoundedPositiveInteger("AI_PROACTIVITY_MAX_ATTEMPTS", proactivityMaxAttemptsRaw, 3),
  proactivityMaxContextChars: requireBoundedPositiveInteger("AI_PROACTIVITY_MAX_CONTEXT_CHARS", proactivityMaxContextCharsRaw, 20_000),
  proactivityTimeoutMs: requireBoundedPositiveInteger("AI_PROACTIVITY_TIMEOUT_MS", proactivityTimeoutMsRaw, 30_000),
  proactivityQuietStart: parseClock("AI_PROACTIVITY_QUIET_START", proactivityQuietStartRaw),
  proactivityQuietEnd: parseClock("AI_PROACTIVITY_QUIET_END", proactivityQuietEndRaw),
  proactivityTimezone: parseTimezone("AI_PROACTIVITY_TIMEZONE", proactivityTimezoneRaw),
  smtp: {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
  },
};
