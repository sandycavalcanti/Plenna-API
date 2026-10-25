// Generates SQL only; inputs are datamodels and the datasource is an unreachable loopback sentinel.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const schema = await readFile('prisma/schema.prisma', 'utf8');
// Synthetic baseline is the current datamodel minus ONLY these two proposed models.
// It is not a dump or an assertion about the configured database's migration history.
const baseline = schema
  .replace(
    /^model (?:tb_compra_evento|tb_referencia_financeira) \{[\s\S]*?^\}\r?\n/gm,
    '',
  )
  .replace(
    /^.*\b(?:tb_compra_evento|tb_referencia_financeira)\[\].*\r?\n/gm,
    '',
  );
async function diff(from, to) {
  return new Promise((resolveSql, reject) => {
    const child = spawn(
      resolve('node_modules/@prisma/engines/schema-engine-windows.exe'),
      [
        '--datasource',
        JSON.stringify({
          url: 'postgresql://offline:offline@127.0.0.1:1/offline',
        }),
      ],
      {
        env: Object.fromEntries(
          ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
            .filter((k) => process.env[k])
            .map((k) => [k, process.env[k]]),
        ),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let buffer = '',
      sql = '',
      done = false;
    const timer = setTimeout(
      () => finish(Error('OFFLINE_SCHEMA_TIMEOUT')),
      30000,
    );
    function finish(e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      e ? reject(e) : resolveSql(sql);
    }
    child.on('error', finish);
    child.stderr.on('data', () => {});
    child.on('exit', () => {
      if (!done) finish(Error('OFFLINE_SCHEMA_EXIT'));
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let p;
      while ((p = buffer.indexOf('\n')) >= 0) {
        const m = JSON.parse(buffer.slice(0, p));
        buffer = buffer.slice(p + 1);
        if (m.method === 'print') {
          sql += m.params.content;
          child.stdin.write(
            JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n',
          );
        }
        if (m.id === 1 && !m.method)
          finish(m.error ? Error(JSON.stringify(m.error)) : undefined);
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'diff',
        params: {
          from,
          to,
          script: true,
          shadowDatabaseUrl: null,
          exitCode: null,
          filters: { externalTables: [], externalEnums: [] },
        },
      }) + '\n',
    );
  });
}
const model = (text) => ({
  tag: 'schemaDatamodel',
  files: [{ path: 'schema.prisma', content: text }],
});
await mkdir('.expo', { recursive: true });
await writeFile(
  '.expo/gestao-full-schema.sql',
  await diff({ tag: 'empty' }, model(schema)),
);
await writeFile(
  '.expo/gestao-baseline.sql',
  await diff({ tag: 'empty' }, model(baseline)),
);
console.log(
  'SQL sintetico gerado sem conexao com banco e sem alterar migrations.',
);
