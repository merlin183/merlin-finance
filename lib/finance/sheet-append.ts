import {sha256,sheetSnapshot,type SheetMapping} from './google-sheets';
import {buildSheetMergePlan,type SheetMergeRow} from './sheet-merge';
import type {Dataset,Transaction} from './types';

const normalize=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
function sameOrigin(source:SheetMergeRow,previous:Transaction){
 const a=source.source_details?.provenance,b=previous.source_details?.provenance;
 return !!a?.url&&a.url===b?.url&&a.sheet===b.sheet&&a.row===b.row&&source.account_id===previous.account_id;
}
function possibleCorrection(source:SheetMergeRow,previous:Transaction){
 if(!sameOrigin(source,previous))return false;
 const sameContent=normalize(source.description)===normalize(previous.description)
  ||!!source.source_details?.basic&&source.source_details.basic===previous.source_details?.basic;
 const changedMoney=source.amount!==previous.amount||source.direction!==previous.direction;
 if(source.txn_date===previous.txn_date&&sameContent&&changedMoney)return true;
 return source.txn_date!==previous.txn_date&&sameContent&&source.amount===previous.amount&&source.direction===previous.direction
  &&(source.balance===null||previous.balance===null||source.balance===previous.balance)
  &&(!source.txn_time||!previous.txn_time||source.txn_time===previous.txn_time);
}

/** Every detected bank sheet must have an explicit, selected server mapping. */
export function assertCompleteSheetMappings(bytes:Uint8Array,mappings:SheetMapping[]){
 const sheets=sheetSnapshot(bytes),names=new Set(sheets.map(sheet=>sheet.name));
 if(mappings.length!==names.size||new Set(mappings.map(mapping=>mapping.sheet)).size!==mappings.length
  ||mappings.some(mapping=>!names.has(mapping.sheet)||!mapping.selected||!mapping.account_id)){
  throw Error('통장 시트 목록과 등록된 계좌 연결이 다릅니다. 모든 통장 시트의 연결을 확인한 뒤 동기화해주세요.');
 }
 return sheets;
}

/** The reconciliation engine recognizes duplicates; the output can only insert. */
export async function buildSheetAppendPlan(data:Dataset,incoming:SheetMergeRow[],sourceHash:string){
 const plan=await buildSheetMergePlan(data,incoming,sourceHash,{sourceAuthority:true,appendOnly:true});
 const changes=[];
 const byOrigin=new Map<string,Transaction[]>();
 const origin=(row:Transaction|SheetMergeRow)=>{
  const p=row.source_details?.provenance;
  return p?.url?JSON.stringify([row.account_id,p.url,p.sheet,p.row]):null;
 };
 for(const saved of data.transactions){const key=origin(saved);if(key){const group=byOrigin.get(key)||[];group.push(saved);byOrigin.set(key,group);}}
 const incomingByLocation=new Map(incoming.map(row=>[JSON.stringify([row.account_id,row.sheet,row.source_row]),row]));
 for(const change of plan.changes){
  if(change.kind!=='insert'||change.expected!==null||change.duplicates.length)throw Error('신규 거래만 추가할 수 있습니다. 동기화를 중단했습니다.');
  const source=incomingByLocation.get(JSON.stringify([change.account_id,change.row.source_sheet,change.row.source_row]))!;
  const key=origin(source);
  if(key&&(byOrigin.get(key)||[]).some(previous=>possibleCorrection(source,previous))){
   plan.summary.inserted--;plan.summary.blocked++;
   plan.conflicts.push({sheet:source.sheet,row:source.source_row,message:'이미 가져온 원본 행의 날짜·금액·입출금이 변경된 것으로 보여 중복 추가하지 않았습니다. 원본 정정 여부를 확인해주세요.'});
   continue;
  }
  // Stable across source snapshots, classification edits and concurrent runs.
  // Account locks and the database's unique hash constraint guard races too.
  const hash=await sha256(JSON.stringify(['sheet-append-v1',change.account_id,change.row.dedup_hash]));
  const id=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-${((parseInt(hash[16],16)&3)|8).toString(16)}${hash.slice(17,20)}-${hash.slice(20,32)}`;
  changes.push({...change,id});
 }
 const summary={...plan.summary,updated:0,removed:0};
 const planHash=await sha256(JSON.stringify({mode:'append-only-v1',changes,summary,conflicts:plan.conflicts}));
 return {changes,summary,conflicts:plan.conflicts,planHash};
}
