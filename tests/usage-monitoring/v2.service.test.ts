import assert from 'node:assert/strict';
import test from 'node:test';
import { UsageService } from '../../src/modules/tempo-uso-v2/service.js';
import { memoryRepository } from './v2.memory.js';
import type { Snapshot } from '../../src/modules/tempo-uso-v2/contracts.js';
import { summarizeContextualUsage } from '../../src/modules/tempo-uso-v2/uso-contextual.adapter.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const secret='a'.repeat(64),install=id(1),start='2026-11-02T17:00:00Z',end='2026-11-02T18:00:00Z';
async function setup(){
  const db=memoryRepository();let now=new Date(start),counter=100;
  const service=new UsageService(db.repository,'offline-only-receipt-secret',()=>now,()=>id(counter++));
  const req={schemaVersion:2,operationId:id(2),installationId:install,expectedAssociationId:null,timezone:'America/Sao_Paulo',action:'ACTIVATE'};
  const result=await service.associate(7,req,secret);now=new Date(end);
  const snapshot=(revision=1,seconds=420):Snapshot=>({associationId:result.association.id,localDate:'2026-11-02',timezone:'America/Sao_Paulo',revision,observedAt:end,
    provenance:{source:'ANDROID_USAGE_EVENTS',collectorVersion:'events/2',catalogVersion:1},sourceStatus:'AVAILABLE',coverage:{interval:{start,end},completeness:'UNKNOWN',dayExtent:'PARTIAL_DAY'},qualityFlags:[],
    applications:[{packageId:'com.shopee.br',durationSeconds:seconds},{packageId:'com.mercadolibre',durationSeconds:0},{packageId:'com.zzkko',durationSeconds:0}]});
  return {db,service,result,req,snapshot,setNow:(v:string)=>{now=new Date(v);},ingest:(rev=1,seconds=420,batch=rev+10)=>service.ingest(7,{schemaVersion:2,batchId:id(batch),snapshots:[snapshot(rev,seconds)]},secret)};
}
test('service persists partial authorization, stable association retry and authenticated installation',async()=>{
  const h=await setup();assert.equal(h.result.association.eligibleFrom,new Date(start).toISOString());
  assert.equal(h.result.association.expiresAt,'2026-12-02T17:00:00.000Z');
  assert.deepEqual(await h.service.associate(7,h.req,secret),h.result);
  await assert.rejects(h.service.associate(8,{...h.req,operationId:id(50)},'b'.repeat(64)),/CREDENTIAL_INVALID/);
  assert.equal(h.db.state().associations.size,1);
});
test('service idempotent batches, stale revisions, downward correction and zero survive reload',async()=>{
  const h=await setup();const first=await h.ingest();assert.equal(first.results[0].status,'APPLIED');
  assert.deepEqual(await h.ingest(),first);assert.equal(h.db.state().snapshots.size,1);
  await h.ingest(2,300);assert.equal((await h.ingest(1,420,99)).results[0].status,'STALE');
  await h.ingest(3,0);const read=await h.service.summary(7,'2026-11');assert.equal(read.summary.totalRegisteredSeconds,0);
  await assert.rejects(h.ingest(3,1,98),/REVISION_CONFLICT/);
  await assert.rejects(h.ingest(4,1,13),/OPERATION_ID_REUSED/);
});
test('service source unavailable preserves last valid value and source status',async()=>{
  const h=await setup();await h.ingest();const s=h.snapshot();
  const {coverage,qualityFlags,applications,...base}=s as Extract<Snapshot,{sourceStatus:'AVAILABLE'}>;
  await h.service.ingest(7,{schemaVersion:2,batchId:id(40),snapshots:[{...base,revision:2,sourceStatus:'UNAVAILABLE',attemptedInterval:coverage.interval,reason:'QUERY_FAILED',applications:null}]},secret);
  const read=await h.service.summary(7,'2026-11');assert.equal(read.summary.sourceTotals.v2RegisteredSeconds,420);
  assert.equal(read.observations[0].sourceStatus,'UNAVAILABLE');assert.ok(read.observations[0].lastAvailable);
});

