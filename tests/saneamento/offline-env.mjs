// Explicit fictitious values for offline tests; never import dotenv files.
Object.assign(process.env, {
 NODE_ENV:'test',DOTENV_CONFIG_PATH:'./.absent-offline-env',
 DATABASE_URL:'postgresql://localhost:1/offline',DIRECT_URL:'postgresql://localhost:1/offline',
 JWT_SECRET:'offline-only-not-a-real-secret',GOOGLE_CLIENT_ID:'offline',
 GOOGLE_CLIENT_SECRET:'offline',GOOGLE_REDIRECT_URI:'https://example.invalid',
 RECURRENCE_CRON_ENABLED:'false',
 EMAIL_SYNC_ENABLED:'false',EXPO_PUSH_ENABLED:'false',OAUTH_V2_LOCAL_ENABLED:'false',
 REQUESTY_API_KEY:'offline-only',CRON_SECRET:'cron-secret',
});
delete process.env.RF018_LOCAL;delete process.env.VERCEL;