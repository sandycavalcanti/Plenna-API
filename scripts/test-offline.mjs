// All suites use fictitious environment and an explicit network guard; no database launcher.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const env = { ...process.env };
for (const key of Object.keys(env))
  if (
    /DATABASE|DIRECT_URL|JWT_SECRET|REQUESTY|GOOGLE_CLIENT|SMTP_|PGHOST|PGUSER|PGPASSWORD|PGDATABASE|RF018_|MAIN_LOCAL|NODE_OPTIONS|VERCEL|CODEX_/.test(
      key.toUpperCase(),
    )
  )
    delete env[key];
Object.assign(env, {
  NODE_ENV: 'test',
  DOTENV_CONFIG_PATH: '.absent-offline-env',
  DATABASE_URL: 'postgresql://localhost:1/offline',
  DIRECT_URL: 'postgresql://localhost:1/offline',
  JWT_SECRET: 'offline-only-test-secret',
  GOOGLE_CLIENT_ID: 'offline-client',
  GOOGLE_CLIENT_SECRET: 'offline-secret',
  GOOGLE_REDIRECT_URI: 'https://example.invalid/callback',
  RECURRENCE_CRON_ENABLED: 'false',
  EMAIL_SYNC_ENABLED: 'false',
  EXPO_PUSH_ENABLED: 'false',
  OAUTH_V2_LOCAL_ENABLED: 'false',
  REQUESTY_API_KEY: 'offline-only',
  CRON_SECRET: 'cron-secret',
  CHECKPOINT_DISABLE: '1',
});
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(dir + '/' + e.name) : [dir + '/' + e.name],
  );
const dirs = [
  'rf018',
  'financeiro',
  'preferencia',
  'chat',
  'rf017',
  'rf019',
  'notification',
  'push',
  'seasonal',
  'reconciliacao',
];
const selectedDirs = process.argv.includes('--rf018-only') ? ['rf018'] : dirs;
const files = selectedDirs.flatMap((d) =>
  walk('tests/' + d).filter((p) => /\.test\.(mjs|ts)$/.test(p)),
);
if (!process.argv.includes('--rf018-only'))
  files.push(
    ...[
      'oauth.test.mjs',
      'oauth-http.test.mjs',
      'email-sync-security.test.mjs',
      'redefinicao.test.mjs',
    ].map((n) => 'tests/saneamento/' + n),
  );
const prefix = [
  '--experimental-vm-modules',
  '--import',
  './tests/saneamento/offline-env.mjs',
  '--import',
  './tests/saneamento/offline-network.mjs',
  '--import',
  'tsx',
];
const legacy = JSON.parse(readFileSync('package.json', 'utf8'))
  .scripts['test:gmail:offline'].split(/\s+/)
  .filter((x) => x.endsWith('.test.js'));
// Run integration additions against current TypeScript, never stale dist output.
const additions = [
  'dashboard-analytics',
  'financial-baseline',
  'recurrence-crud',
  'recurrence-engine',
  'recurrence-cron',
  'recurrence-schema-compatibility',
].map((name) => `test/${name}.test.js`);
const suites = process.argv.includes('--novidades-only')
  ? []
  : [
      [...prefix, '--test', ...files],
      ...(process.argv.includes('--rf018-only')
        ? []
        : [
            [
              ...prefix,
              '--import',
              './tests/saneamento/offline-regression.mjs',
              '--loader',
              './tests/saneamento/source-loader.mjs',
              '--test',
              ...legacy,
            ],
          ]),
    ];
if (!process.argv.includes('--rf018-only'))
  suites.push([
    ...prefix,
    '--loader',
    './tests/saneamento/source-loader.mjs',
    '--test',
    ...additions,
  ]);
let failed = false;
for (const args of suites) {
  const r = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}

if (failed) process.exitCode = 1;
