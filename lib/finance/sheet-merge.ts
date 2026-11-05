import {digest,type ParsedRow} from './parser';
import {noteKey,noteSubject} from './merchant-notes';
import {mergeSourceDetails,normalizeSourceDetails,sourceDetailFields} from './source-details';
import type {Dataset,Transaction} from './types';
import {isReviewCategoryName,type SheetCategoryStatus} from './sheet-category';
import {isHistoricalCompletionCategory,isHistoricalDate,resolveHistoricalCompletion} from './category-status';

export type SheetMergeRow=ParsedRow&{
 account_id:string;sheet:string;source_row:number;
 category_status?:SheetCategoryStatus;
 provided:{category:boolean;balance:boolean;tax:boolean;time:boolean};
};
export type SheetMergeChange={kind:'insert'|'update';account_id:string;id:string;expected:Transaction|null;row:ParsedRow;duplicates:{id:string;expected:Transaction}[]};
export type SheetMergeConflict={sheet:string;row:number;message:string};
export type SheetMergeOptions={sourceAuthority?:boolean;appendOnly?:boolean};
type Evidence=Pick<ParsedRow,'balance'|'txn_time'>;

const normalize=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
const core=(row:Pick<Transaction,'account_id'|'txn_date'|'amount'|'direction'|'description'>)=>JSON.stringify([row.account_id,row.txn_date,row.amount,row.direction,normalize(row.description)]);
const monetaryKey=(row:Pick<Transaction,'account_id'|'txn_date'|'amount'|'direction'>)=>JSON.stringify([row.account_id,row.txn_date,row.amount,row.direction]);
const bankKey=(row:Pick<Transaction,'account_id'|'txn_date'|'amount'|'direction'|'balance'>)=>JSON.stringify([monetaryKey(row),row.balance]);
const hasBalance=(row:Evidence)=>row.balance!==undefined&&row.balance!==null;
const hasTime=(row:Evidence)=>!!row.txn_time;
const strong=(row:Evidence)=>hasBalance(row)&&hasTime(row);
const compatible=(a:Evidence,b:Evidence)=>!(hasBalance(a)&&hasBalance(b)&&a.balance!==b.balance)&&!(hasTime(a)&&hasTime(b)&&a.txn_time!==b.txn_time);
const sameEvidence=(a:Evidence,b:Evidence)=>strong(a)&&strong(b)&&a.balance===b.balance&&a.txn_time===b.txn_time;
const genericBankText=new Set(['입금','출금','미매핑','이체','대체','입출금','현금','기타','급여','대여금','상환','관리비','수수료','인터넷','모바일','기업뱅킹','인터넷뱅킹','스마트뱅킹','타행이체','계좌이체','자동이체','deposit','withdrawal','transfer','online','mobile','internetbanking']);
const genericBankTokens=[...genericBankText].sort((a,b)=>b.length-a.length);
function bankTexts(row:Pick<Transaction,'description'|'source_details'>,categoryLabels:ReadonlySet<string>){
 return [row.description,row.source_details?.basic,row.source_details?.detail,row.source_details?.counterparty]
  .filter((value):value is string=>!!value?.trim()).map(normalize)
  .filter(value=>{
   const key=value.replace(/\s+/g,'');
   if(genericBankText.has(key)||categoryLabels.has(key))return false;
   let letters=key.replace(/[\p{N}\p{P}\p{S}]/gu,'');
   if(categoryLabels.has(letters))return false;
   for(const token of genericBankTokens)letters=letters.replaceAll(token,'');
   return (letters.match(/\p{L}/gu)?.length??0)>=2;
  });
}
function conflictingCounterparty(a:Pick<Transaction,'source_details'>,b:Pick<Transaction,'source_details'>){
 const first=a.source_details?.counterparty?.trim(),second=b.source_details?.counterparty?.trim();
 return !!first&&!!second&&normalize(first)!==normalize(second);
}
function sharesBankText(a:Pick<Transaction,'description'|'source_details'>,b:Pick<Transaction,'description'|'source_details'>,categoryLabels:ReadonlySet<string>){
 const previous=new Set(bankTexts(b,categoryLabels));
 return bankTexts(a,categoryLabels).some(value=>previous.has(value));
}
function originKey(row:Pick<Transaction,'account_id'|'source_details'>){
 const origin=row.source_details?.provenance;
 return origin?.url?.trim()&&origin.sheet&&Number.isInteger(origin.row)&&origin.row>=1?JSON.stringify([row.account_id,origin.url,origin.sheet,origin.row]):null;
}
function sameRecordedOrigin(source:SheetMergeRow,previous:Transaction){
 const a=source.source_details?.provenance,b=previous.source_details?.provenance;
 return !!a?.url?.trim()&&a.url===b?.url&&!!a.sheet&&a.sheet===b.sheet&&a.sheet===source.sheet
  &&Number.isInteger(a.row)&&a.row>=1&&a.row===b.row&&a.row===source.source_row;
}
function sameRecordedSource(source:SheetMergeRow,previous:Transaction){
 const next=source.source_details,saved=previous.source_details;
 if(!next?.basic?.trim()||next.basic!==saved?.basic)return false;
 if(next.detail&&saved.detail&&next.detail!==saved.detail)return false;
 return sameRecordedOrigin(source,previous)&&compatible(source,previous);
}
const orderSource=(a:SheetMergeRow,b:SheetMergeRow)=>a.sheet.localeCompare(b.sheet)||a.source_row-b.source_row;
const parsedKeys=['txn_date','txn_time','source_sheet','source_row','source_details','amount','direction','description','raw_gwamok','category_id','is_internal','balance','tax_invoice','dedup_hash','manually_classified'] as const;

