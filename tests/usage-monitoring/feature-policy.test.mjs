import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source=fs.readFileSync(new URL('../../src/modules/tempo-uso-v2/policy.ts',import.meta.url),'utf8');
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;

// Avalia somente a policy, sem importar app, Prisma, .env ou alterar o processo real.
for(const [value,enabled]of [[undefined,false],['false',false],['TRUE',false],['1',false],['true ',false],[' true',false],[true,false],['true',true]]){
 test(`USAGE_MONITORING_ENABLED: ${String(value)} -> ${enabled}`,()=>{
  const exports={},isolatedProcess={env:value===undefined?{}:{USAGE_MONITORING_ENABLED:value}};
  new Function('exports','process',output)(exports,isolatedProcess);
  assert.equal(exports.isUsageMonitoringEnabled(),enabled);
 });
}

test('a variável anterior sozinha não habilita; a nova configuração explícita prevalece',()=>{
 for(const [next,enabled]of [[undefined,false],['false',false],['true',true]]){
  const exports={},env={RF017_V2_ENABLED:'true'};
  if(next!==undefined)env.USAGE_MONITORING_ENABLED=next;
  new Function('exports','process',output)(exports,{env});
  assert.equal(exports.isUsageMonitoringEnabled(),enabled);
 }
});
