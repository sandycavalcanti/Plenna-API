import test from 'node:test';
import assert from 'node:assert/strict';

let purchase, items=[], events=[], tail = Promise.resolve();
const client = { $transaction: async work => {
  let release, locked = false;
  const tx = {
    $queryRaw: async sql => {
      if (sql.join('').includes('tb_usuario') && !locked) {
        const previous = tail;
        tail = new Promise(resolve => { release = resolve; });
        await previous; locked = true;
      }
      return [];
    },
    tb_compra: {
      findFirst: async () => ({ ...purchase }),
      update: async ({data}) => Object.assign(purchase, data),
    },
    tb_categoria:{count:async()=>1},
    tb_compra_item:{findMany:async()=>items.map(i=>({...i})),update:async({where,data})=>Object.assign(items.find(i=>i.compra_item_id===where.compra_item_id),data)},
    tb_compra_evento: { findMany: async () => events,findFirst:async()=>events.at(-1)??null,create:async({data})=>{events.push(data);return data;} },
  };
  try { return await work(tx); } finally { release?.(); }
} };
globalThis.prismaRuntime = {client,pool:{end:async()=>{}}};
const {CompraService} = await import('../../src/modules/compra/compra.service.ts');

test('F11: protocolo de bloqueio simulado preserva correções simultâneas de campos independentes', async () => {
  purchase = {compra_id:1,usuario_id:7,compra_ativo:1,compra_status:'AGUARDANDO_CONFIRMACAO',
    compra_horario:new Date('2026-11-02T12:00:00Z'),compra_classificacao:'PENDENTE',
    compra_valor:100,compra_desconto:0,compra_fonte:'Antes',compra_email:false,
    compra_usuario_concorda:null,compra_usuario_anotacao:null,forma_pagamento_id:null};
  await Promise.all([
    CompraService.update(7,1,{compraFonte:'Depois'}),
    CompraService.update(7,1,{compraUsuarioAnotacao:'Nota preservada'}),
  ]);
  assert.equal(purchase.compra_fonte,'Depois');
  assert.equal(purchase.compra_usuario_anotacao,'Nota preservada');
  assert.deepEqual(events.map(e=>e.tipo),['COMPRA_EDITADA','COMPRA_EDITADA']);
  assert.deepEqual(events.map(e=>e.dados.campos),[['estabelecimento'],['anotacao']]);
  await CompraService.update(7,1,{compraFonte:'Depois',compraUsuarioAnotacao:'Nota preservada'});
  assert.equal(events.length,2);
});

test('item edits have one event for changed fields and none for identical retries',async()=>{
 events=[];items=[{compra_item_id:10,compra_id:1,compra_item_ativo:1,compra_item_nome:'Original',categoria_id:1,compra_item_valor:100,compra_item_quantidade:1}];
 const data={items:[{itemId:10,nome:'Edited',categoriaId:2,valor:120}]};
 await CompraService.update(7,1,data);
 assert.deepEqual(events.map(e=>e.tipo),['ITEM_EDITADO','COMPRA_EDITADA']);
 assert.deepEqual(events[0].dados.campos,['nome','categoria','valor']);assert.equal(events[0].compra_item_id,10);
 await CompraService.update(7,1,data);assert.equal(events.length,2);
});
