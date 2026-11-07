import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { monitoringRouter } from '../../src/modules/monitoramento/routes.js';
import { MonitoringService } from '../../src/modules/monitoramento/service.js';
import { memoryMonitoring } from './monitoramento.memory.js';
import type { AuthRequest } from '../../src/modules/auth/auth.middleware.js';
test('mounted protocol: authentication, disabled gate, strict input, sanitized errors, cursor and retired writes',async()=>{
  const db=memoryMonitoring(),service=new MonitoringService(db.repository);let enabled=true;
  const app=express();app.use(express.json({limit:'600kb'}));
  const auth=(req:AuthRequest,res:express.Response,next:express.NextFunction)=>{if(req.headers['x-test-user']!=='7'){res.status(401).json({error:'Token inválido'});return;}req.userId=7;next();};
  app.use('/v2/tempo-uso',monitoringRouter(()=>service,auth,()=>enabled));
  const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as import('node:net').AddressInfo;
  const base=`http://127.0.0.1:${address.port}/v2/tempo-uso`;
  const headers={'x-test-user':'7','content-type':'application/json'};
  try{
    assert.equal((await fetch(base+'/summary?month=2026-11')).status,401);
    enabled=false;const disabled=await fetch(base+'/prepare',{method:'POST',headers,body:'{}'});assert.equal(disabled.status,503);assert.equal((await disabled.json()).error.code,'RF017_V2_NOT_ENABLED');enabled=true;
    assert.equal((await fetch(base+'/prepare',{method:'POST',headers,body:'{"schemaVersion":2}'})).status,400);
    const old=await fetch(base+'/snapshots',{method:'PUT',headers,body:'{}'});assert.equal(old.status,409);assert.equal((await old.json()).error.code,'RF017_PROTOCOL_UPGRADE_REQUIRED');
    assert.equal((await fetch(base+'/accesses?date=2026-11-06&cursor=garbage',{headers})).status,400);
    const summary=await fetch(base+'/summary?month=2026-11',{headers});assert.equal(summary.status,200);assert.equal(summary.headers.get('cache-control'),'no-store');
    db.state().detailed=false;assert.equal((await fetch(base+'/accesses?date=2026-11-06',{headers})).status,403);
    const broken=new MonitoringService({...db.repository,read:async()=>{throw new Error('password=must-not-leak');}});
    const original=service.summary.bind(service);service.summary=broken.summary.bind(broken);const failed=await fetch(base+'/summary?month=2026-11',{headers});assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('must-not-leak'));service.summary=original;
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
