import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLegacyV1Compatible } from '../../src/modules/tempo-uso/tempo-uso.sync.js';

test('additive tables do not activate v2; populated accounts cannot downgrade', async () => {
  const previous = process.env.USAGE_MONITORING_ENABLED;
  let populated = false;
  const queries: {sql:string;values:unknown[]}[] = [];
  const tx:any = {$queryRaw: async (parts:TemplateStringsArray,...values:unknown[]) => {
    const sql=parts.join('?');queries.push({sql,values});
    return sql.includes('to_regclass') ? [{current:'tb_monitoramento_instalacao',relation:null}]
      : populated ? [{exists:1}] : [];
  }};
  try {
    for (const flag of ['false', undefined]) {
      if(flag===undefined)delete process.env.USAGE_MONITORING_ENABLED;
      else process.env.USAGE_MONITORING_ENABLED=flag;
      populated=false;
      await assertLegacyV1Compatible(tx,7);
      populated=true;
      await assert.rejects(assertLegacyV1Compatible(tx,7),/RF017_V2_REQUIRED/);
    }
    const stateQuery=queries.find(q=>q.sql.includes('UNION ALL'))!;
    assert.deepEqual(stateQuery.values,[7,7,7]);
    assert.match(stateQuery.sql,/usuario_ativo_id=/);
    assert.match(stateQuery.sql,/tb_monitoramento_tempo_diario WHERE usuario_id=/);
    assert.match(stateQuery.sql,/tb_monitoramento_exclusao WHERE usuario_id=/);
    process.env.USAGE_MONITORING_ENABLED='true';populated=false;
    const before=queries.length;
    await assert.rejects(assertLegacyV1Compatible(tx,7),/RF017_V2_REQUIRED/);
    assert.equal(queries.length,before+1);
  } finally {
    if(previous===undefined)delete process.env.USAGE_MONITORING_ENABLED;
    else process.env.USAGE_MONITORING_ENABLED=previous;
  }
});
