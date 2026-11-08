import assert from 'node:assert/strict';
import test from 'node:test';
// Prepared only. The offline runner cannot enable this test or apply migrations.
test('Monitoramento de tempo em aplicativos PostgreSQL: prepared migration constraints and real account lock exclusion',{
  skip:process.env.USAGE_MONITORING_RUN_POSTGRES!=='AUTHORIZED_LOCAL_ONLY'?'PENDING: isolated PostgreSQL and explicit authorization; migrations are never applied by this test':false,
},async()=>{
  const url=new URL(process.env.USAGE_MONITORING_TEST_URL??'');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  assert.match(url.pathname,/^\/rf017_test_[A-Za-z0-9_]+$/);
  const {Pool}=await import('pg');const pool=new Pool({connectionString:url.href,max:2});
  const a=await pool.connect(),b=await pool.connect();
  try{
    const indexes=await a.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='rf017_one_active_installation'");
    assert.match(indexes.rows[0]?.indexdef??'',/UNIQUE.*WHERE.*ACTIVE/);
    const constraints=await a.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.rf017_application'::regclass");
    assert.ok(constraints.rows.some(r=>r.definition.includes('tombstoneIds')));
    const account=Number(process.env.USAGE_MONITORING_TEST_ACCOUNT_ID);assert.ok(Number.isSafeInteger(account)&&account>0);
    await a.query('BEGIN');await b.query('BEGIN');
    const locked=await a.query('SELECT usuario_id FROM public.tb_usuario WHERE usuario_id=$1 FOR UPDATE',[account]);assert.equal(locked.rowCount,1);
    await assert.rejects(b.query('SELECT usuario_id FROM public.tb_usuario WHERE usuario_id=$1 FOR UPDATE NOWAIT',[account]),{code:'55P03'});
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();await pool.end();}
});

