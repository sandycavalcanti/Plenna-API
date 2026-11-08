import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import {UsageService} from '../../src/modules/tempo-uso-v2/service.js';
import {memoryRepository} from './v2.memory.js';
(globalThis as any).prismaRuntime={client:{tb_usuario:{findFirst:async({where}:any)=>({usuario_id:where.usuario_id})}},pool:{}};
const {usageRouter}=await import('../../src/modules/tempo-uso-v2/routes.js');
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('Monitoramento de tempo em aplicativos HTTP: JWT, strict contracts, credentials, account isolation, cache and disabled gate',async()=>{
  const db=memoryRepository();let count=100;
  const service=new UsageService(db.repository,'offline-only-receipt-secret',()=>new Date('2026-11-02T17:00:00Z'),()=>id(count++));
  const app=express();app.use(express.json());app.use('/v2/tempo-uso',usageRouter(()=>service,undefined,()=>true));
  app.use('/disabled',usageRouter(()=>{throw Error('MUST_NOT_CREATE_SERVICE');},undefined,()=>false));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
  const token=jwt.sign({userId:7},process.env.JWT_SECRET!);
  const headers={'content-type':'application/json',authorization:`Bearer ${token}`,'x-rf017-installation-key':'a'.repeat(64)};
  const request={schemaVersion:2,operationId:id(2),installationId:id(1),expectedAssociationId:null,timezone:'America/Sao_Paulo',action:'ACTIVATE'};
  try{
    assert.equal((await fetch(base+'/v2/tempo-uso/summary?month=2026-11')).status,401);
    assert.equal((await fetch(base+'/disabled/summary?month=2026-11')).status,503);
    const bad=await fetch(base+'/v2/tempo-uso/associations',{method:'POST',headers,body:JSON.stringify({...request,usuarioId:8})});assert.equal(bad.status,400);
    const response=await fetch(base+'/v2/tempo-uso/associations',{method:'POST',headers,body:JSON.stringify(request)});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const accepted=await response.json() as {association:{accountId:number}};assert.equal(accepted.association.accountId,7);
    const spoof=await fetch(base+`/v2/tempo-uso/state?installationId=${id(1)}`,{headers:{...headers,'x-rf017-installation-key':'b'.repeat(64)}});assert.equal(spoof.status,403);
    const read=await fetch(base+'/v2/tempo-uso/summary?month=2026-11',{headers});assert.equal(read.status,200);
    const other=await fetch(base+'/v2/tempo-uso/summary?month=2026-11',{headers:{...headers,authorization:`Bearer ${jwt.sign({userId:8},process.env.JWT_SECRET!)}`}});
    assert.equal((await other.json() as {migrated:boolean}).migrated,false);
    assert.equal((await fetch(base+'/v2/tempo-uso/summary?month=2026-13',{headers})).status,400);
    const mismatch=await fetch(base+'/v2/tempo-uso/associations',{method:'POST',headers,body:JSON.stringify({...request,action:'RESUME'})});assert.equal(mismatch.status,409);
    assert.doesNotMatch(JSON.stringify(await mismatch.json()),/secretHash|postgresql|durationSeconds/);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
