import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ["--import", "tsx", "--import", "./tests/saneamento/offline-env.mjs", "--import", "./tests/saneamento/offline-network.mjs", "--loader", "./tests/saneamento/source-loader.mjs", "--experimental-vm-modules", "--test", "test/dashboard-analytics.test.js", "test/financial-baseline.test.js", "tests/financeiro/resumo.test.mjs", "tests/reconciliacao/indicadores.test.mjs", "tests/motor-impulsividade/panorama.test.mjs"], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
