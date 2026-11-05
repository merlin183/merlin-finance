import type {Dataset,SourceDetails,Transaction} from './types';
import type {SheetMergeRow} from './sheet-merge';
import {mergeSourceDetails} from './source-details';

type Evidence=Pick<Transaction,'account_id'|'txn_date'|'amount'|'direction'|'balance'|'txn_time'>;
const core=(t:Evidence)=>JSON.stringify([t.account_id,t.txn_date,t.amount,t.direction]);
function matches(a:Evidence,b:Evidence){
 const balance=a.balance!=null&&b.balance!=null,time=!!a.txn_time&&!!b.txn_time;
 return (balance||time)&&(!balance||a.balance===b.balance)&&(!time||a.txn_time===b.txn_time);
}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value)??'null';
}
export type SourceDetailChange={id:string;expected:Transaction&{source_details:SourceDetails|null};source_details:SourceDetails};

/** Supplements descriptions only when bank evidence identifies one row in both directions. */
export async function buildSourceDetailsPlan(data:Dataset,incoming:SheetMergeRow[],sourceHash:string,sourceUrl:string){
 const sources=new Map<string,SheetMergeRow[]>(),existing=new Map<string,Transaction[]>();
 for(const source of incoming){const key=core(source),group=sources.get(key)||[];group.push(source);sources.set(key,group);}
 for(const row of data.transactions){const key=core(row),group=existing.get(key)||[];group.push(row);existing.set(key,group);}
 const changes:SourceDetailChange[]=[],summary={updated:0,unchanged:0,unmatched:0,ambiguous:0};
 for(const row of [...data.transactions].sort((a,b)=>a.id.localeCompare(b.id))){
  const candidates=(sources.get(core(row))||[]).filter(source=>matches(row,source));
  if(!candidates.length){summary.unmatched++;continue;}
  const source=candidates[0];
  if(candidates.length!==1||(existing.get(core(row))||[]).filter(other=>matches(other,source)).length!==1){summary.ambiguous++;continue;}
  const details=source.source_details;
  if(!details||!['basic','detail','counterparty','record','memo','note'].some(key=>String(details[key as keyof SourceDetails]||'').trim())){summary.unmatched++;continue;}
  const next=mergeSourceDetails(row.source_details,{...details,provenance:{sheet:source.sheet,row:source.source_row,url:sourceUrl}});
  if(!next||canonical(next)===canonical(row.source_details)){summary.unchanged++;continue;}
  changes.push({id:row.id,expected:{...row,source_details:row.source_details??null},source_details:next});summary.updated++;
 }
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical({sourceHash,sourceUrl,changes})));
 const planHash=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
 return {changes,summary,planHash,sample:changes.slice(0,8).map(c=>({id:c.id,date:c.expected.txn_date,direction:c.expected.direction,description:c.expected.description,source_details:c.source_details}))};
}
