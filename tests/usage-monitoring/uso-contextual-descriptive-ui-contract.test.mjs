import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';

async function harness({consent=true,ambiguous=false}={}){
 const calls={summary:0,access:0};
 const read={migrated:true,consentActive:consent,summary:{availability:ambiguous?'AMBIGUOUS':'PARTIAL',coverage:'PARTIAL',references:[{associationId:'context/day',localDate:'2026-11-07',revision:1}]},observations:[{localDate:'2026-11-07',sourceStatus:'AVAILABLE',applications:[{packageId:'com.zzkko',durationMs:49657,durationSeconds:49,suppression:null}]}]};
 const original=JSON.stringify(read);
 const context=vm.createContext({});
 const source=ts.transpileModule(fs.readFileSync(new URL('../../src/modules/tempo-uso-v2/uso-contextual.adapter.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const module=new vm.SourceTextModule(source,{context});
 await module.link(async name=>{
  const exports=name.includes('runtime')?{getMonitoringService:()=>({summary:async(account,month)=>{assert.equal(account,8);assert.equal(month,'2026-11');calls.summary++;return read;},descriptiveAccess:async(account,month)=>{assert.equal(account,8);assert.equal(month,'2026-11');calls.access++;return {identifiedOpenings:1,identifiedResumptions:1,knownDurationMs:49657,coverage:'PARTIAL',semantics:'OBSERVED_ACCESS_CONTEXT_NOT_CAUSAL'};}})}:{encontrarAplicativoCompra:()=>({nomeApp:'SHEIN'})};
  const mock=new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context});await mock.link(()=>{});await mock.evaluate();return mock;
 });await module.evaluate();
 return {calls,read,original,run:(...args)=>module.namespace.descriptiveUsage(...args)};
}
test('default RF018 path still reads descriptive accesses, precision and quality after the UI hides them',async()=>{
 const h=await harness();const result=await h.run(8,'2026-11');
 assert.equal(h.calls.access,1);assert.ok(Math.abs(result.minutosRegistrados*60000-49657)<0.000001);
 assert.equal(result.acessos.identifiedOpenings,1);assert.equal(result.acessos.identifiedResumptions,1);
 assert.equal(result.acessos.knownDurationMs,49657);assert.equal(result.qualidade.coverage,'PARTIAL');
 assert.equal(result.associacaoComCompra,'INDISPONIVEL');assert.equal(result.referencias.length,1);
 assert.equal(JSON.stringify(h.read),h.original);
});
test('optional summary-only reads do not query accesses or mutate the internal source',async()=>{
 const h=await harness();const result=await h.run(8,'2026-11',false);
 assert.equal(h.calls.access,0);assert.equal(result.acessos,undefined);
 assert.ok(Math.abs(result.minutosRegistrados*60000-49657)<0.000001);assert.equal(JSON.stringify(h.read),h.original);
});
test('revoked consent never exposes descriptive history',async()=>{
 const h=await harness({consent:false});const result=await h.run(8,'2026-11');
 assert.equal(h.calls.access,0);assert.equal(result.disponibilidade,'SEM_AUTORIZACAO');assert.equal(result.minutosRegistrados,null);
});
test('ambiguous sources do not fabricate time or a purchase association',async()=>{
 const h=await harness({ambiguous:true});const result=await h.run(8,'2026-11');
 assert.equal(result.minutosRegistrados,null);assert.equal(result.motivo,'FONTES_SOBREPOSTAS');assert.equal(result.associacaoComCompra,'INDISPONIVEL');
});
