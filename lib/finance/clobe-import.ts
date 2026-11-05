import {createClassifier,parseDate,parseTime,safePattern,type ParsedRow} from './parser';
import {normalizeSourceDetails} from './source-details';
import {isHistoricalCompletionCategory} from './category-status';
import type {Dataset,SourceDetails,Transaction} from './types';

/** The transport validates Clobe's schema; this model never guesses a date,
 * counterparty, direction or an exchange rate. External IDs remain strings. */
export type ClobeImportRow={company_id:string;external_account_id:string;external_transaction_id:string;account_id:string;currency:'KRW';txn_date:string;txn_time:string|null;amount:number;direction:'in'|'out';balance:number|null;description:string;raw_gwamok?:string;source_details?:SourceDetails|null};
export type ClobeAccountMapping={company_id:string;external_account_id:string;account_id:string};
export type ClobeImportScope={connection_id:string|null;mappings:ClobeAccountMapping[];start_date:string;end_date:string};
export type ExternalTransactionRef={company_id:string;external_account_id:string;external_transaction_id:string;account_id:string;transaction_id:string;source_fingerprint:string};
export type ClobeImportConflict={company_id:string;external_account_id:string;external_transaction_id:string;account_id:string;date:string;code:'changed-source'|'ambiguous-existing'|'insufficient-evidence'|'duplicate-external-id'|'mapping-changed'|'missing-reference'|'partial-day';message:string};
export type ClobeImportSummary={inserted:number;referenced:number;unchanged:number;sourceDuplicates:number;blocked:number;updated:0;removed:0};
export type ClobeImportChange={kind:'insert'|'reference';company_id:string;external_account_id:string;external_transaction_id:string;account_id:string;transaction_id:string;source_fingerprint:string;expected_candidates_hash:string;row:ParsedRow;expected:Record<string,unknown>|null};
export const CLOBE_IMPORT_LIMIT=20000;
const normalize=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
async function sha(value:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}
export const clobeHash=(value:unknown)=>sha(JSON.stringify(value));
export const clobeCandidatesHash=(rows:Transaction[])=>sha([...rows].sort((a,b)=>a.id.localeCompare(b.id)).map(row=>`${row.id}|${row.txn_time??''}|${row.balance??''}`).join('\n'));
const uuid=(hex:string)=>`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-${((parseInt(hex[16],16)&3)|8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`;
const key=(row:Pick<ClobeImportRow,'company_id'|'external_account_id'|'external_transaction_id'>)=>JSON.stringify([row.company_id,row.external_account_id,row.external_transaction_id]);
const accountKey=(row:ClobeAccountMapping)=>JSON.stringify([row.company_id,row.external_account_id]);
const core=(row:Pick<Transaction,'account_id'|'txn_date'|'direction'|'amount'>)=>JSON.stringify([row.account_id,row.txn_date,row.direction,row.amount]);
const financial=(row:Pick<Transaction,'account_id'|'txn_date'|'txn_time'|'direction'|'amount'|'balance'>)=>[row.account_id,row.txn_date,row.txn_time??null,row.direction,row.amount,row.balance??null];
export const clobeSourceFingerprint=(row:ClobeImportRow)=>clobeHash(['clobe-financial-v1',...financial(row)]);
const validId=(value:string)=>typeof value==='string'&&value.length>=1&&value.length<=200&&!/[\u0000-\u001f]/.test(value);
const validUuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function assertClobeImportScope(scope:ClobeImportScope,data?:Dataset){
 if(scope.connection_id!==null&&!validUuid(scope.connection_id))throw Error('Clobe 연결 식별자가 올바르지 않습니다.');
 if(parseDate(scope.start_date)!==scope.start_date||parseDate(scope.end_date)!==scope.end_date||scope.start_date>scope.end_date)throw Error('Clobe 조회 기간을 확인해주세요.');
 if(!scope.mappings.length||scope.mappings.length>100||new Set(scope.mappings.map(accountKey)).size!==scope.mappings.length||new Set(scope.mappings.map(m=>m.account_id)).size!==scope.mappings.length)throw Error('Clobe 통장과 멀린 계좌를 각각 하나씩 연결해주세요.');
 for(const mapping of scope.mappings){
  if(!validId(mapping.company_id)||!validId(mapping.external_account_id)||!validUuid(mapping.account_id)||data&&!data.accounts.some(a=>a.id===mapping.account_id))throw Error('등록된 Clobe 통장 연결을 확인해주세요.');
 }
}
function assertRow(row:ClobeImportRow,scope:ClobeImportScope){
 if(!validId(row.company_id)||!validId(row.external_account_id)||!validId(row.external_transaction_id)||!validUuid(row.account_id)||row.currency!=='KRW')throw Error('Clobe 거래 식별자·원화 계좌를 확인해주세요.');
 if(!scope.mappings.some(m=>accountKey(m)===accountKey(row)&&m.account_id===row.account_id))throw Error('Clobe 거래의 계좌 연결이 등록 정보와 다릅니다.');
 if(parseDate(row.txn_date)!==row.txn_date||row.txn_date<scope.start_date||row.txn_date>scope.end_date||row.txn_time!==null&&parseTime(row.txn_time)!==row.txn_time)throw Error('Clobe 거래 날짜·시간이 조회 범위와 다릅니다.');
 if(!Number.isSafeInteger(row.amount)||row.amount<=0||!['in','out'].includes(row.direction)||row.balance!==null&&!Number.isSafeInteger(row.balance))throw Error('Clobe 거래 금액·입출금·잔액을 확인해주세요.');
 if(typeof row.description!=='string'||row.description.length>1000||typeof row.raw_gwamok!=='undefined'&&(typeof row.raw_gwamok!=='string'||row.raw_gwamok.length>200))throw Error('Clobe 원본 내역 길이를 확인해주세요.');
 if(row.source_details?.provenance)throw Error('Clobe 거래에 Google 시트 원본 위치를 사용할 수 없습니다.');
}
// Bare bank/channel labels are not evidence that two payments are identical.
function meaningful(value:string){const n=normalize(value);return n.length>=3&&!/^(?:입금|출금|이체|송금|카드|카드대금|카드결제|체크카드|체크입금|체크출금|자동이체|현금|수수료|인터넷|기업|농협|신한|국민|우리|하나|은행|bank|card|deposit|withdrawal|transfer)(?:은행|뱅킹|결제|입금|출금|거래)?$/.test(n);}
function sourceTexts(row:Pick<Transaction,'description'|'source_details'>){return [row.description,row.source_details?.basic,row.source_details?.detail,row.source_details?.counterparty,row.source_details?.record].filter((v):v is string=>!!v&&meaningful(v)).map(normalize);}
function evidence(source:ClobeImportRow,saved:Transaction){
 const time=!!source.txn_time&&!!saved.txn_time,balance=source.balance!==null&&saved.balance!==null;
 if(time&&source.txn_time!==saved.txn_time||balance&&source.balance!==saved.balance)return false;
 const sameText=sourceTexts(source).some(text=>sourceTexts(saved).includes(text));
 return time&&balance||(time||balance)&&sameText;
}
function clearlyDifferent(source:ClobeImportRow,saved:Transaction){
 return !!source.txn_time&&!!saved.txn_time&&source.txn_time!==saved.txn_time||source.balance!==null&&saved.balance!==null&&source.balance!==saved.balance;
}
function expected(row:Transaction){return {account_id:row.account_id,txn_date:row.txn_date,txn_time:row.txn_time??null,amount:row.amount,direction:row.direction,balance:row.balance,description:row.description,source_details:row.source_details??null};}

