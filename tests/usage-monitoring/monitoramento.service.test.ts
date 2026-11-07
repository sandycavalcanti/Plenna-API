import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitoringService } from '../../src/modules/monitoramento/service.js';
import { accessKey } from '../../src/modules/monitoramento/model.js';
import { memoryMonitoring } from './monitoramento.memory.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,secret='a'.repeat(64),installation=id(1),session=id(2);
async function fixture(){
  const db=memoryMonitoring();let now=new Date('2026-11-06T12:00:00Z'),counter=100;
  const service=new MonitoringService(db.repository,()=>now,()=>id(counter++));
  const request={schemaVersion:3,installationId:installation,sessionId:session,expectedContextId:null,timezone:'America/Sao_Paulo',activate:true};
  const challenge=await service.prepare(7,request,secret);
  const first=await service.prepare(7,{...request,activationProof:challenge.activationChallenge},secret);now=new Date('2026-11-06T13:00:00Z');
  const prepare=()=>service.prepare(7,{...request,expectedContextId:first.contextId,activate:false},secret);
  const ready=await prepare();
  const observation={localDate:'2026-11-06',packageId:'com.zzkko',expectedVersion:0,interval:{start:'2026-11-06T12:00:00.000Z',end:'2026-11-06T13:00:00.000Z'},status:'AVAILABLE',durationMs:600000,quality:64,collectorVersion:3,accesses:[{origin:'2026-11-06T12:10:00.000Z',start:'2026-11-06T12:10:00.000Z',end:'2026-11-06T12:20:00.000Z',quality:67}],corrections:[]};
  const body={schemaVersion:3,installationId:installation,sessionId:session,contextId:ready.contextId,collectionId:ready.collectionId,observations:[observation]};
  return {db,service,request,body,ready,prepare,observation};
}
test('effect idempotence: lost response does not insert or update twice',async()=>{const h=await fixture();await h.service.ingest(7,h.body,secret);const writes=h.db.state().writes;const replay=await h.service.ingest(7,h.body,secret);assert.equal(replay.results[0].status,'DUPLICATE');assert.equal(h.db.state().writes,writes);assert.equal(h.db.state().accesses.get('1')?.length,1);});
test('new preparation fences a previous capture even if no daily value changed',async()=>{const h=await fixture();await h.prepare();await assert.rejects(h.service.ingest(7,h.body,secret),/STALE_COLLECTION/);});
test('expired events cannot erase a valid total',async()=>{const h=await fixture();await h.service.ingest(7,h.body,secret);await assert.rejects(h.service.ingest(7,{...h.body,observations:[{...h.observation,expectedVersion:1,durationMs:0,accesses:[]}]},secret),/CORRECTION_EVIDENCE/);assert.equal(h.db.state().days.get('1')?.duration,600000);});
test('explicit atomic correction to zero and its retry',async()=>{const h=await fixture();await h.service.ingest(7,h.body,secret);const key=accessKey(h.ready.contextId,'com.zzkko',h.observation.accesses[0].origin);const body={...h.body,observations:[{...h.observation,expectedVersion:1,durationMs:0,accesses:[],corrections:[{previousKey:key,replacement:null,reason:'EVENT_RECONSTRUCTION'}]}]};await h.service.ingest(7,body,secret);await h.service.ingest(7,body,secret);assert.equal(h.db.state().days.get('1')?.duration,0);assert.equal(h.db.state().accesses.get('1')?.length,0);});
test('partial/unavailable query retains last valid values and intervals',async()=>{const h=await fixture();await h.service.ingest(7,h.body,secret);await h.service.ingest(7,{...h.body,observations:[{...h.observation,expectedVersion:1,status:'UNAVAILABLE',durationMs:null,accesses:[]}]},secret);assert.equal(h.db.state().days.get('1')?.duration,600000);assert.equal(h.db.state().days.get('1')?.state,2);assert.equal(h.db.state().accesses.get('1')?.length,1);});
test('account switch rejects old collection; credential is independent of account',async()=>{const h=await fixture();await assert.rejects(h.service.prepare(8,{...h.request,sessionId:id(3)},'b'.repeat(64)),/CREDENTIAL_INVALID/);const req={...h.request,sessionId:id(3)},challenge=await h.service.prepare(8,req,secret);await h.service.prepare(8,{...req,activationProof:challenge.activationChallenge},secret);await assert.rejects(h.service.ingest(7,h.body,secret),/ASSOCIATION_CHANGED/);});
test('revocation and detailed consent are checked at write time',async()=>{const h=await fixture();h.db.state().detailed=false;await assert.rejects(h.service.ingest(7,h.body,secret),/DETAILED_CONSENT_REQUIRED/);h.db.state().consent=false;await assert.rejects(h.service.ingest(7,h.body,secret),/CONSENT_REQUIRED/);});
test('deletion erases details and permanently suppresses reimport',async()=>{const h=await fixture();await h.service.ingest(7,h.body,secret);await h.service.delete(7,{schemaVersion:2,operationId:id(9),target:{kind:'ACCOUNT'},scope:{kind:'APP_DAY',packageId:'com.zzkko',localDate:'2026-11-06',timezone:'America/Sao_Paulo'}});await h.service.ingest(7,{...h.body,observations:[{...h.observation,expectedVersion:2}]},secret);assert.equal(h.db.state().days.get('1')?.duration,null);assert.equal(h.db.state().accesses.get('1')?.length??0,0);});
test('concurrent different writes conflict and the losing batch rolls back',async()=>{const h=await fixture();const values=await Promise.allSettled([h.service.ingest(7,h.body,secret),h.service.ingest(7,{...h.body,observations:[{...h.observation,durationMs:700000}]},secret)]);assert.equal(values.filter(v=>v.status==='fulfilled').length,1);assert.equal(h.db.state().writes,1);});
test('open access has no fabricated end or duration',async()=>{const h=await fixture();await h.service.ingest(7,{...h.body,observations:[{...h.observation,durationMs:0,accesses:[{...h.observation.accesses[0],end:null,quality:69}]}]},secret);assert.equal(h.db.state().accesses.get('1')?.[0].end,null);});
test('stale activation proof cannot resurrect a logged-out context',async()=>{const h=await fixture();const req={...h.request,sessionId:id(4)},old=await h.service.prepare(7,req,secret);await h.service.close(7,{schemaVersion:3,installationId:installation,sessionId:session,contextId:h.ready.contextId},secret);const replay=await h.service.prepare(7,{...req,activationProof:old.activationChallenge},secret);assert.ok(replay.activationChallenge);assert.notEqual(replay.activationChallenge,old.activationChallenge);assert.equal(h.db.state().installations.get(installation)?.account,null);});
test('cursor pagination remains account-scoped and unknown durations remain null',async()=>{const h=await fixture();await h.service.ingest(7,h.body,secret);assert.equal((await h.service.accessPage(7,'2026-11-06',null,1)).items.length,1);assert.equal((await h.service.accessPage(8,'2026-11-06',null,1)).items.length,0);const all=await h.service.accessPage(7,'2026-11-06',null,1);assert.equal(all.stats.identifiedOpenings,0);assert.equal(all.stats.unknownEntries,1);assert.equal(all.stats.knownDurationMs,600000);});
test('failed second observation rolls back every write in the batch',async()=>{const h=await fixture();await assert.rejects(h.service.ingest(7,{...h.body,observations:[h.observation,{...h.observation,packageId:'outside.catalog'}]},secret),/SNAPSHOT_NOT_ELIGIBLE/);assert.equal(h.db.state().days.size,0);assert.equal(h.db.state().accesses.size,0);});
test('different apps in one daily window sum without false overlap; exclusion is not zero',async()=>{const h=await fixture();await h.service.ingest(7,{...h.body,observations:[h.observation,{...h.observation,packageId:'com.shopee.br'}]},secret);const read=await h.service.summary(7,'2026-11');assert.equal(read.summary.totalRegisteredSeconds,1200);assert.equal(read.summary.availability,'PARTIAL');await h.service.delete(7,{schemaVersion:2,operationId:id(9),target:{kind:'ACCOUNT'},scope:{kind:'PERIOD',interval:h.observation.interval,packageIds:null}});const deleted=await h.service.summary(7,'2026-11');assert.equal(deleted.summary.totalRegisteredSeconds,null);assert.equal(deleted.installations[0].registeredSeconds,null);});
test('overlapping legacy snapshots remain ambiguous instead of being summed twice',async()=>{const h=await fixture();const row={tempo_uso_id:1,tempo_uso_nome:'SHEIN',tempo_uso_package_id:'com.zzkko',tempo_uso_inicio:new Date(h.observation.interval.start),tempo_uso_fim:new Date(h.observation.interval.end),tempo_uso_data_local:new Date('2026-11-06T00:00:00Z'),tempo_uso_data:null,tempo_uso_duracao_segundos:600,tempo_uso_minutos:10};h.db.state().legacy.push(row,{...row,tempo_uso_id:2});const read=await h.service.summary(7,'2026-11');assert.equal(read.summary.availability,'AMBIGUOUS');assert.equal(read.summary.totalRegisteredSeconds,null);assert.equal(read.summary.sourceTotals.legacyRegisteredSeconds,null);});


