import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
let active=true,consent=false,queries=0;
delete process.env.USAGE_MONITORING_ENABLED;
const db={tb_usuario:{findFirst:async({where})=>active?{usuario_id:where.usuario_id}:null},$transaction:async cb=>cb({tb_consentimento:{findFirst:async()=>{queries++;return consent?{consentimento_data_criacao:new Date('2026-10-01T12:00Z')}:null;}},tb_tempo_uso:{findMany:async()=>[]},$queryRaw:async()=>[{tabela:null}]})};
globalThis.prismaRuntime={client:db,pool:{end:async()=>{}}};
const {apresentarUsoContextual,UsoContextualService}=await import('../../src/modules/analise/uso-contextual.service.ts');
const {analisesRouter}=await import('../../src/modules/analise/analise.routes.ts');
test('projeção digital remove identificadores e não vaza valores quando não há autorização',()=>{
  const raw={disponibilidade:'PARCIAL',dias:['2026-10-02','2026-10-03'],minutosRegistrados:30,porAplicativo:[{packageId:'SEGREDO'}],referencias:['rf017-v2:privado']};
  const d=apresentarUsoContextual(raw,'2026-10');assert.equal(d.diasComDados,2);assert.equal(d.associacaoComCompra,'INDISPONIVEL');assert.doesNotMatch(JSON.stringify(d),/SEGREDO|privado|packageId/);
  assert.equal(apresentarUsoContextual({...raw,disponibilidade:'SEM_AUTORIZACAO'},'2026-10').minutosRegistrados,null);
  assert.throws(()=>apresentarUsoContextual({...raw,dias:['2026-11-01']},'2026-10'));
  assert.throws(()=>apresentarUsoContextual({...raw,dias:['2026-10-01','2026-10-01']},'2026-10'));
});
test('fonte opcional respeita consentimento e rejeita futuro e escopo injetado antes da consulta',async()=>{
  const now=new Date('2026-11-07T13:00Z');queries=0;
  await assert.rejects(UsoContextualService.consultar(7,{periodo:'2026-12'},now));await assert.rejects(UsoContextualService.consultar(7,{periodo:'2026-10',usuarioId:8},now));assert.equal(queries,0);
  const d=await UsoContextualService.consultar(7,{periodo:'2026-10'},now);assert.equal(d.disponibilidade,'SEM_AUTORIZACAO');assert.equal(d.diasComDados,0);assert.equal(queries,1);
});
test('rota digital exige JWT/conta ativa, no-store e ignora zero compras sem consultar tabelas financeiras',async()=>{
  const app=express();app.use('/analises',analisesRouter);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url=`http://127.0.0.1:${server.address().port}/analises/uso-contextual?periodo=2026-10`;
  try{assert.equal((await fetch(url)).status,401);const token=jwt.sign({userId:7},process.env.JWT_SECRET);const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal((await r.json()).minutosRegistrados,null);active=false;assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${token}`}})).status,401);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));active=true;}
});
