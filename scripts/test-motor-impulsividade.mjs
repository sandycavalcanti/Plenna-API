import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = ['tests/rf018', 'tests/motor-impulsividade'].flatMap(folder => readdirSync(folder).filter(name => /\.test\.(mjs|ts)$/.test(name)).map(name => `${folder}/${name}`));
const result = spawnSync(process.execPath, ['--import','tsx','--import','./tests/saneamento/offline-env.mjs','--import','./tests/saneamento/offline-network.mjs','--loader','./tests/saneamento/source-loader.mjs','--experimental-vm-modules', '--test', ...files], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