test('Galaxy lock: distinct interval keys, no lock gap, resumption is not an independent opening',async()=>{
 const h=await fixture(),start=Date.parse(h.observation.accesses[0].start);
 const access=(offset:number,duration:number,quality:number)=>({origin:new Date(start+offset).toISOString(),start:new Date(start+offset).toISOString(),end:new Date(start+offset+duration).toISOString(),quality});
 const observations=[{...h.observation,collectorVersion:4,quality:8192,durationMs:1299,accesses:[
 access(0,299,1|2|1024|4096),access(75000,500,1|2|512),access(90000,500,1|2|256)]}];
 const body={...h.body,observations};await h.service.ingest(7,body,secret);await h.service.ingest(7,body,secret);
 const page=await h.service.accessPage(7,'2026-11-06',null,20);
 assert.equal(new Set(page.items.map(a=>a.key)).size,3);assert.equal(page.items[0].collectorVersion,4);
 assert.deepEqual(page.stats,{identifiedOpenings:1,observedIntervals:3,identifiedResumptions:1,unknownEntries:1,openSegments:0,knownDurationMs:1299});
 const context=await h.service.descriptiveAccess(7,'2026-11');assert.equal(context.identifiedOpenings,1);assert.equal(context.identifiedResumptions,1);assert.equal(context.semantics,'OBSERVED_ACCESS_CONTEXT_NOT_CAUSAL');
});
test('collector 4 rejects contradictory or missing entry evidence and legacy cannot assert new bits',async()=>{
 for(const [collectorVersion,quality] of [[4,3],[4,1|2|256|512],[3,1|2|256]]) {
  const h=await fixture();await assert.rejects(h.service.ingest(7,{...h.body,observations:[{...h.observation,collectorVersion,accesses:[{...h.observation.accesses[0],quality}]}]},secret),/INVALID_ENTRY_CLASSIFICATION/);
  assert.equal(h.db.state().days.size,0);
 }
});

