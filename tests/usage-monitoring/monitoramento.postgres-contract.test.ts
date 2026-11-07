import test from 'node:test';
import assert from 'node:assert/strict';
import {monitoringRepository,transaction} from '../../src/modules/monitoramento/postgres.js';
import type {Prisma} from '@prisma/client';

function database(){
  const calls:{text:string;values:unknown[]}[]=[];
  const capture=(query:TemplateStringsArray|Prisma.Sql,values:unknown[])=>{const sql='strings' in query?query.strings.join('?'):Array.from(query).join('?');calls.push({text:sql,values:'values' in query?query.values:values});return sql;};
  const db={
    $queryRaw:async(query:TemplateStringsArray|Prisma.Sql,...values:unknown[])=>{const sql=capture(query,values);if(sql.includes('usuario_status=true'))return [{usuario_id:7}];if(sql.includes('count(*)'))return [{openings:0n,open:0n,duration:0}];return [];},
    $executeRaw:async(query:TemplateStringsArray|Prisma.Sql,...values:unknown[])=>{capture(query,values);return 0;}
  };
  return {db:db as unknown as Pick<Prisma.TransactionClient,'$queryRaw'|'$executeRaw'>,calls};
}
test('read-only repository path does not take the exclusive account lock',async()=>{const h=database();const options:unknown[]=[];const repo=monitoringRepository({$transaction:async(work:any,option:any)=>{options.push(option);return work(h.db);}});await repo.read(7,tx=>tx.month(7,'2026-11'));assert.ok(h.calls.every(q=>!q.text.includes('FOR UPDATE')));assert.equal((options[0] as any).isolationLevel,'RepeatableRead');await repo.write(7,tx=>tx.consent(7));assert.match(h.calls[h.calls.length-2].text,/FOR UPDATE/);});
test('history query binds account, day and cursor; deletion overlay is enforced in SQL',async()=>{const h=database();await transaction(h.db).page(7,'2026-11-06',{id:'9007199254740993',start:'2026-11-06T12:00:00Z',key:'00000000-0000-4000-8000-000000000001'},21);const q=h.calls[0];assert.match(q.text,/d.usuario_id=/);assert.match(q.text,/NOT EXISTS/);assert.match(q.text,/ORDER BY d.diario_id,a.inicio_utc,a.chave_acesso LIMIT/);assert.ok(q.values.includes('9007199254740993'));assert.ok(q.values.includes(7));assert.ok(q.values.includes(21));});
test('daily history never loads individual accesses; legacy retains civil-time fallback',async()=>{const h=database();const tx=transaction(h.db);await tx.month(7,'2026-11');await tx.legacy(7,'2026-11');assert.ok(!h.calls[0].text.includes('tb_monitoramento_acesso'));assert.match(h.calls[1].text,/America\/Sao_Paulo/);assert.match(h.calls[1].text,/tempo_uso_data_local IS NULL/);});
test('access upsert writes only differences and sends UUIDs as bound values',async()=>{const h=database();await transaction(h.db).putAccesses('9007199254740993',[{key:'00000000-0000-4000-8000-000000000001',start:'2026-11-06T12:00:00Z',end:null,quality:69}]);assert.match(h.calls[0].text,/IS DISTINCT FROM/);assert.ok(h.calls[0].values.includes('9007199254740993'));});

test('descriptive SQL counts collector 4 independent/resumption bits; prior starts stay unknown',async()=>{
 const h=database();const stats=await transaction(h.db).accessStats(7,'2026-11-01','2026-12-01');const sql=h.calls[0].text;
 assert.match(sql,/versao_coletor>=4 AND \(a.qualidade & 257\)=257/);assert.match(sql,/qualidade & 513/);assert.match(sql,/versao_coletor<4 OR/);assert.match(sql,/AS intervals/);assert.equal(stats.identifiedOpenings,0);
});
