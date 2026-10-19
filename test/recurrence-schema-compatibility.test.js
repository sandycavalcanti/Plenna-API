import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma/schema.prisma');
const schema = await readFile(schemaPath, 'utf8');

function modelBody(name) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `model ${name} deve existir`);
  return match[1];
}

test('Prisma representa os nomes e tipos físicos aprovados para recorrências', () => {
  const recurrence = modelBody('tb_compra_recorrencia');
  const purchase = modelBody('tb_compra');
  const item = modelBody('tb_compra_item');

  assert.match(recurrence, /forma_pagamento_id\s+Int\s*$/m);
  assert.match(recurrence, /compra_recorrencia_fonte\s+String\?\s+@db\.VarChar\(45\)/);
  assert.match(recurrence, /compra_recorrencia_frequencia\s+String\s+@db\.VarChar\(10\)/);
  assert.match(recurrence, /compra_recorrencia_status\s+String\s+@default\("ATIVA"\)\s+@db\.VarChar\(12\)/);
  assert.match(recurrence, /compra_recorrencia_primeira_ocorrencia\s+DateTime\s+@db\.Date/);
  assert.match(recurrence, /compra_recorrencia_proxima_ocorrencia\s+DateTime\?\s+@db\.Date/);
  assert.match(recurrence, /compra_recorrencia_data_final\s+DateTime\?\s+@db\.Date/);
  assert.match(recurrence, /compra_recorrencia_data_criacao\s+DateTime[\s\S]*@db\.Timestamptz\(6\)/);
  assert.match(recurrence, /compra_recorrencia_data_modificacao\s+DateTime[\s\S]*@db\.Timestamptz\(6\)/);

  assert.doesNotMatch(recurrence, /compra_recorrencia_frequencia_enum/);
  assert.doesNotMatch(recurrence, /compra_recorrencia_status_enum/);
  assert.match(purchase, /compra_recorrencia_id\s+Int\?/);
  assert.match(purchase, /compra_recorrencia_data_prevista\s+DateTime\?\s+@db\.Date/);
  assert.match(item, /compra_id\s+Int\?/);
  assert.match(item, /compra_recorrencia_id\s+Int\?/);
});