test('a legacy client cannot downgrade corrected evidence or assert collector 4 daily flags',async()=>{
 const h=await fixture();
 const corrected={...h.observation,collectorVersion:4,quality:8192,accesses:[{...h.observation.accesses[0],quality:1027}]};
 await h.service.ingest(7,{...h.body,observations:[corrected]},secret);
 await assert.rejects(h.service.ingest(7,{...h.body,observations:[{...h.observation,expectedVersion:1}]},secret),/COLLECTOR_VERSION_REGRESSION/);
 assert.equal(h.db.state().days.get('1')?.collector,4);
 const old=await fixture();await assert.rejects(old.service.ingest(7,{...old.body,observations:[{...old.observation,quality:8192}]},secret),/INVALID_COLLECTOR_QUALITY/);
});

test('monthly Dashboard preserves subsecond time and exposes only authorized descriptive entry metrics',async()=>{
 const h=await fixture();const first=h.observation.accesses[0];
 await h.service.ingest(7,{...h.body,observations:[{...h.observation,collectorVersion:4,quality:8192,durationMs:299,accesses:[{...first,end:new Date(Date.parse(first.start)+299).toISOString(),quality:259}]}]},secret);
 const read:any=await h.service.summary(7,'2026-11');
 assert.equal(read.summary.totalRegisteredMs,299);assert.equal(read.summary.totalRegisteredSeconds,0);
 assert.equal(read.summary.sourceTotals.v2RegisteredMs,299);assert.equal(read.observations[0].applications[0].durationMs,299);
 assert.equal(read.accessStats.identifiedOpenings,1);assert.equal(read.accessStats.identifiedResumptions,0);
 const {summarizeContextualUsage}=await import('../../src/modules/tempo-uso-v2/uso-contextual.adapter.js');
 assert.equal(summarizeContextualUsage(read)?.minutosRegistrados,299/60000);
 h.db.state().detailed=false;
 const withoutDetails:any=await h.service.summary(7,'2026-11');assert.equal(withoutDetails.accessStats,null);assert.equal(withoutDetails.summary.totalRegisteredMs,299);
 h.db.state().consent=false;
 const revoked=await h.service.summary(7,'2026-11');assert.equal(revoked.consentActive,false);assert.equal(revoked.summary.totalRegisteredMs,299);
});