function createClobeClassifier(data:Dataset){
 const classify=createClassifier(data.categories,data.rules,data.aliases),categories=new Map(data.categories.map(category=>[category.id,category]));
 const rules=[...data.rules].sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id)).flatMap(rule=>{
  const category=categories.get(rule.category_id);if(!category||isHistoricalCompletionCategory(category.name))return [];
  try{return [{rule,pattern:safePattern(rule.pattern),classify:createClassifier(data.categories,[rule],data.aliases)}];}catch{return [];}
 });
 return (source:ClobeImportRow)=>{
  const context={account_id:source.account_id,direction:source.direction,txn_date:source.txn_date};
  // The visible description joins bank name/detail. Keep exact saved rules
  // applicable to each original bank text without editing or broadening their
  // regex, account/direction scope or priority. Provider labels and memo/note
  // are deliberately excluded from the list of classification candidates.
  const texts=[...new Set([source.description,source.source_details?.basic,source.source_details?.detail,source.source_details?.counterparty,source.source_details?.record].filter((value):value is string=>typeof value==='string'&&!!value.trim()).map(value=>value.trim()))];
  for(const candidate of rules){
   if(candidate.rule.account_id&&candidate.rule.account_id!==source.account_id||candidate.rule.direction&&candidate.rule.direction!==source.direction)continue;
   const matched=candidate.rule.field==='raw_gwamok'?(candidate.pattern.test('')?source.description:undefined):texts.find(text=>candidate.pattern.test(text.slice(0,1000)));
   if(matched!==undefined)return candidate.classify('',matched,context);
  }
  return classify('',source.description,context);
 };
}

