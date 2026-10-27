// A seleção passa pelo mesmo ambiente fictício e bloqueio de rede da suíte completa.
process.argv.push('--rf018-only');
await import('./test-offline.mjs');
