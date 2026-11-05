import {buildIntercompanyRegister,intercompanySheetSnapshotInputSchema,type IntercompanyEntry,type IntercompanyRegisterData,type IntercompanySheetSnapshotInput,type IntercompanySourceRow} from './intercompany-register';
import type {IntercompanySheetSource,IntercompanySheetRaw,IntercompanySourceRow as ParsedRow,IntercompanyMirrorRow} from './intercompany-sheet-source';
import {today} from './format';

export class IntercompanySyncConflict extends Error{
 constructor(message:string,readonly row:number|null=null){super(message);this.name='IntercompanySyncConflict';}
}
export type IntercompanySheetAmendment={id:string;version:number;source_row_key:string;entry_date:string;from_party:string;to_party:string;amount:number;kind:'loan'|'repayment';memo:string;voided:boolean;previous_row:(string|number)[]|null};
export type IntercompanySourceUpdate={row:number;expectedRow:(string|number|boolean|null)[];date:string;fromParty:string;toParty:string;amount:number;kind:'loan'|'repayment'};
export type IntercompanySyncPlan={snapshot:IntercompanySheetSnapshotInput;amendments:IntercompanySheetAmendment[];sourceUpdates:IntercompanySourceUpdate[];summary:{added:number;updated:number;unchanged:number;basisUpdated:number}};
type Financial={date:string;from:string;to:string;amount:number;kind:string};
const finance=(row:ParsedRow|IntercompanyMirrorRow):Financial=>({date:row.date,from:row.fromParty,to:row.toParty,amount:row.amount,kind:row.kind});
const nativeFinance=(row:IntercompanyEntry):Financial=>({date:row.entry_date,from:row.from_party,to:row.to_party,amount:row.amount,kind:row.kind});
const sourceFinance=(row:IntercompanySourceRow):Financial=>({date:row.date,from:row.from_business,to:row.to_business,amount:row.amount,kind:row.kind});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const conflict=(message:string,row:number|null=null):never=>{throw new IntercompanySyncConflict(message,row);};

/** Check identities before writing even harmless H stamps; lost identities must not become new money. */
export function assertIntercompanySourceIdentities(register:IntercompanyRegisterData,source:IntercompanySheetSource,raw:IntercompanySheetRaw){
 if(source.issues.length){const issue=source.issues[0];conflict(issue.message,issue.row);}
 const previous=register.sheet_sync;
 if(previous){
  for(const old of previous.rows.filter(r=>r.origin==='source')){
   const current=source.sourceRows.find(r=>r.id===old.id);
   if(!current)throw new IntercompanySyncConflict('이전에 반영한 원본 기록의 연동ID가 사라졌습니다. 삭제·이동한 행과 연동ID를 확인해주세요.',old.source_row);
   const h=raw.sourceValues[current.row-1]?.[7],e=raw.sourceValues[current.row-1]?.[4];
   if(!h&&e!==old.native_id)conflict('원본의 연동ID가 지워졌습니다. 기존 ID를 복원한 뒤 다시 동기화해주세요.',current.row);
   if(old.native_id&&current.nativeId&&current.nativeId!==old.native_id)conflict('이미 연결된 대시보드 기록의 식별자가 바뀌었습니다. 원본 연결을 확인해주세요.',current.row);
  }
 }
 const knownOld=new Set(register.baseline?.additions.map(r=>r.id)??[]);
 for(const row of source.sourceRows){
  if(row.date>today())conflict('미래 날짜는 실제 대여·상환 내역으로 반영할 수 없습니다.',row.row);
  if(row.id.startsWith('source-row-')&&!knownOld.has(row.id))conflict('기존 원본 기록의 연동ID를 확인해주세요.',row.row);
 }
}