/** Existing transactions never appear as update/delete operations. Their
 * manual categories, note subjects, raw details, upload links and transfer
 * links are untouched; provider associations live in a separate table. */
export async function buildClobeAppendPlan(data:Dataset,incoming:ClobeImportRow[],refs:ExternalTransactionRef[],scope:ClobeImportScope){
 assertClobeImportScope(scope,data);
 if(incoming.length>CLOBE_IMPORT_LIMIT)throw Error('Clobe 거래는 한 번에 20,000건까지 가져올 수 있습니다. 기간을 나누어 조회해주세요.');
 const classify=createClobeClassifier(data),changes:ClobeImportChange[]=[],conflicts:ClobeImportConflict[]=[];
 const summary:ClobeImportSummary={inserted:0,referenced:0,unchanged:0,sourceDuplicates:0,blocked:0,updated:0,removed:0};
 const byRef=new Map(refs.map(ref=>[key(ref),ref])),byId=new Map(data.transactions.map(row=>[row.id,row])),byCore=new Map<string,Transaction[]>();
 for(const row of data.transactions){const k=core(row),group=byCore.get(k)||[];group.push(row);byCore.set(k,group);}
 const baselineCandidates=new Map(await Promise.all([...byCore].map(async([k,rows])=>[k,await clobeCandidatesHash(rows)] as const))),emptyCandidates=await clobeCandidatesHash([]);
 const group=new Map<string,ClobeImportRow[]>();
 for(const row of incoming){assertRow(row,scope);const k=key(row),list=group.get(k)||[];list.push(row);group.set(k,list);}
 const block=(row:ClobeImportRow,code:ClobeImportConflict['code'],message:string)=>{summary.blocked++;conflicts.push({company_id:row.company_id,external_account_id:row.external_account_id,external_transaction_id:row.external_transaction_id,account_id:row.account_id,date:row.txn_date,code,message});};
 const consumed=new Set<string>();
 for(const rows of group.values()){
  const source=rows[0],fingerprint=await clobeSourceFingerprint(source);
  if(rows.length>1){
   const signatures=await Promise.all(rows.map(clobeSourceFingerprint));
   if(signatures.some(value=>value!==fingerprint)){block(source,'duplicate-external-id','같은 Clobe 거래 번호의 날짜·금액·입출금·잔액이 서로 달라 보류했습니다.');summary.sourceDuplicates+=rows.length-1;continue;}
   summary.sourceDuplicates+=rows.length-1;
  }
  const ref=byRef.get(key(source));
  if(ref){
   if(ref.account_id!==source.account_id){block(source,'mapping-changed','이미 가져온 Clobe 통장의 멀린 계좌 연결이 달라 보류했습니다.');continue;}
   if(ref.source_fingerprint!==fingerprint){block(source,'changed-source','이미 가져온 Clobe 거래의 금융값이 변경되었습니다. 기존 거래를 보존하고 정정 확인을 위해 보류했습니다.');continue;}
   const saved=byId.get(ref.transaction_id);
   if(!saved){block(source,'missing-reference','연결된 기존 거래를 찾지 못했습니다. 자료를 새로고침하고 다시 확인해주세요.');continue;}
   if(core(saved)!==core(source)||(source.txn_time&&saved.txn_time&&source.txn_time!==saved.txn_time)||(source.balance!==null&&saved.balance!==null&&source.balance!==saved.balance)){
    block(source,'changed-source','연결된 기존 거래의 금융값이 원본과 달라 보류했습니다. 기존 거래는 변경하지 않습니다.');continue;
   }
   summary.unchanged++;continue;
  }
  const candidates=byCore.get(core(source))||[],possible=candidates.filter(saved=>!clearlyDifferent(source,saved));
  if(possible.length){
   const matches=possible.filter(saved=>evidence(source,saved));
   if(possible.length!==1||matches.length!==1){block(source,matches.length?'ambiguous-existing':'insufficient-evidence','같은 통장·날짜·입출금·금액의 기존 거래가 있으나 일치 근거가 부족하거나 여러 건입니다. 중복 추가하지 않고 보류했습니다.');continue;}
   const saved=matches[0];
   if(consumed.has(saved.id)||refs.some(r=>r.transaction_id===saved.id&&r.company_id===source.company_id&&r.external_account_id===source.external_account_id)){
    block(source,'ambiguous-existing','서로 다른 Clobe 거래 번호가 같은 기존 거래에 연결될 수 있어 보류했습니다.');continue;
   }
   // Provider labels are display-only. Only this workspace's saved rules and
   // a later explicit user choice may classify a newly imported transaction.
   const raw='',classification=classify(source);
   changes.push({kind:'reference',company_id:source.company_id,external_account_id:source.external_account_id,external_transaction_id:source.external_transaction_id,account_id:source.account_id,transaction_id:saved.id,source_fingerprint:fingerprint,expected_candidates_hash:baselineCandidates.get(core(source))||emptyCandidates,expected:expected(saved),row:{txn_date:source.txn_date,txn_time:source.txn_time,amount:source.amount,direction:source.direction,balance:source.balance,description:source.description,raw_gwamok:raw,...classification,source_details:normalizeSourceDetails(source.source_details),dedup_hash:saved.dedup_hash,tax_invoice:false,manually_classified:false}});
   consumed.add(saved.id);summary.referenced++;continue;
  }
  const dedupHash=await clobeHash(['clobe-append-v1',source.company_id,source.external_account_id,source.external_transaction_id,source.account_id]),id=uuid(dedupHash);
  const raw='',classification=classify(source);
  const row:ParsedRow={txn_date:source.txn_date,txn_time:source.txn_time,amount:source.amount,direction:source.direction,balance:source.balance,description:source.description,raw_gwamok:raw,...classification,source_details:normalizeSourceDetails(source.source_details),dedup_hash:dedupHash,tax_invoice:false,manually_classified:false};
  changes.push({kind:'insert',company_id:source.company_id,external_account_id:source.external_account_id,external_transaction_id:source.external_transaction_id,account_id:source.account_id,transaction_id:id,source_fingerprint:fingerprint,expected_candidates_hash:baselineCandidates.get(core(source))||emptyCandidates,expected:null,row});
  // A different external ID with the same financial core requires review,
  // including within a single fetched batch, rather than being guessed away.
  const virtual:Transaction={...row,id,business_id:data.accounts.find(a=>a.id===source.account_id)!.business_id,account_id:source.account_id,upload_id:null};
  byCore.set(core(source),[...candidates,virtual]);consumed.add(id);summary.inserted++;
 }
 // A partly imported bank day can make its final-record balance look settled
 // while missing another transaction. Withhold that entire account/day, and
 // let the user apply only complete days/accounts without rewriting history.
 const conflictIds=new Set(conflicts.map(key)),blockedDays=new Set(incoming.filter(row=>conflictIds.has(key(row))).map(row=>JSON.stringify([row.account_id,row.txn_date])));
 const completeChanges=changes.filter(change=>{
  if(!blockedDays.has(JSON.stringify([change.account_id,change.row.txn_date])))return true;
  summary[change.kind==='insert'?'inserted':'referenced']--;summary.blocked++;
  conflicts.push({company_id:change.company_id,external_account_id:change.external_account_id,external_transaction_id:change.external_transaction_id,account_id:change.account_id,date:change.row.txn_date,code:'partial-day',message:'같은 통장의 해당 일자에 확인이 필요한 거래가 있어 그날 거래 전체를 보류했습니다. 일부 거래만 반영해 잔액을 확정하지 않습니다.'});
  return false;
 });
 return {changes:completeChanges,summary,conflicts,planHash:await clobeHash({changes:completeChanges,summary,conflicts})};
}