test('Monitoramento de tempo em aplicativos PostgreSQL prepared service integration: replay, deletion race and revocation race',{
  skip:process.env.USAGE_MONITORING_RUN_POSTGRES!=='AUTHORIZED_LOCAL_ONLY'?'PENDING: explicit authorization and empty RF017 fixture account in isolated PostgreSQL':false,
},async()=>{
  const url=new URL(process.env.USAGE_MONITORING_TEST_URL??'');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.match(url.pathname,/^\/rf017_test_[A-Za-z0-9_]+$/);
  const account=Number(process.env.USAGE_MONITORING_TEST_ACCOUNT_ID);assert.ok(Number.isSafeInteger(account)&&account>0);
  const {randomUUID}=await import('node:crypto');const {Pool}=await import('pg');
  const {PrismaClient}=await import('@prisma/client');const {PrismaPg}=await import('@prisma/adapter-pg');
  const {UsageService}=await import('../../src/modules/tempo-uso-v2/service.ts');
  const {postgresRepository}=await import('../../src/modules/tempo-uso-v2/postgres.ts');
  const {revokeUsageAssociations}=await import('../../src/modules/tempo-uso-v2/consent.ts');
  const pool=new Pool({connectionString:url.href,max:4});const client=new PrismaClient({adapter:new PrismaPg(pool)});
  const installation=randomUUID(),secret='e'.repeat(64),operations=[],ids=[];let touchedConsent=false,fixtureApproved=false;
  const operation=()=>{const id=randomUUID();operations.push(id);return id;};
  const now=new Date(),today=now.toISOString().slice(0,10),start=new Date(Math.max(Date.parse(today+'T00:00:00Z'),now.getTime()-60000));
  assert.ok(start<now,'Run after the exact first millisecond of UTC day');
  let clock=start;
  const service=new UsageService(postgresRepository(client),'isolated-test-only-hmac-secret',()=>clock,()=>{const id=randomUUID();ids.push(id);return id;});
  try{
    const existing=await pool.query('SELECT 1 FROM public.rf017_authorization WHERE "accountId"=$1 UNION ALL SELECT 1 FROM public.rf017_tombstone WHERE "accountId"=$1 UNION ALL SELECT 1 FROM public.rf017_receipt WHERE "accountId"=$1 LIMIT 1',[account]);
    assert.equal(existing.rowCount,0,'Fixture account must have no RF017 data before this test');
    const consent=await pool.query("SELECT c.consentimento_id FROM public.tb_consentimento c JOIN public.tb_consentimento_tipo t USING(consentimento_tipo_id) JOIN public.tb_usuario u ON u.usuario_id=c.usuario_id WHERE c.usuario_id=$1 AND u.usuario_status=true AND c.consentimento_status=true AND t.consentimento_tipo_codigo='MONITORAMENTO_TEMPO_USO'",[account]);
    assert.equal(consent.rowCount,1,'Pre-existing explicit test consent is required; this test never seeds a user');fixtureApproved=true;
    const reply=await service.associate(account,{schemaVersion:2,operationId:operation(),installationId:installation,expectedAssociationId:null,timezone:'UTC',action:'ACTIVATE'},secret);
    clock=now;const seconds=Math.min(30,Math.floor((now-start)/1000));
    const snapshot=revision=>({associationId:reply.association.id,localDate:today,timezone:'UTC',revision,observedAt:now.toISOString(),
      sourceStatus:'AVAILABLE',coverage:{interval:{start:start.toISOString(),end:now.toISOString()},completeness:'UNKNOWN',dayExtent:'PARTIAL_DAY'},qualityFlags:[],
      provenance:{source:'ANDROID_USAGE_EVENTS',collectorVersion:'events/2',catalogVersion:1},applications:[{packageId:'com.shopee.br',durationSeconds:seconds},{packageId:'com.mercadolibre',durationSeconds:0},{packageId:'com.zzkko',durationSeconds:0}]});
    const first={schemaVersion:2,batchId:operation(),snapshots:[snapshot(1)]};
    assert.deepEqual(...await Promise.all([service.ingest(account,first,secret),service.ingest(account,first,secret)]));
    await Promise.all([
      service.ingest(account,{schemaVersion:2,batchId:operation(),snapshots:[snapshot(2)]},secret),
      service.delete(account,{schemaVersion:2,operationId:operation(),target:{kind:'INSTALLATION',installationId:installation},scope:{kind:'APP_DAY',localDate:today,timezone:'UTC',packageId:'com.shopee.br'}}),
    ]);
    const values=await pool.query('SELECT a.* FROM public.rf017_application a JOIN public.rf017_snapshot s ON s.key=a."snapshotKey" WHERE s."associationId"=$1',[reply.association.id]);
    assert.equal(values.rows.find(r=>r.packageId==='com.shopee.br').durationSeconds,null);
    assert.equal(values.rows.find(r=>r.packageId==='com.zzkko').durationSeconds,0);
    touchedConsent=true;
    await Promise.allSettled([
      service.ingest(account,{schemaVersion:2,batchId:operation(),snapshots:[snapshot(3)]},secret),
      client.$transaction(async tx=>{
        await tx.$queryRaw`SELECT usuario_id FROM public.tb_usuario WHERE usuario_id=${account} FOR UPDATE`;
        await tx.$executeRaw`UPDATE public.tb_consentimento SET consentimento_status=false WHERE consentimento_id=${consent.rows[0].consentimento_id}`;
        await revokeUsageAssociations(tx,account);
      }),
    ]);
    await assert.rejects(service.ingest(account,{schemaVersion:2,batchId:operation(),snapshots:[snapshot(4)]},secret),/CONSENT_REQUIRED/);
    const closed=await pool.query('SELECT state FROM public.rf017_association WHERE id=$1',[reply.association.id]);assert.equal(closed.rows[0].state,'CLOSED');
  }finally{
    // Only this test's random installation/operations are removed, never fixture user/other data.
    if(fixtureApproved){
      if(touchedConsent)await pool.query("UPDATE public.tb_consentimento SET consentimento_status=true WHERE usuario_id=$1 AND consentimento_tipo_id=(SELECT consentimento_tipo_id FROM public.tb_consentimento_tipo WHERE consentimento_tipo_codigo='MONITORAMENTO_TEMPO_USO')",[account]);
      await pool.query('DELETE FROM public.rf017_snapshot WHERE "associationId" IN (SELECT id FROM public.rf017_association WHERE "installationId"=$1)',[installation]);
      await pool.query('DELETE FROM public.rf017_receipt WHERE "accountId"=$1 AND split_part(key,\':\',3)=ANY($2::text[])',[account,operations]);
      await pool.query('DELETE FROM public.rf017_tombstone WHERE id=ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM public.rf017_association WHERE "installationId"=$1',[installation]);
      await pool.query('DELETE FROM public.rf017_authorization WHERE "installationId"=$1',[installation]);
      await pool.query('DELETE FROM public.rf017_installation WHERE id=$1',[installation]);
    }
    await client.$disconnect();await pool.end();
  }
});
