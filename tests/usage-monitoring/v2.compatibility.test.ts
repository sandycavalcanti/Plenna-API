import assert from 'node:assert/strict';
import test from 'node:test';
import {assertLegacyV1Compatible} from '../../src/modules/tempo-uso/tempo-uso.sync.js';
import {revokeUsageAssociations} from '../../src/modules/tempo-uso-v2/consent.js';
test('migration/exclusion guards remain effective with v2 rollout flag disabled',async()=>{
  const previous=process.env.USAGE_MONITORING_ENABLED;process.env.USAGE_MONITORING_ENABLED='false';
  const statements:string[]=[];
  const tx:any={
    $queryRaw:async(sql:TemplateStringsArray)=>sql.join('').includes('to_regclass')?[{relation:'rf017_authorization'}]:[{exists:1}],
    $executeRaw:async(sql:TemplateStringsArray)=>{statements.push(sql.join(''));return 1;},
  };
  try{
    await assert.rejects(assertLegacyV1Compatible(tx,7),/RF017_V2_REQUIRED/);
    await revokeUsageAssociations(tx,7);assert.equal(statements.length,2);assert.match(statements[0],/revokedAt/);assert.match(statements[1],/CONSENT_REVOKED/);
    tx.$queryRaw=async()=>[{relation:null}];await assertLegacyV1Compatible(tx,7);await revokeUsageAssociations(tx,7);assert.equal(statements.length,2);
  }finally{if(previous===undefined)delete process.env.USAGE_MONITORING_ENABLED;else process.env.USAGE_MONITORING_ENABLED=previous;}
});
