import type { Repository,Transaction,Installation,Daily,Access,Exclusion } from '../../src/modules/monitoramento/model.js';
import type {LegacyRow} from '../../src/modules/tempo-uso-v2/repository.js';
export function memoryMonitoring(){
  let state={installations:new Map<string,Installation>(),days:new Map<string,Daily>(),accesses:new Map<string,Access[]>(),exclusions:[] as Exclusion[],legacy:[] as LegacyRow[],consent:true,detailed:true,writes:0};
  const transaction=():Transaction=>({
    consent:async(_a,d)=>state.consent&&(!d||state.detailed),lockInstallation:async()=>{},installation:async id=>state.installations.get(id)??null,
    saveInstallation:async v=>{state.installations.set(v.id,v);},
    daily:async(a,i,c,dates)=>[...state.days.values()].filter(d=>d.account===a&&d.installation===i&&d.context===c&&dates.includes(d.date)),
    saveDaily:async d=>{const value={...d,id:d.id==='0'?String(state.days.size+1):d.id};state.days.set(value.id,value);state.writes++;return value;},
    accesses:async ids=>new Map(ids.map(id=>[id,state.accesses.get(id)??[]])),
    putAccesses:async(id,values)=>{const all=new Map((state.accesses.get(id)??[]).map(a=>[a.key,a]));values.forEach(a=>all.set(a.key,a));state.accesses.set(id,[...all.values()]);},
    removeAccesses:async(id,keys)=>{state.accesses.set(id,(state.accesses.get(id)??[]).filter(a=>!keys.includes(a.key)));},
    exclusions:async a=>state.exclusions.filter(e=>e.account===a),
    exclude:async e=>{if(!state.exclusions.some(x=>x.hash===e.hash))state.exclusions.push(e);for(const d of state.days.values()){if(d.account===e.account&&(!e.installation||d.installation===e.installation)&&(!e.packages||e.packages.includes(d.packageId))&&d.start!<e.end&&d.end!>e.start){d.duration=null;d.state=4;d.accessState=4;d.version++;state.accesses.delete(d.id);}}},
    ownsInstallation:async(a,id)=>state.installations.get(id)?.account===a,
    accessStats:async(a,start,end)=>{const values=[...state.days.values()].filter(d=>d.account===a&&d.date>=start&&d.date<end&&d.state!==4).flatMap(d=>(state.accesses.get(d.id)??[]).map(v=>({...v,collector:d.collector})));return {identifiedOpenings:values.filter(v=>v.collector>=4&&(v.quality&257)===257).length,observedIntervals:values.length,identifiedResumptions:values.filter(v=>v.collector>=4&&(v.quality&513)===513).length,unknownEntries:values.filter(v=>(v.quality&1)&&(v.collector<4||(v.quality&768)===0)).length,openSegments:values.filter(v=>!v.end).length,knownDurationMs:values.reduce((n,v)=>n+(v.end?Date.parse(v.end)-Date.parse(v.start):0),0)};},
    month:async(a,m)=>[...state.days.values()].filter(d=>d.account===a&&d.date.startsWith(m)),legacy:async(a)=>a===7?state.legacy:[],
    page:async(account,date,after,limit)=>[...state.days.values()].filter(d=>d.account===account&&d.date===date&&d.state!==4).flatMap(d=>(state.accesses.get(d.id)??[]).map(a=>({...a,daily:d}))).sort((a,b)=>Number(BigInt(a.daily.id)-BigInt(b.daily.id))||a.start.localeCompare(b.start)||a.key.localeCompare(b.key)).filter(a=>!after||BigInt(a.daily.id)>BigInt(after.id)||a.daily.id===after.id&&(a.start>after.start||a.start===after.start&&a.key>after.key)).slice(0,limit)
  });
  let tail=Promise.resolve();
  const repository:Repository={write:(a,work)=>{const run=tail.then(async()=>{const backup=structuredClone(state);try{return await work(transaction());}catch(e){state=backup;throw e;}});tail=run.then(()=>{},()=>{});return run;},read:async(a,w)=>w(transaction())};
  return {repository,state:()=>state};
}
