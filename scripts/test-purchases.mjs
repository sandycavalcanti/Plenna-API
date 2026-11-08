import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ["--import", "tsx", "--import", "./tests/saneamento/offline-env.mjs", "--import", "./tests/saneamento/offline-network.mjs", "--test", "tests/financeiro/historico-compras.test.mjs", "tests/financeiro/historico-eventos.test.mjs", "tests/financeiro/periodo-conta.test.mjs", "tests/motor-impulsividade/integridade-compra.test.mjs", "tests/motor-impulsividade/fronteiras-civis.test.mjs"], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
