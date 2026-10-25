// A sele??o passa pelo mesmo ambiente fict?cio e bloqueio de rede da su?te completa.
process.argv.push('--rf018-only');
await import('./test-offline.mjs');