/** Pure merge: explicit IDs link records; equal amounts/dates never merge distinct IDs. */
export function planIntercompanySheetSync(register:IntercompanyRegisterData,source:IntercompanySheetSource,raw:IntercompanySheetRaw,options:{reconciledRows?:ReadonlySet<number>}={}):IntercompanySyncPlan{
 if(!register.baseline)conflict('원본 대여금 기준 자료를 먼저 연결해주세요.');
 assertIntercompanySourceIdentities(register,source,raw);
 const baseline=register.baseline!,native=new Map(register.entries.map(e=>[e.id,e])),mirrors=new Map(source.mirrorRows.map(r=>[r.id,r]));
 const prior=new Map((register.sheet_sync?.rows??[]).map(r=>[r.id,r]));
 const linked=new Map<string,ParsedRow>(),rows:IntercompanySourceRow[]=[],amendments:IntercompanySheetAmendment[]=[],sourceUpdates:IntercompanySourceUpdate[]=[],meaningfulAmendments=new Set<string>();
 for(const row of source.sourceRows){
  const nativeId=row.nativeId??(native.has(row.id)?row.id:null);
  if(nativeId&&native.has(nativeId)){
   if(linked.has(nativeId))conflict('서로 다른 원본 행이 같은 대시보드 기록에 연결돼 있습니다.',row.row);
   linked.set(nativeId,row);
  }else{
   const mirrorId=row.nativeId??(mirrors.has(row.id)?row.id:null),mirror=mirrorId?mirrors.get(mirrorId):undefined;
   if(row.nativeId&&!mirror)conflict('원본이 가리키는 등록 기록을 찾지 못했습니다.',row.row);
   if(mirror&&!same(finance(row),finance(mirror)))conflict('연결된 원본 행과 기록 탭의 내용이 다릅니다. 두 곳의 수정 내용을 확인해주세요.',row.row);
   rows.push({id:row.id,source_row:row.row,date:row.date,from_business:row.fromParty,to_business:row.toParty,amount:row.amount,kind:row.kind,memo:row.memo,native_id:null,origin:'source',voided:mirror?.voided??false});
  }
 }
 const representedMirrors=new Set(source.sourceRows.flatMap(r=>r.nativeId?[r.nativeId]:mirrors.has(r.id)?[r.id]:[]));
 for(const entry of register.entries){
  const mirror=mirrors.get(entry.id),manual=linked.get(entry.id),old=manual?prior.get(manual.id):prior.get(entry.id);
  if(!mirror&&entry.sheet_status==='synced')conflict('이미 반영된 기록의 시트 행이 없어졌습니다. 원본을 확인한 뒤 다시 동기화해주세요.',entry.sheet_row);
  if(mirror&&mirror.row!==entry.sheet_row)conflict('등록 기록 탭에서 기록 행이 이동했습니다. 기존 행 위치를 확인해주세요.',mirror.row);
  if(mirror&&entry.sheet_status==='synced'&&mirror.version!==entry.version)conflict('등록 기록 탭의 버전이 대시보드와 다릅니다. 버전 열을 확인해주세요.',mirror.row);
  if(entry.sheet_status!=='synced'){
   const approved=entry.sheet_previous_row;
   const matchesPrior=!!mirror&&!!approved&&same(mirror.cells,approved);
   const matchesSaved=!!mirror&&same(finance(mirror),nativeFinance(entry))&&mirror.memo===entry.memo&&mirror.version<=entry.version&&(mirror.version<entry.version||mirror.voided===entry.voided);
   if((mirror&&!matchesPrior&&!matchesSaved)||(!mirror&&approved?.some(cell=>cell!=='')))conflict('기록 탭 반영 대기 중 원본이 다시 변경됐습니다. 개별 시트 기록 재시도로 먼저 확인한 뒤 동기화해주세요.',mirror?.row??entry.sheet_row);
  }
  let selected=nativeFinance(entry),memo=entry.memo,voided=entry.voided;
  const mirrorEditable=!!mirror&&entry.sheet_status==='synced';
  const mirrorChanged=mirrorEditable&&!same(finance(mirror!),selected);
  const previous=old?sourceFinance(old):selected;
  const manualChanged=!!manual&&!same(finance(manual),previous);
  if(manualChanged&&mirrorChanged&&!same(finance(manual!),finance(mirror!)))conflict('같은 기록이 원본과 기록 탭에서 서로 다르게 수정됐습니다. 어느 내용을 쓸지 원본에서 정리해주세요.',manual!.row);
  if(manualChanged)selected=finance(manual!);else if(mirrorChanged)selected=finance(mirror!);
  const manualMemoChanged=!!manual&&!!old&&!options.reconciledRows?.has(manual.row)&&manual.memo!==old.memo;
  const mirrorMemoChanged=mirrorEditable&&mirror!.memo!==entry.memo;
  if(manualMemoChanged&&mirrorMemoChanged&&manual!.memo!==mirror!.memo)conflict('원본과 기록 탭의 메모가 서로 다르게 수정됐습니다.',manual!.row);
  if(manualMemoChanged)memo=manual!.memo;else if(mirrorMemoChanged)memo=mirror!.memo;
  if(mirrorEditable)voided=mirror!.voided;
  if(memo.length>2000)conflict('연결된 기록의 메모는 2,000자 이내로 입력해주세요.',manual?.row??mirror?.row??null);
  if(manual&&!same(selected,finance(manual))){sourceUpdates.push({row:manual.row,expectedRow:Array.from({length:9},(_,i)=>raw.sourceValues[manual.row-1]?.[i]??null),date:selected.date,fromParty:selected.from,toParty:selected.to,amount:selected.amount,kind:selected.kind as 'loan'|'repayment'});}
  const changed=!same(selected,nativeFinance(entry))||memo!==entry.memo||voided!==entry.voided;
  if(changed)meaningfulAmendments.add(entry.id);
  if(changed||!entry.source_row_key)amendments.push({id:entry.id,version:entry.version,source_row_key:entry.source_row_key??entry.id,entry_date:selected.date,from_party:selected.from,to_party:selected.to,amount:selected.amount,kind:selected.kind as 'loan'|'repayment',memo,voided,previous_row:mirror?.cells??Array.from({length:9},()=> '')});
  rows.push(manual?{id:manual.id,source_row:manual.row,date:manual.date,from_business:manual.fromParty,to_business:manual.toParty,amount:manual.amount,kind:manual.kind,memo:manual.memo,native_id:entry.id,origin:'source',voided}:{id:entry.id,source_row:entry.sheet_row,date:selected.date,from_business:selected.from,to_business:selected.to,amount:selected.amount,kind:selected.kind as 'loan'|'repayment',memo,native_id:entry.id,origin:'mirror',voided});
 }
 for(const mirror of source.mirrorRows){
  if(native.has(mirror.id)||representedMirrors.has(mirror.id))continue;
  rows.push({id:mirror.id,source_row:mirror.row,date:mirror.date,from_business:mirror.fromParty,to_business:mirror.toParty,amount:mirror.amount,kind:mirror.kind,memo:mirror.memo,native_id:null,origin:'mirror',voided:mirror.voided});
 }
 if(register.sheet_sync)for(const old of register.sheet_sync.rows){if(!rows.some(r=>r.id===old.id))conflict('이전에 반영한 시트 기록이 없어졌습니다. 삭제한 행과 연동ID를 확인해주세요.',old.source_row);}
 const through=[baseline.as_of,...rows.map(r=>r.date),...register.entries.map(e=>e.entry_date)].sort().at(-1)!;
 const snapshot=intercompanySheetSnapshotInputSchema.parse({fingerprint:source.fingerprint,through_date:through,historical_base_pairs:source.historicalBasePairs.map(p=>({business_a:p.business_a,business_b:p.business_b,a_to_b:p.a_to_b,b_to_a:p.b_to_a})),rows:rows.sort((a,b)=>a.id.localeCompare(b.id)),mirrored_max_row:Math.max(1,...source.mirrorRows.map(r=>r.row),...register.entries.map(e=>e.sheet_row))});
 const oldRows=new Map<string,{financial:Financial;memo:string;voided:boolean}>();
 if(register.sheet_sync)for(const row of register.sheet_sync.rows){oldRows.set(row.id,{financial:sourceFinance(row),memo:row.memo,voided:row.voided});}
 else{
  for(const row of baseline.additions)oldRows.set(row.id,{financial:{date:row.date,from:row.from_business,to:row.to_business,amount:row.amount,kind:row.kind},memo:row.memo,voided:false});
  for(const entry of register.entries)oldRows.set(linked.get(entry.id)?.id??entry.id,{financial:nativeFinance(entry),memo:entry.memo,voided:entry.voided});
 }
 let added=0,updated=0,unchanged=0;
 for(const row of rows){
  const old=oldRows.get(row.id),amend=row.native_id&&meaningfulAmendments.has(row.native_id);
  if(!old)added++;else if(amend||!same(sourceFinance(row),old.financial)||row.voided!==old.voided||(!row.native_id&&row.memo!==old.memo))updated++;else unchanged++;
 }
 const pairKey=(p:{business_a:string;business_b:string})=>JSON.stringify([p.business_a,p.business_b]);
 const oldBase=register.sheet_sync?.historical_base_pairs??baseline.pairs.map(pair=>{
  const result={business_a:pair.business_a,business_b:pair.business_b,a_to_b:pair.a_to_b,b_to_a:pair.b_to_a};
  for(const row of baseline.additions){if(row.from_business===pair.business_a&&row.to_business===pair.business_b)result.a_to_b-=row.amount;if(row.from_business===pair.business_b&&row.to_business===pair.business_a)result.b_to_a-=row.amount;}return result;
 });
 const basisUpdated=snapshot.historical_base_pairs.filter(p=>{const old=oldBase.find(o=>pairKey(o)===pairKey(p));return !old||old.a_to_b!==p.a_to_b||old.b_to_a!==p.b_to_a;}).length;
 // Overflow/unknown-party checks run before any financial write.
 const projected=register.entries.map(e=>{const a=amendments.find(a=>a.id===e.id);return a?{...e,...a,version:e.version+1}:e;});
 buildIntercompanyRegister({...register,entries:projected,sheet_sync:{...snapshot,revision:1,synced_at:new Date().toISOString()}},[]);
 return {snapshot,amendments,sourceUpdates,summary:{added,updated,unchanged,basisUpdated}};
}
