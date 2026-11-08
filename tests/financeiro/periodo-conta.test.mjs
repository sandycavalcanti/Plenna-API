import test from 'node:test';
import assert from 'node:assert/strict';
import {validarPeriodoConta} from '../../src/modules/compra/periodo-conta.ts';

test('conta criada no meio do mês: mês inicial, mês vazio e atual válidos; vizinhos bloqueados',()=>{
  const criacao=new Date('2026-08-15T15:00:00Z'),now=new Date('2026-11-07T12:00:00Z');
  for(const mes of ['2026-08','2026-09','2026-11']) assert.doesNotThrow(()=>validarPeriodoConta({mes},criacao,now));
  for(const mes of ['2026-07','2026-12']) assert.throws(()=>validarPeriodoConta({mes},criacao,now));
  assert.doesNotThrow(()=>validarPeriodoConta({inicio:'2026-08-15',fim:'2026-11-07'},criacao,now));
  for(const q of [{inicio:'2026-08-14',fim:'2026-08-15'},{inicio:'2026-11-07',fim:'2026-11-08'},
    {inicio:'2026-09-02',fim:'2026-09-01'}]) assert.throws(()=>validarPeriodoConta(q,criacao,now));
  // ALL preserves retroactive inclusion by explicit user decision.
  assert.doesNotThrow(()=>validarPeriodoConta({},criacao,now));
});
test('limites civis na meia-noite de São Paulo, independentes do fuso do processo',()=>{
  const criacao=new Date('2026-09-01T02:59:59Z');
  assert.deepEqual(validarPeriodoConta({mes:'2026-08'},criacao,new Date('2026-11-01T02:59:59Z')),
    {minimo:'2026-08-31',maximo:'2026-10-31'});
  assert.throws(()=>validarPeriodoConta({mes:'2026-11'},criacao,new Date('2026-11-01T02:59:59Z')));
  assert.doesNotThrow(()=>validarPeriodoConta({mes:'2026-11'},criacao,new Date('2026-11-01T03:00:00Z')));
});
