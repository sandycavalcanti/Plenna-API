import type { UsageRepository, UsageTransaction, StoredSnapshot, Receipt, LegacyRow } from '../../src/modules/tempo-uso-v2/repository.js';
import type { Association, Authorization, Tombstone } from '../../src/modules/tempo-uso-v2/contracts.js';
export function memoryRepository(){
  let state={installations:new Map<string,{id:string;secretHash:string}>(),associations:new Map<string,Association>(),
    authorizations:new Map<string,Authorization>(),snapshots:new Map<string,StoredSnapshot>(),receipts:new Map<string,Receipt>(),
    tombstones:new Map<string,Tombstone>(),consents:new Map<number,boolean>([[7,true],[8,true]]),legacy:[] as LegacyRow[]};
  let pending=Promise.resolve();let fail=false;let lockHook:(()=>void)|null=null;
  const repository:UsageRepository={transaction:async(account,work)=>{
    let release!:()=>void;const old=pending;pending=new Promise(r=>release=r);await old;
    const before=structuredClone(state);
    const tx:UsageTransaction={
      consent:async a=>state.consents.get(a)===true,
      installation:async id=>state.installations.get(id)??null,
      saveInstallation:async(id,secretHash)=>{state.installations.set(id,{id,secretHash});},lockInstallation:async()=>{const hook=lockHook;lockHook=null;hook?.();},
      current:async id=>[...state.associations.values()].find(a=>a.installationId===id&&a.state==='ACTIVE')??null,
      association:async id=>state.associations.get(id)??null,
      associations:async ids=>[...state.associations.values()].filter(a=>ids.includes(a.id)),
      authorization:async(a,id)=>[...state.authorizations.values()].filter(g=>g.accountId===a&&g.installationId===id).slice(-1)[0]??null,
      saveAuthorization:async a=>{state.authorizations.set(a.id,structuredClone(a));},
      saveAssociation:async a=>{state.associations.set(a.id,structuredClone(a));},
      receipt:async key=>state.receipts.get(key)??null,saveReceipt:async r=>{state.receipts.set(r.key,structuredClone(r));},
      snapshot:async key=>structuredClone(state.snapshots.get(key)??null),
      saveSnapshot:async s=>{if(fail)throw new Error('INJECTED_WRITE_FAILURE');state.snapshots.set(s.key,structuredClone(s));},
      snapshots:async(a,month)=>structuredClone([...state.snapshots.values()].filter(s=>s.accountId===a&&s.localDate.startsWith(month))),
      affectedSnapshots:async a=>structuredClone([...state.snapshots.values()].filter(s=>s.accountId===a)),
      tombstones:async a=>[...state.tombstones.values()].filter(t=>t.accountId===a),
      saveTombstone:async t=>{state.tombstones.set(t.id,structuredClone(t));},
      migrated:async a=>[...state.authorizations.values()].some(g=>g.accountId===a),legacy:async()=>state.legacy,
    };
    try{return await work(tx);}catch(error){state=before;throw error;}finally{release();}
  }};
  return {repository,state:()=>state,failWrites:(value=true)=>{fail=value;},onNextInstallationLock:(hook:()=>void)=>{lockHook=hook;}};
}