test('SHEIN snapshot persists and appears in monthly history using the canonical package catalog',async()=>{
  const h=await setup();
  const snapshot=h.snapshot(1,0);
  if(snapshot.sourceStatus!=='AVAILABLE')throw Error('AVAILABLE_FIXTURE_REQUIRED');
  snapshot.applications=snapshot.applications.map(app=>({...app,durationSeconds:app.packageId==='com.zzkko'?42:0}));
  const request={schemaVersion:2,batchId:id(301),snapshots:[snapshot]};
  const first=await h.service.ingest(7,request,secret);
  assert.equal(first.results[0].status,'APPLIED');
  assert.deepEqual(await h.service.ingest(7,request,secret),first);
  const read=await h.service.summary(7,'2026-11');
  assert.equal(read.summary.totalRegisteredSeconds,42);
  const observation=read.observations[0];
  assert.equal(observation.applications?.find(app=>app.packageId==='com.zzkko')?.durationSeconds,42);
  assert.equal(h.db.state().snapshots.size,1);
});
test('persistent tombstone suppresses partial application, preserves peers and future revisions',async()=>{
  const h=await setup();await h.ingest();
  const request={schemaVersion:2,operationId:id(60),target:{kind:'ACCOUNT'},scope:{kind:'PERIOD',interval:{start:'2026-11-02T17:10:00Z',end:'2026-11-02T17:11:00Z'},packageIds:['com.shopee.br']}};
  const deletion=await h.service.delete(7,request);assert.deepEqual(await h.service.delete(7,request),deletion);
  for(const rev of [2,3]){assert.equal((await h.ingest(rev,600)).results[0].status,'APPLIED_WITH_SUPPRESSIONS');
    const s=[...h.db.state().snapshots.values()][0];assert.equal(s.applications[0].durationSeconds,null);assert.equal(s.applications[1].durationSeconds,0);
    assert.equal('applications' in s.latest,false);assert.equal('applications' in s.available!,false);}
  assert.equal(JSON.stringify([...h.db.state().receipts.values()]).includes('durationSeconds'),false);
  assert.equal(h.db.state().tombstones.size,1);
});
test('logout, A-B-A, revocation, timezone and expiry enforce episode boundaries',async()=>{
  const h=await setup();await h.service.close(7,{schemaVersion:2,operationId:id(70),associationId:h.result.association.id,reason:'LOGOUT'},secret);
  await assert.rejects(h.ingest(),/NOT_ELIGIBLE|ASSOCIATION_NOT_ACTIVE/);
  const back=await h.service.associate(7,{...h.req,operationId:id(71),action:'RESUME'},secret);
  assert.equal(back.association.eligibleFrom,new Date(end).toISOString());assert.notEqual(back.association.id,h.result.association.id);
  const b=await h.service.associate(8,{...h.req,operationId:id(72)},secret);
  const a=await h.service.associate(7,{...h.req,operationId:id(73),action:'RESUME'},secret);
  assert.notEqual(a.association.id,back.association.id);assert.notEqual(a.association.id,b.association.id);
  const grant=[...h.db.state().authorizations.values()].find(g=>g.accountId===7)!;grant.revokedAt=end;
  await assert.rejects(h.service.associate(7,{...h.req,operationId:id(74),expectedAssociationId:a.association.id,action:'RESUME'},secret),/REAUTHORIZATION/);
  h.db.state().consents.set(7,false);await assert.rejects(h.ingest(),/CONSENT_REQUIRED/);
});
test('transaction failure rolls back snapshot, tombstone and receipt; concurrent replay does not duplicate',async()=>{
  const h=await setup();await Promise.all([h.ingest(),h.ingest()]);assert.equal(h.db.state().snapshots.size,1);
  h.db.failWrites();const before=structuredClone(h.db.state());
  await assert.rejects(h.service.delete(7,{schemaVersion:2,operationId:id(80),target:{kind:'ACCOUNT'},scope:{kind:'PERIOD',interval:{start,end},packageIds:null}}),/WRITE_FAILURE/);
  assert.deepEqual(h.db.state(),before);
});
test('foreign accounts cannot ingest/read/delete installation and legacy overlap stays separate',async()=>{
  const h=await setup();await h.ingest();await assert.rejects(h.service.ingest(8,{schemaVersion:2,batchId:id(91),snapshots:[h.snapshot()]},secret),/ASSOCIATION_NOT_FOUND/);
  assert.equal((await h.service.summary(8,'2026-11')).summary.totalRegisteredSeconds,null);
  h.db.state().legacy.push({tempo_uso_id:1,tempo_uso_nome:'Shopee',tempo_uso_package_id:'com.shopee.br',tempo_uso_inicio:new Date(start),tempo_uso_fim:new Date(end),tempo_uso_data_local:new Date('2026-11-02'),tempo_uso_data:new Date(start),tempo_uso_duracao_segundos:60,tempo_uso_minutos:1});
  const read=await h.service.summary(7,'2026-11');assert.equal(read.summary.totalRegisteredSeconds,null);assert.equal(read.summary.availability,'AMBIGUOUS');
  assert.equal(read.summary.sourceTotals.v2RegisteredSeconds,420);assert.equal(read.summary.sourceTotals.legacyRegisteredSeconds,60);
});
test('two installations persist distinct snapshots; RF018 describes data without identifying a buyer',async()=>{
  const h=await setup();h.setNow(start);
  const second=await h.service.associate(7,{...h.req,installationId:id(3),operationId:id(150)},'b'.repeat(64));h.setNow(end);
  await h.ingest();await h.service.ingest(7,{schemaVersion:2,batchId:id(151),snapshots:[{...h.snapshot(1,120),associationId:second.association.id}]},'b'.repeat(64));
  const read=await h.service.summary(7,'2026-11');assert.equal(read.summary.installationCount,2);assert.equal(read.summary.sourceTotals.v2RegisteredSeconds,540);
  const adapter=summarizeContextualUsage(read);assert.equal(adapter?.minutosRegistrados,9);assert.equal(adapter?.associacaoComCompra,'INDISPONIVEL');
  assert.ok(adapter&&'porAplicativo' in adapter&&adapter.porAplicativo.every(p=>typeof p.nome==='string'));
  h.db.state().consents.set(7,false);assert.equal(summarizeContextualUsage(await h.service.summary(7,'2026-11'))?.disponibilidade,'SEM_AUTORIZACAO');
});
test('different legacy applications in the same daily snapshot add once, without false duplicate overlap',async()=>{
  const h=await setup();const row={tempo_uso_id:1,tempo_uso_nome:'Shopee',tempo_uso_package_id:'com.shopee.br',tempo_uso_inicio:new Date(start),tempo_uso_fim:new Date(end),tempo_uso_data_local:new Date('2026-11-02'),tempo_uso_data:new Date(start),tempo_uso_duracao_segundos:60,tempo_uso_minutos:1};
  h.db.state().legacy.push(row,{...row,tempo_uso_id:2,tempo_uso_nome:'SHEIN',tempo_uso_package_id:'com.zzkko',tempo_uso_duracao_segundos:120});
  const read=await h.service.summary(7,'2026-11');assert.equal(read.summary.sourceTotals.legacyRegisteredSeconds,180);assert.equal(read.summary.totalRegisteredSeconds,180);
  h.db.state().legacy.push({...row,tempo_uso_id:3});assert.equal((await h.service.summary(7,'2026-11')).summary.availability,'AMBIGUOUS');
  h.db.state().legacy=[{...row,tempo_uso_duracao_segundos:null,tempo_uso_minutos:1.025}];assert.equal((await h.service.summary(7,'2026-11')).summary.sourceTotals.legacyRegisteredSeconds,62);
  h.db.state().legacy=[{...row,tempo_uso_duracao_segundos:null,tempo_uso_minutos:-5}];const invalid=await h.service.summary(7,'2026-11');assert.equal(invalid.summary.sourceTotals.legacyRegisteredSeconds,null);assert.equal(invalid.summary.totalRegisteredSeconds,null);
});
test('account switch during installation lock wait invalidates stale association; logout cannot extend a closed episode',async()=>{
  const h=await setup();const closed={...h.result.association,state:'CLOSED' as const,endedAt:'2026-11-02T17:30:00Z',closeReason:'ACCOUNT_SWITCH' as const};
  h.db.onNextInstallationLock(()=>{h.db.state().associations.set(closed.id,closed);});
  await assert.rejects(h.ingest(),/ASSOCIATION_NOT_ACTIVE/);assert.equal(h.db.state().snapshots.size,0);
  h.db.onNextInstallationLock(()=>{h.db.state().associations.set(closed.id,closed);});
  const result=await h.service.close(7,{schemaVersion:2,operationId:id(170),associationId:closed.id,reason:'LOGOUT'},secret);
  assert.equal(result.association.endedAt,closed.endedAt);assert.equal(result.association.closeReason,'ACCOUNT_SWITCH');
});
