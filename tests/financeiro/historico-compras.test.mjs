import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
let rows=[],queries=[];
const match=(row,where)=>Object.entries(where).every(([key,value])=>{
  if(key==='OR')return value.some(condition=>match(row,condition));
  if(value instanceof Date)return +row[key]===+value;
  if(value&&typeof value==='object')return Object.entries(value).every(([op,target])=>
    op==='contains'?String(row[key]||'').toLowerCase().includes(target.toLowerCase()):op==='mode'?true:op==='in'?target.includes(row[key]):op==='gte'?row[key]>=target:op==='lt'?row[key]<target:row[key]===target);
  return row[key]===value;
});
const db={tb_usuario:{findFirst:async({where})=>[7,8].includes(where.usuario_id)?{usuario_id:where.usuario_id,usuario_data_criacao:new Date("2026-04-15T15:00:00Z")}:null},tb_compra:{findFirst:async({where})=>rows.find(row=>match(row,where))??null,
  findMany:async args=>{queries.push(args);return rows.filter(row=>match(row,args.where))
    .sort((a,b)=>b.compra_horario-a.compra_horario||b.compra_id-a.compra_id).slice(0,args.take);}},
  $transaction:async work=>work(db)};
globalThis.prismaRuntime={client:db,pool:{end:async()=>{}}};
const {CompraService}=await import('../../src/modules/compra/compra.service.ts');
const {historicoComprasQuerySchema}=await import('../../src/modules/compra/compra.schemas.ts');
const {compraRouter}=await import('../../src/modules/compra/compra.routes.ts');
let server,base;
test.before(async()=>{const app=express();app.use('/compras',compraRouter);server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}/compras/historico`;});
test.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
test.beforeEach(()=>{queries=[];rows=Array.from({length:105},(_,index)=>({compra_id:index+1,usuario_id:7,compra_ativo:1,
  compra_status:index%3===0?'IGNORADA':'CONFIRMADA',compra_horario:new Date(Date.UTC(2026,4,index+1,12)),compra_valor:10}));});
test('histórico completo pagina meses diferentes sem repetir empates e inclui estados finais suportados',async()=>{
 rows[1].compra_horario=rows[0].compra_horario;
 rows[54].compra_horario=rows[55].compra_horario;
 rows.push({...rows[0],compra_id:999,usuario_id:8},{...rows[0],compra_id:998,compra_ativo:0});
 const ids=[];let antes;
 do {const page=await CompraService.historico(7,antes?{antes}:{});assert.ok(page.compras.length<=50);
   ids.push(...page.compras.map(row=>row.compra_id));antes=page.proximoCursor;
 }while(antes);
 assert.equal(ids.length,105);assert.equal(new Set(ids).size,105);assert.ok(ids.includes(1));assert.ok(!ids.includes(999));
 assert.ok(queries.every(query=>query.take===51));
 await assert.rejects(CompraService.historico(7,{antes:999}),error=>error.statusCode===404);
});
test('mês e intervalo usam data da compra em São Paulo e status é independente',async()=>{
 rows=[{compra_id:1,usuario_id:7,compra_ativo:1,compra_status:'IGNORADA',compra_horario:new Date('2026-10-01T02:59:59Z')},
   {compra_id:2,usuario_id:7,compra_ativo:1,compra_status:'CONFIRMADA',compra_horario:new Date('2026-10-01T03:00:00Z')}];
 assert.deepEqual((await CompraService.historico(7,{mes:'2026-09',status:'IGNORADA'})).compras.map(row=>row.compra_id),[1]);
 assert.deepEqual((await CompraService.historico(7,{inicio:'2026-10-01',fim:'2026-10-01'})).compras.map(row=>row.compra_id),[2]);
 for(const query of [{inicio:'2026-02-30',fim:'2026-03-01'},{mes:'2026-10',inicio:'2026-10-01',fim:'2026-10-02'},{status:'CANCELADA'},{inicio:'2026-10-02',fim:'2026-10-01'}])
   assert.equal(historicoComprasQuerySchema.safeParse(query).success,false);
});

test('rota autenticada entrega página limitada e rejeita filtro ou cursor inválido',async()=>{
 const token=jwt.sign({userId:7},process.env.JWT_SECRET,{expiresIn:'5m'});
 const request=query=>fetch(base+query,{headers:{Authorization:`Bearer ${token}`}});
 const response=await request('');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const page=await response.json();assert.equal(page.compras.length,50);assert.ok(page.proximoCursor);
 assert.equal((await fetch(base)).status,401);
 assert.equal((await request('?status=CANCELADA')).status,400);
 assert.equal((await request('?usuarioId=8')).status,400);
 rows.push({...rows[0],compra_id:999,usuario_id:8});
 assert.equal((await request('?antes=999')).status,404);
});

test('busca usa estabelecimento no backend, preserva propriedade e pagina??o',async()=>{
 rows.forEach((r,i)=>r.compra_fonte=i%2?'Mercado Exemplo':'Outra loja');rows.push({...rows[1],usuario_id:8,compra_id:999});
 const page=await CompraService.historico(7,{busca:'mErCaDo'});assert.equal(page.compras.length,50);assert.ok(page.proximoCursor);assert.ok(page.compras.every(r=>r.usuario_id===7&&r.compra_fonte==='Mercado Exemplo'));
 assert.equal(historicoComprasQuerySchema.safeParse({busca:'x'.repeat(101)}).success,false);
});

test('rota bloqueia meses e intervalos fora da conta sem excluir importações do histórico',async()=>{
 const token=jwt.sign({userId:7},process.env.JWT_SECRET,{expiresIn:'5m'});
 for(const query of ['?mes=2026-03','?mes=9999-12','?inicio=2026-04-14&fim=2026-04-15']) {
   const response=await fetch(base+query,{headers:{Authorization:`Bearer ${token}`}});
   assert.equal(response.status,400);
 }
 const retro={...rows[0],compra_id:900,compra_horario:new Date('2010-02-02T12:00:00Z')};
 const future={...rows[0],compra_id:901,compra_horario:new Date('9999-01-01T12:00:00Z')};
 rows=[retro,future];
 assert.deepEqual((await CompraService.historico(7,{})).compras.map(r=>r.compra_id),[900]);
 assert.deepEqual((await CompraService.historico(7,{mes:'2026-04'})).compras,[]);
 assert.equal(retro.compra_horario.toISOString(),'2010-02-02T12:00:00.000Z');
});

if (process.env.PLENNA_MOBILE_URL) test('contrato Mobile -> HTTP de historico preserva filtros e pagina limitada', async () => {
  const { parametrosTemporaisCompras, filtrosIniciais } = await import(new URL('src/utils/filtrosHistoricoCompras.js', process.env.PLENNA_MOBILE_URL));
  const params = parametrosTemporaisCompras({ ...filtrosIniciais, modo: 'MES', mes: '2026-05' });
  assert.equal(historicoComprasQuerySchema.safeParse(params).success, true);
  const token = jwt.sign({ userId: 7 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const response = await fetch(base + '?' + new URLSearchParams(params), { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.ok(Array.isArray(page.compras) && page.compras.length > 0 && page.compras.length <= 50);
  assert.ok(page.compras.every(row => row.usuario_id === 7 && row.compra_ativo === 1 && row.compra_horario >= '2026-05-01T03:00:00.000Z' && row.compra_horario < '2026-06-01T03:00:00.000Z'));
  assert.ok(page.proximoCursor === null || Number.isSafeInteger(page.proximoCursor));
});
