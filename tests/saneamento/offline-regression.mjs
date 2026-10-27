import { client } from './runtime.mjs';
import axios from 'axios';
const blocked = async () => {
  throw new Error('Unmocked I/O prohibited in offline regression');
};
for (const name of [
  'tb_compra',
  'tb_compra_item',
  'tb_propaganda',
  'tb_categoria',
  'tb_metricas',
  'tb_forma_pagamento',
  'tb_preferencia',
  'tb_tempo_uso',
]) {
  client[name] = Object.fromEntries(
    [
      'findFirst',
      'findUnique',
      'findMany',
      'create',
      'createMany',
      'update',
      'updateMany',
      'deleteMany',
      'upsert',
      'aggregate',
      'count',
      'groupBy',
    ].map((method) => [method, blocked]),
  );
}
// Existing tests replace these methods with fixtures; any missed mock fails closed.
axios.get = blocked;
axios.post = blocked;
globalThis.fetch = blocked;

// Os testes legados substituem somente as dependencias que existem na develop.
process.env.REQUESTY_API_KEY = 'offline-requesty-key';
process.env.CRON_SECRET = 'cron-secret';
if (process.argv.some((value) => /gmail-attachment\.test\.js$/.test(value))) process.env.EMAIL_ATTACHMENT_MAX_BYTES = '32';
