import assert from 'node:assert/strict';
import test from 'node:test';
import {redactLegacy} from '../../src/modules/tempo-uso-v2/legacy.js';
import type {Tombstone} from '../../src/modules/tempo-uso-v2/contracts.js';
const original={tempo_uso_nome:'Shopee',tempo_uso_package_id:'com.shopee.br',tempo_uso_inicio:new Date('2026-11-02T17:00:00Z'),tempo_uso_fim:new Date('2026-11-02T18:00:00Z'),tempo_uso_data_local:new Date('2026-11-02'),tempo_uso_data:new Date('2026-11-02T17:00:00Z'),tempo_uso_duracao_segundos:420,tempo_uso_minutos:7};
const deletion:Tombstone={id:'00000000-0000-4000-8000-000000000001',accountId:7,createdAt:'2026-11-02T19:00:00Z',target:{kind:'ACCOUNT'},scope:{kind:'PERIOD',interval:{start:'2026-11-02T17:10:00Z',end:'2026-11-02T17:11:00Z'},packageIds:['com.shopee.br']}};
test('legacy read overlay suppresses deleted values without rewriting original records or other apps',()=>{
  const other={...original,tempo_uso_nome:'SHEIN',tempo_uso_package_id:'com.zzkko'};
  const visible=redactLegacy([original,other],[deletion]);assert.equal(visible[0].tempo_uso_duracao_segundos,null);assert.equal(visible[0].tempo_uso_minutos,null);assert.equal(visible[1],other);assert.equal(original.tempo_uso_duracao_segundos,420);
});
test('legacy uncertain provenance is explicit rather than fabricated installation or duration',()=>{
  const unknown={...original,tempo_uso_package_id:null,tempo_uso_nome:'Unknown',tempo_uso_inicio:null,tempo_uso_fim:null};
  const visible=redactLegacy([unknown],[deletion]);assert.equal(visible[0].tempo_uso_duracao_segundos,null);
  assert.equal((visible[0] as unknown as {rf017_suppression:{reason:string}}).rf017_suppression.reason,'LEGACY_PROVENANCE_UNCERTAIN');
  assert.equal(redactLegacy([original],[{...deletion,target:{kind:'INSTALLATION',installationId:'00000000-0000-4000-8000-000000000002'}}])[0],original);
});