function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value)??'null';
}
async function sha256(value:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}
function recordEvidence(row:Pick<ParsedRow,'balance'|'txn_time'|'source_details'>){
 const details=normalizeSourceDetails(row.source_details);
 return canonical({balance:row.balance??null,time:row.txn_time??null,details:Object.fromEntries(sourceDetailFields.filter(field=>details?.[field]).map(field=>[field,details![field]]))});
}
const hasRecordedContent=(row:Pick<ParsedRow,'source_details'>)=>['basic','detail','counterparty','record'].some(field=>!!row.source_details?.[field as keyof ParsedRow['source_details']]);
async function sourceId(sourceHash:string,row:SheetMergeRow,sourceAuthority=false){
 const identity=[sourceHash,row.account_id,core(row),row.balance??null,row.txn_time??null];
 const hex=await sha256(canonical(sourceAuthority?[...identity,recordEvidence(row)]:identity));
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-${((parseInt(hex[16],16)&3)|8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function sourceSignature(row:SheetMergeRow){
 const {account_id,txn_date,txn_time,amount,direction,description,raw_gwamok,category_id,is_internal,balance,tax_invoice,manually_classified,provided}=row;
 const details=normalizeSourceDetails(row.source_details);
 const source_details=Object.fromEntries(sourceDetailFields.filter(field=>details?.[field]).map(field=>[field,details![field]]));
 return canonical({account_id,txn_date,txn_time:txn_time??null,amount,direction,description,raw_gwamok,category_id,is_internal,balance,tax_invoice,manually_classified,provided,source_details});
}
function repeatedSequenceRows(incoming:SheetMergeRow[]){
 const grouped=new Map<string,SheetMergeRow[]>(),removed=new Set<SheetMergeRow>();
 for(const row of incoming){const key=JSON.stringify([row.account_id,row.sheet]),group=grouped.get(key)||[];group.push(row);grouped.set(key,group);}
 const scan=(rows:SheetMergeRow[])=>{
  if(rows.length<16)return;
  const signatures=rows.map(sourceSignature),positions=new Map<string,number[]>();
  const forwardEnd=new Array<number>(rows.length),reverseEnd=new Array<number>(rows.length);
  for(let i=rows.length-1;i>=0;i--){
   forwardEnd[i]=i;reverseEnd[i]=i;
   const a=rows[i],b=rows[i+1];
   if(b&&hasBalance(a)&&hasBalance(b)){
    if(a.txn_date<=b.txn_date&&b.balance===a.balance!+(b.direction==='in'?b.amount:-b.amount))forwardEnd[i]=forwardEnd[i+1];
    if(a.txn_date>=b.txn_date&&a.balance===b.balance!+(a.direction==='in'?a.amount:-a.amount))reverseEnd[i]=reverseEnd[i+1];
   }
  }
  for(let i=0;i<signatures.length;i++){const group=positions.get(signatures[i])||[];group.push(i);positions.set(signatures[i],group);}
  for(let i=0;i<rows.length;i++){
   if(removed.has(rows[i]))continue;
   const end=Math.max(forwardEnd[i],reverseEnd[i]);
   if(end-i+1<8)continue;
   for(const next of positions.get(signatures[i])||[]){
    const length=next-i;
    if(length<8)continue;
    if(next>end+1||next+length>rows.length)break;
    if(rows[i].txn_date===rows[next-1].txn_date)continue;
    // Adjacent repeated blocks must preserve every supplied value, and the
    // retained block must be a complete, dated bank-balance sequence.
    if(!signatures.slice(i,next).every((signature,offset)=>signature===signatures[next+offset]&&!removed.has(rows[i+offset])&&!removed.has(rows[next+offset])))continue;
    let copy=next;
    while(copy+length<=rows.length&&signatures.slice(i,next).every((signature,offset)=>signature===signatures[copy+offset]&&!removed.has(rows[copy+offset]))){
     for(let offset=0;offset<length;offset++)removed.add(rows[copy+offset]);
     copy+=length;
    }
    i=copy-1;break;
   }
  }
 };
 for(const group of grouped.values()){
  group.sort((a,b)=>a.source_row-b.source_row);
  let run:SheetMergeRow[]=[];
  for(const row of group){
   if(run.length&&row.source_row!==run[run.length-1].source_row+1){scan(run);run=[];}
   run.push(row);
  }
  scan(run);
 }
 return removed;
}
function ambiguousSources(sources:SheetMergeRow[]){
 const balances=new Map<number|null,number>(),times=new Map<string|null,number>();
 const full=new Map<string,number>(),balanceOnly=new Map<number,number>(),timeOnly=new Map<string,number>();
 const increment=<T,>(map:Map<T,number>,key:T)=>map.set(key,(map.get(key)||0)+1);
 let neither=0;
 for(const source of sources){
  const balance=source.balance??null,time=source.txn_time||null;
  increment(balances,balance);increment(times,time);
  if(balance!==null&&time!==null)increment(full,JSON.stringify([balance,time]));
  else if(balance!==null)increment(balanceOnly,balance);
  else if(time!==null)increment(timeOnly,time);
  else neither++;
 }
 return new Set(sources.filter(source=>{
  const balance=source.balance??null,time=source.txn_time||null;
  const count=balance===null&&time===null?sources.length
   :balance===null?(times.get(time)||0)+(times.get(null)||0)
   :time===null?(balances.get(balance)||0)+(balances.get(null)||0)
   :(full.get(JSON.stringify([balance,time]))||0)+(balanceOnly.get(balance)||0)+(timeOnly.get(time)||0)+neither;
  return count>1;
 }));
}
function mergedRow(source:SheetMergeRow,previous?:Transaction,previousCategoryValid=false,allowSourceClassification=false):ParsedRow{
 const categoryProvided=source.provided.category&&!!(source.raw_gwamok.trim()||source.category_id);
 const categoryResolved=(source.category_status??(source.category_id?'mapped':'unregistered'))==='mapped';
 const preserveCategory=!!previous&&previousCategoryValid&&categoryProvided&&!categoryResolved;
 const sourceClassification=allowSourceClassification&&!previousCategoryValid&&(!categoryProvided||!categoryResolved);
 return {
  txn_date:source.txn_date,txn_time:source.provided.time&&hasTime(source)?source.txn_time:(previous?previous.txn_time??null:source.txn_time??null),
  source_sheet:source.sheet,source_row:source.source_row,amount:source.amount,direction:source.direction,description:previous?.description??source.description,
  source_details:mergeSourceDetails(previous?.source_details,source.source_details),
  raw_gwamok:categoryProvided?source.raw_gwamok:(previous?.raw_gwamok??source.raw_gwamok),
  category_id:sourceClassification||categoryProvided&&!preserveCategory?source.category_id:(previous?previous.category_id:source.category_id),
  is_internal:sourceClassification||categoryProvided&&!preserveCategory?source.is_internal:(previous?.is_internal??source.is_internal),
  balance:source.provided.balance&&hasBalance(source)?source.balance:(previous?previous.balance:source.balance),
  tax_invoice:source.provided.tax?source.tax_invoice:(previous?.tax_invoice??source.tax_invoice),
  manually_classified:sourceClassification?false:categoryProvided?(preserveCategory?previous!.manually_classified:categoryResolved):(previous?.manually_classified??source.manually_classified),dedup_hash:'',
 };
}

/** Plans a conservative, source-preferred reconciliation; it never writes data. */
export async function buildSheetMergePlan(data:Dataset,incoming:SheetMergeRow[],sourceHash:string,options:SheetMergeOptions={}){
 const sourceAuthority=options.sourceAuthority===true;
 const changes:SheetMergeChange[]=[],conflicts:SheetMergeConflict[]=[];
 const summary={inserted:0,updated:0,removed:0,unchanged:0,sourceDuplicates:0,blocked:0};
 const repeatedSequences=repeatedSequenceRows(incoming);summary.sourceDuplicates=repeatedSequences.size;
 const existingGroups=new Map<string,Transaction[]>(),sourceGroups=new Map<string,SheetMergeRow[]>(),existingByMoney=new Map<string,Transaction[]>();
 const existingByBank=new Map<string,Transaction[]>(),sourcesByBank=new Map<string,SheetMergeRow[]>(),sourcesByMoney=new Map<string,SheetMergeRow[]>();
 const sourceScopes=new Map<string,SheetMergeRow[]>();
 const existingOrigins=new Map<string,Transaction[]>();
 const consumedExisting=new Set<string>();
 const accounts=new Map(data.accounts.map(a=>[a.id,a]));
 const categoryLabels=new Set(data.categories.map(category=>normalize(category.name).replace(/\s+/g,'')));
 const validCategories=new Set(data.categories.filter(category=>!isReviewCategoryName(category.name)).map(category=>category.id));
 const merge=(source:SheetMergeRow,previous?:Transaction)=>{
  const row=mergedRow(source,previous,!!previous?.category_id&&validCategories.has(previous.category_id),sourceAuthority&&!!source.category_id&&validCategories.has(source.category_id));
  const completed=resolveHistoricalCompletion(data.categories,row.txn_date,row.category_id);
  if(completed){row.category_id=completed.id;row.is_internal=completed.is_internal;}
  if(isHistoricalDate(row.txn_date)&&isHistoricalCompletionCategory(data.categories.find(category=>category.id===row.category_id)?.name))row.manually_classified=true;
  return row;
 };
 const noteKeys=new Set(data.notes.map(noteKey));
 const referenced=new Set(data.links.flatMap(link=>[link.in_transaction_id,link.out_transaction_id]));
 const transactionNotes=new Set(data.notes.filter(n=>n.subject_key.startsWith('transaction:')).map(n=>n.subject_key.slice('transaction:'.length)));
 const protectedIds=new Set([...referenced,...transactionNotes]);
 const plannedHashes=new Map<string,string>();
 const existingHashes=new Map<string,Set<string>>();
 for(const transaction of data.transactions){
  const key=core(transaction),group=existingGroups.get(key)||[];group.push(transaction);existingGroups.set(key,group);
  const moneyKey=monetaryKey(transaction),moneyGroup=existingByMoney.get(moneyKey)||[];moneyGroup.push(transaction);existingByMoney.set(moneyKey,moneyGroup);
  if(hasBalance(transaction)){const key=bankKey(transaction),group=existingByBank.get(key)||[];group.push(transaction);existingByBank.set(key,group);}
  const holders=existingHashes.get(transaction.dedup_hash)||new Set<string>();holders.add(transaction.id);existingHashes.set(transaction.dedup_hash,holders);
  const origin=originKey(transaction);if(origin){const claims=existingOrigins.get(origin)||[];claims.push(transaction);existingOrigins.set(origin,claims);}
 }
 const seenSourceRecords=new Set<string>();
 for(const source of [...incoming].sort(orderSource)){
  if(repeatedSequences.has(source))continue;
  if(sourceAuthority){const signature=sourceSignature(source);if(seenSourceRecords.has(signature)){summary.sourceDuplicates++;continue;}seenSourceRecords.add(signature);}
  const key=core(source),group=sourceGroups.get(key)||[];group.push(source);sourceGroups.set(key,group);
  const moneyKey=monetaryKey(source),moneyGroup=sourcesByMoney.get(moneyKey)||[];moneyGroup.push(source);sourcesByMoney.set(moneyKey,moneyGroup);
  if(hasBalance(source)){const key=bankKey(source),group=sourcesByBank.get(key)||[];group.push(source);sourcesByBank.set(key,group);}
  const scope=JSON.stringify([source.account_id,source.sheet]),rows=sourceScopes.get(scope)||[];rows.push(source);sourceScopes.set(scope,rows);
 }
 const recordedSourceMatch=(source:SheetMergeRow)=>{
  if(!hasBalance(source)||sourcesByBank.get(bankKey(source))?.length!==1)return undefined;
  const matches=existingByBank.get(bankKey(source));
  if(matches?.length!==1)return undefined;
  const previous=matches[0];
  // A saved origin can bridge changed display descriptions only when neither
  // side has another claimant. Never take an ID from an ordinary core match.
  const explicitContent=sourceAuthority&&[source.source_details?.basic,source.source_details?.detail].some(value=>!!value?.trim()&&value===previous.description)
   &&compatible(source,previous)&&(['basic','detail'] as const).every(field=>!previous.source_details?.[field]||!source.source_details?.[field]||previous.source_details[field]===source.source_details[field]);
  if(consumedExisting.has(previous.id)||sourceGroups.has(core(previous))||!(sameRecordedSource(source,previous)||explicitContent))return undefined;
  if(sourcesByMoney.get(monetaryKey(source))?.some(other=>other!==source&&compatible(other,previous)))return undefined;
  return previous;
 };
 const representedBankSource=(previous:Transaction)=>{
  if(!hasBalance(previous)||!Number.isFinite(previous.balance))return undefined;
  const sources=sourcesByBank.get(bankKey(previous)),matches=existingByBank.get(bankKey(previous));
  if(sources?.length!==1||matches?.length!==1||matches[0].id!==previous.id)return undefined;
  const source=sources[0];
  if(!compatible(source,previous)||conflictingCounterparty(source,previous)||!sharesBankText(source,previous,categoryLabels))return undefined;
  // Count claimants across the full source and saved ledger. Previously
  // matched rows must not make an ambiguous bank identity appear unique.
  if((existingByMoney.get(monetaryKey(source))||[]).filter(other=>compatible(source,other)).length!==1)return undefined;
  if(sourcesByMoney.get(monetaryKey(source))?.some(other=>other!==source&&compatible(other,previous)))return undefined;
  return source;
 };
 const appendBankMatch=(source:SheetMergeRow)=>{
  if(!options.appendOnly||!hasBalance(source)||!Number.isFinite(source.balance))return undefined;
  const matches=existingByBank.get(bankKey(source));
  if(matches?.length!==1)return undefined;
  const previous=matches[0];
  if(consumedExisting.has(previous.id)||representedBankSource(previous)!==source)return undefined;
  // Reconnecting or correcting an already recorded sheet location belongs to
  // the existing origin-aware path. This fallback only recognizes legacy bank
  // rows. A displaced origin is safe only if its old payment is independently
  // and uniquely represented by another row in the full current source.
  const origin=originKey(source);
  if(previous.source_details?.provenance||origin&&(existingOrigins.get(origin)||[]).some(claim=>{
   const witness=representedBankSource(claim);
   return !witness||witness===source||witness.sheet===source.sheet&&witness.source_row===source.source_row;
  }))return undefined;
  return previous;
 };
 const distinctBalanceInSequence=(source:SheetMergeRow)=>{
  if(!sourceAuthority||!hasBalance(source)||sourcesByBank.get(bankKey(source))?.length!==1||existingByBank.has(bankKey(source)))return false;
  const rows=sourceScopes.get(JSON.stringify([source.account_id,source.sheet]))!,index=rows.indexOf(source),before=rows[index-1],after=rows[index+1];
  if(!before||!after||!hasBalance(before)||!hasBalance(after))return false;
  const signed=(row:SheetMergeRow)=>row.direction==='in'?row.amount:-row.amount;
  return before.txn_date<=source.txn_date&&source.txn_date<=after.txn_date&&source.balance===before.balance!+signed(source)&&after.balance===source.balance!+signed(after)
   ||before.txn_date>=source.txn_date&&source.txn_date>=after.txn_date&&before.balance===source.balance!+signed(before)&&source.balance===after.balance!+signed(source);
 };
 const block=(source:SheetMergeRow,message:string)=>{conflicts.push({sheet:source.sheet,row:source.source_row,message});summary.blocked++;};
 const memoSafe=(old:Transaction,next:Transaction)=>{const before=noteKey(noteSubject(old)),after=noteKey(noteSubject(next));return before===after||(!noteKeys.has(before)&&!noteKeys.has(after));};

 for(const [key,rawSources] of [...sourceGroups.entries()].sort(([a],[b])=>a.localeCompare(b))){
  const sources:SheetMergeRow[]=[],seenStrong=new Set<string>();
  for(const source of [...rawSources].sort(orderSource)){
   const signature=sourceSignature(source);
   if(strong(source)&&seenStrong.has(signature)){summary.sourceDuplicates++;continue;}
   if(strong(source))seenStrong.add(signature);
   sources.push(source);
  }
  const existing=[...(existingGroups.get(key)||[])].sort((a,b)=>a.id.localeCompare(b.id));
  // Repeated rows without independent bank evidence may be two real payments.
  // Keep them for review instead of collapsing them or creating more copies.
  const overlapping=ambiguousSources(sources);
  if(sourceAuthority)for(const source of overlapping)if(sources.filter(other=>recordEvidence(other)===recordEvidence(source)).length===1)overlapping.delete(source);
  const consumed=new Set<string>();
  for(const source of sources){
   if(overlapping.has(source)){block(source,'같은 날짜·금액·적요의 원본 행을 잔액과 거래시간으로 구분할 수 없습니다. 원본의 반복 거래를 확인하세요.');continue;}
   if(!accounts.has(source.account_id)){block(source,'연결할 통장을 찾을 수 없습니다. 통장 연결을 다시 확인하세요.');continue;}
   const bankMatch=appendBankMatch(source);
   if(bankMatch){
    // Identical bank evidence with an explicit shared source label is enough
    // to skip a replay, never to replace its classification or metadata.
    consumed.add(bankMatch.id);consumedExisting.add(bankMatch.id);summary.unchanged++;continue;
   }
   const available=existing.filter(t=>!consumed.has(t.id)&&!consumedExisting.has(t.id));
   const exact=available.filter(t=>sameEvidence(source,t));
   const possible=available.filter(t=>compatible(source,t));
   const recorded=sourceAuthority?available.filter(t=>recordEvidence(t)===recordEvidence(source)):[];
   // A distinct source occurrence may be added only when every compatible
   // saved record is fully represented by a different, unique source record.
   // Missing historical details never become evidence for a new payment.
   const monetaryMatches=existingByMoney.get(monetaryKey(source))?.filter(t=>compatible(source,t))||[];
   const distinctSourceRecord=sourceAuthority&&hasRecordedContent(source)&&monetaryMatches.length>0&&monetaryMatches.every(t=>core(t)===core(source)&&hasRecordedContent(t)
    &&monetaryMatches.filter(other=>recordEvidence(other)===recordEvidence(t)).length===1
    &&sources.filter(other=>other!==source&&recordEvidence(other)===recordEvidence(t)).length===1);
   let keeper:Transaction|undefined,duplicates:Transaction[]=[];
   if(recorded.length===1)keeper=recorded[0];
   else if(exact.length===1&&!distinctSourceRecord)keeper=exact[0];
   else if(exact.length>1&&!distinctSourceRecord){
    if(sources.length>1){block(source,'기존 반복 거래가 여러 건 일치합니다. 같은 거래임을 확인한 뒤 정리하세요.');continue;}
    const protectedMatches=exact.filter(t=>protectedIds.has(t.id));
    if(protectedMatches.length>1){block(source,'중복 후보 여러 건에 개별 메모 또는 내부이체 연결이 있어 자동으로 삭제할 수 없습니다.');continue;}
    keeper=protectedMatches[0]||exact[0];duplicates=exact.filter(t=>t.id!==keeper!.id);
    const keeperFields=canonical(merge(source,keeper));
    if(duplicates.some(t=>canonical(merge(source,t))!==keeperFields)){
     block(source,'중복 후보에 서로 다른 분류·세금계산서 정보가 남아 있어 자동으로 합칠 수 없습니다.');continue;
    }
   }else if(!distinctSourceRecord&&possible.length===1&&sources.filter(candidate=>compatible(candidate,possible[0])).length===1)keeper=possible[0];
   else if(possible.length&&!distinctSourceRecord){block(source,'기존 거래와 일대일로 연결할 잔액·거래시간 근거가 부족합니다. 중복 생성 없이 검토를 위해 보류했습니다.');continue;}
   else{
    // A saved display description may differ from the sheet even after a
    // successful import. Check its exact recorded origin before a different
    // payment added under the sheet's description can hold that replay.
    keeper=recordedSourceMatch(source);
    // Without that proof, an unmatched repeat still needs review. Enriching
    // another payment's time must not turn a held repeat into a new insert.
    if(!keeper&&!distinctSourceRecord&&!distinctBalanceInSequence(source)&&existing.length&&(sources.length>1||!strong(source)||existing.some(t=>!strong(t)))){
     block(source,'기존 거래와 잔액 또는 거래시간이 다릅니다. 별도 거래인지 확인하기 전에는 덮어쓰거나 추가하지 않습니다.');continue;
    }
   }

   // A corrected bank balance at an already recorded source location is not
   // evidence of an additional payment, even when its new neighbors balance.
   // Hold that correction instead of counting the same payment a second time.
   if(!keeper&&sourceAuthority&&hasBalance(source)&&(existingByMoney.get(monetaryKey(source))||[]).some(previous=>
    hasBalance(previous)&&previous.balance!==source.balance&&sameRecordedOrigin(source,previous)
    &&(core(previous)===core(source)||!!source.source_details?.basic?.trim()&&source.source_details.basic===previous.source_details?.basic
     &&(!source.source_details.detail||!previous.source_details?.detail||source.source_details.detail===previous.source_details.detail)))){
    block(source,'이미 가져온 같은 원본 행의 잔액이 변경되었습니다. 같은 거래를 중복 추가하지 않도록 정정 여부 확인을 위해 보류했습니다.');continue;
   }

   // A bank export and a categorized sheet may describe the same payment
   // differently. Missing bank evidence cannot establish a separate payment.
   // Preserve matched updates, and hold only a potentially duplicated insert.
   if(!keeper&&!distinctSourceRecord&&monetaryMatches.length){
    block(source,'기존 거래와 날짜·금액·입출금이 같고 잔액·거래시간으로 별도 거래임을 확인할 수 없습니다. 거래내용이 달라 중복 추가하지 않고 보류했습니다.');continue;
   }

   if(options.appendOnly&&!keeper&&hasBalance(source)){
    const bankMatches=existingByBank.get(bankKey(source));
    if(bankMatches?.length===1&&core(bankMatches[0])!==core(source)&&hasTime(source)&&hasTime(bankMatches[0])&&source.txn_time!==bankMatches[0].txn_time){
     block(source,'동일한 날짜·금액·잔액의 기존 거래와 명시된 거래시간이 다릅니다. 같은 거래인지 확인할 때까지 추가하지 않습니다.');continue;
    }
   }

   // Append imports use matching only to recognize saved transactions. Never
   // build an update (including metadata) or a duplicate-deletion request.
   if(keeper&&options.appendOnly){
    if(conflictingCounterparty(source,keeper)){
     block(source,'동일 거래 후보의 명시된 거래 상대방이 다릅니다. 기존 거래를 유지하고 확인을 위해 보류했습니다.');continue;
    }
    consumed.add(keeper.id);consumedExisting.add(keeper.id);
    for(const duplicate of duplicates){consumed.add(duplicate.id);consumedExisting.add(duplicate.id);}
    summary.unchanged++;continue;
   }
   const id=keeper?.id||await sourceId(sourceHash,source,sourceAuthority),row=merge(source,keeper);
   if(duplicates.some(duplicate=>sourceDetailFields.some(field=>Object.prototype.hasOwnProperty.call(duplicate.source_details||{},field)&&duplicate.source_details![field]!==row.source_details?.[field]))){
    block(source,'중복 후보에 새 원본에 포함되지 않은 원본 내역이 있습니다. 기록을 보존하기 위해 자동으로 합치지 않습니다.');continue;
   }
   const next:Transaction={...row,id,account_id:source.account_id,business_id:accounts.get(source.account_id)!.business_id,upload_id:null};
   if(keeper&&referenced.has(keeper.id)&&(keeper.is_internal!==next.is_internal||keeper.amount!==next.amount||keeper.direction!==next.direction||keeper.business_id!==next.business_id)){
    block(source,'기존 내부이체 연결이 해제되는 변경입니다. 연결을 보존하기 위해 이 거래는 보류했습니다.');continue;
   }
   if(keeper&&(!memoSafe(keeper,next)||duplicates.some(t=>noteKey(noteSubject(t))!==noteKey(noteSubject(next))&&noteKeys.has(noteKey(noteSubject(t)))))){
    block(source,'적요를 변경하면 저장된 거래처 메모의 연결이 달라집니다. 메모를 보존하기 위해 이 거래는 보류했습니다.');continue;
   }
   const consumedIds=new Set([id,...duplicates.map(t=>t.id)]);
   const legacy=await digest(source.account_id,row.txn_date,row.amount,row.direction,row.description,row.balance);
   const version3=()=>sha256(canonical(['v3',source.account_id,row.txn_date,row.amount,row.direction,normalize(row.description),row.balance??null,row.txn_time??null]));
   const version4=()=>sha256(canonical(['v4',source.account_id,row.txn_date,row.amount,row.direction,normalize(row.description),recordEvidence(row)]));
   // Keep the normal file-import identity whenever it is already unique. A
   // time-aware identity is only needed for a real collision with that hash.
   row.dedup_hash=legacy;
   if(keeper&&keeper.dedup_hash!==legacy&&(keeper.dedup_hash===await version3()||sourceAuthority&&keeper.dedup_hash===await version4()))row.dedup_hash=keeper.dedup_hash;
   const collides=()=>[...(existingHashes.get(row.dedup_hash)||[])].some(holder=>!consumedIds.has(holder))||(plannedHashes.has(row.dedup_hash)&&plannedHashes.get(row.dedup_hash)!==id);
   if(collides())row.dedup_hash=sourceAuthority?await version4():await version3();
   if(collides()){block(source,'중복 식별값이 다른 거래와 겹칩니다. 원본 거래를 확인한 뒤 다시 가져오세요.');continue;}
   const unchanged=keeper&&keeper.upload_id===null&&duplicates.length===0&&parsedKeys.every(field=>field==='source_details'?canonical(keeper[field]??null)===canonical(row[field]??null):(keeper[field]??null)===(row[field]??null));
   for(const consumedId of consumedIds){consumed.add(consumedId);consumedExisting.add(consumedId);}
   plannedHashes.set(row.dedup_hash,id);
   if(unchanged){summary.unchanged++;continue;}
   const kind=keeper?'update':'insert';
   changes.push({kind,account_id:source.account_id,id,expected:keeper??null,row,duplicates:duplicates.map(t=>({id:t.id,expected:t}))});
   if(keeper)summary.updated++;else summary.inserted++;
   summary.removed+=duplicates.length;
  }
 }
 const planHash=await sha256(canonical({changes,summary,conflicts}));
 return {changes,summary,conflicts,planHash};
}
