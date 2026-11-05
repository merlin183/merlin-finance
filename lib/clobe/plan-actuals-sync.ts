import type {ClobeAccountMapping} from '../finance/clobe-import';
import type {SourceDetails} from '../finance/types';
import {clobeSyncRange} from '../finance/clobe-sync-range';
import {calendarMonthRange} from '../finance/transaction-calendar';
import type {ClobeBalanceInput,ClobeBalanceSkip} from './balance-sync';
import {clobeCollectedInstant} from './balance-sync';
import {parseClobeTransactionPage,parseClobeScraping,validClobeDate} from './read';
import type {ClobeReadSession} from './mcp';
import type {ClobeTransactionsRequest,ClobeTransactionsResponse,ClobeScrapingStatus} from './types';

export type ClobePlanActualRow={external_transaction_id:string;txn_date:string;txn_time:string;amount:number;balance:number|null;description:string;party:string|null;source_details:SourceDetails|null};
export type ClobePlanActualScope={company_id:string;external_account_id:string;account_id:string;from:string;to:string;collected_at:string|null;status:'complete'|'confirmation-needed';reason:string|null;rows:ClobePlanActualRow[]};
export type ClobePlanActualSaved={synced_accounts:number;unchanged_accounts:number;saved_outflows:number;skipped:ClobeBalanceSkip[]};
export type ClobePlanActualResult=ClobePlanActualSaved&{fetched_outflows:number;complete:boolean};
export type ClobePlanPage=ClobeTransactionsResponse&{sourceRows:ClobePlanActualRow[]};
export type ClobePlanActualDependencies={readPage:(request:ClobeTransactionsRequest,collectedAt:string)=>Promise<ClobePlanPage>;readStatus:(companyId:string)=>Promise<ClobeScrapingStatus>;save:(scopes:ClobePlanActualScope[])=>Promise<ClobePlanActualSaved>;now?:()=>number;signal?:AbortSignal};
export const CLOBE_PLAN_MAX_PAGES=20,CLOBE_PLAN_MAX_ROWS=2000,CLOBE_PLAN_READ_BUDGET_MS=42000;

/** Account/context permission was already established by the bounded account
 * query. Original bank text is preserved independently from classification. */
export async function readClobePlanActualPage(session:ClobeReadSession,request:ClobeTransactionsRequest,collectedAt:string):Promise<ClobePlanPage>{
 const raw=await session.call('get_labeled_transactions',{companyId:request.companyId,accountId:request.bankAccountId,startDate:request.startDate,endDate:request.endDate,size:100,...(request.cursor?{cursor:request.cursor}:{})});
 const page=parseClobeTransactionPage(raw,request,'KRW',{status:'SUCCESS',lastCollectedAt:collectedAt,error:null});
 const content=(raw as {content:{transactionId:number;transactionName:string;transactionDescription:string;businessEntityName?:string|null}[]}).content;
 const originals=new Map(content.map(row=>[String(row.transactionId),row]));
 const sourceRows=page.rows.filter(row=>row.direction==='out').map(row=>{
  const original=originals.get(row.id)!;
  // Reject oversized source fields rather than silently truncate identity text.
  const basic=original.transactionName.trim(),detail=original.transactionDescription.trim(),party=original.businessEntityName?.trim()||null;
  if([basic,detail,party??''].some(text=>text.length>1000))throw Error('CLOBE_PLAN_SOURCE_INVALID');
  const source_details={...(basic?{basic}:{}),...(detail?{detail}:{}),...(party?{counterparty:party}:{})};
  return {external_transaction_id:row.id,txn_date:row.date,txn_time:row.time,amount:row.amount,balance:row.balance,description:row.description,party,source_details:Object.keys(source_details).length?source_details:null};
 });
 return {...page,sourceRows};
}
export async function readClobePlanBankStatus(session:ClobeReadSession,companyId:string){return parseClobeScraping(await session.call('get_scraping_status',{companyId}));}
const labelText=(value:string)=>value.trim().replace(/\s+/g,' ');
/** Compare padding only in fingerprints; stored bank text remains untouched.
 * Case, punctuation and Unicode width still distinguish explicit labels. */
const signature=(row:ClobePlanActualRow)=>{
 const details=row.source_details?{...row.source_details}:null;
 if(details)for(const field of ['basic','detail','counterparty'] as const){
  const value=details[field];if(typeof value==='string')details[field]=labelText(value);
 }
 return JSON.stringify([row.txn_date,row.txn_time,row.amount,row.balance,labelText(row.description),row.party===null?null:labelText(row.party),details]);
};

/** All bank pages (incoming and outgoing) must validate before any outflow
 * becomes plan evidence. Last month is refreshed as well as this month, so a
 * later collection can finish a previous month's partial coverage. A failed
 * account/month keeps its previous complete scope. */
export async function syncClobePlanActuals(deps:ClobePlanActualDependencies,mappings:ClobeAccountMapping[],snapshots:ClobeBalanceInput[],startedAt=(deps.now??Date.now)()):Promise<ClobePlanActualResult>{
 const now=deps.now??Date.now,range=clobeSyncRange(now()),today=range.to,snapshotByAccount=new Map(snapshots.map(row=>[row.account_id,row]));
 const scopes:ClobePlanActualScope[]=[],skipped:ClobeBalanceSkip[]=[];let fetched_outflows=0,totalRead=0;
 const checkBudget=()=>{if(deps.signal?.aborted||now()-startedAt>=CLOBE_PLAN_READ_BUDGET_MS)throw Error('CLOBE_PLAN_TIMEOUT');};
 const query=async(mapping:ClobeAccountMapping,month:string)=>{
  const requested=calendarMonthRange(month),from=requested.from,requestedTo=requested.to<today?requested.to:today;
  const candidate=snapshotByAccount.get(mapping.account_id),collectedInstant=candidate?clobeCollectedInstant(candidate.collected_at):null;
  const source=candidate&&validClobeDate(candidate.balance_date)&&candidate.balance_date<=today
   &&candidate.balance_date===candidate.collected_at.slice(0,10)&&collectedInstant!==null&&collectedInstant<=now()+5*60000?candidate:undefined;
  const covered=!!source&&source.balance_date>=from,to=covered&&source.balance_date<requestedTo?source.balance_date:requestedTo;
  // A collection older than this month cannot establish even an empty scope.
  // Keep a valid requested interval, with no invented provider collection time.
  const base={...mapping,from,to,collected_at:covered?source.collected_at:null};
  try{
   checkBudget();if(!source||!covered)throw Error('CLOBE_PLAN_COLLECTION');
   let cursor:string|undefined,total:number|null|undefined,read=0;const cursors=new Set<string>(),seen=new Map<string,string>(),outflows=new Map<string,ClobePlanActualRow>(),financial=new Map<string,string>();
   for(let index=0;;index++){
    checkBudget();if(index>=CLOBE_PLAN_MAX_PAGES)throw Error('CLOBE_PLAN_LIMIT');
    const page=await deps.readPage({companyId:mapping.company_id,bankAccountId:Number(mapping.external_account_id),startDate:from,endDate:to,size:100,...(cursor?{cursor}:{})},source.collected_at);
    checkBudget();if(page.companyId!==mapping.company_id||String(page.bankAccountId)!==mapping.external_account_id||page.startDate!==from||page.endDate!==to||page.scraping.status!=='SUCCESS'||page.scraping.error||page.scraping.lastCollectedAt!==source.collected_at)throw Error('CLOBE_PLAN_CHANGED');
    if(total===undefined)total=page.totalElements;else if(total!==page.totalElements)throw Error('CLOBE_PLAN_PAGINATION');
    read+=page.rows.length;totalRead+=page.rows.length;if(read>CLOBE_PLAN_MAX_ROWS||totalRead>6000)throw Error('CLOBE_PLAN_LIMIT');
    const details=new Map(page.sourceRows.map(row=>[row.external_transaction_id,row]));
    for(const row of page.rows){
     if(!/^[1-9]\d{0,15}$/.test(row.id)||!validClobeDate(row.date)||row.date<from||row.date>to||row.currency!=='KRW'||!Number.isSafeInteger(row.amount)||row.amount<=0||(row.balance!==null&&!Number.isSafeInteger(row.balance))||clobeCollectedInstant(`${row.date}T${row.time}`)===null)throw Error('CLOBE_PLAN_SOURCE_INVALID');
     const instant=clobeCollectedInstant(`${row.date}T${row.time}`)!;if(instant>clobeCollectedInstant(source.collected_at)!)throw Error('CLOBE_PLAN_SOURCE_INVALID');
     const value=JSON.stringify(row),previous=seen.get(row.id);if(previous!==undefined){if(previous!==value)throw Error('CLOBE_PLAN_ID_CONFLICT');continue;}seen.set(row.id,value);
     if(row.direction==='out'){
      const actual=details.get(row.id);if(!actual)throw Error('CLOBE_PLAN_SOURCE_INVALID');
      const fp=signature(actual),same=financial.get(fp);if(same&&same!==row.id)throw Error('CLOBE_PLAN_FINANCIAL_CONFLICT');financial.set(fp,row.id);outflows.set(row.id,actual);
     }
    }
    if(!page.hasNext){if(page.nextCursor!==null||total!==null&&total!==undefined&&total!==seen.size)throw Error('CLOBE_PLAN_PAGINATION');break;}
    if(!page.nextCursor||page.nextCursor===cursor||cursors.has(page.nextCursor)||page.rows.length===0)throw Error('CLOBE_PLAN_PAGINATION');cursors.add(page.nextCursor);cursor=page.nextCursor;
   }
   checkBudget();const status=await deps.readStatus(mapping.company_id);checkBudget();
   if(status.status!=='SUCCESS'||status.error||status.lastCollectedAt!==source.collected_at)throw Error('CLOBE_PLAN_CHANGED');
   const rows=[...outflows.values()].sort((a,b)=>a.txn_date.localeCompare(b.txn_date)||a.txn_time.localeCompare(b.txn_time)||a.external_transaction_id.localeCompare(b.external_transaction_id));
   fetched_outflows+=rows.length;scopes.push({...base,status:'complete',reason:null,rows});
  }catch(cause){
   const code=cause instanceof Error?cause.message:'',message=code==='CLOBE_PLAN_TIMEOUT'?'조회 시간이 초과되어 이전 은행 출금 증거를 유지했습니다.':code==='CLOBE_PLAN_CHANGED'?'은행 수집 상태나 시각이 바뀌어 이전 출금 증거를 유지했습니다.':/CONFLICT/.test(code)?'은행 거래 식별자나 동일 거래 원본이 충돌해 이전 출금 증거를 유지했습니다.':code==='CLOBE_PLAN_LIMIT'?'월 거래 조회 상한을 초과해 이전 출금 증거를 유지했습니다.':'은행 월 전체 거래를 확인하지 못해 이전 출금 증거를 유지했습니다.';
   const reason=`${month} · ${message}`;
   scopes.push({...base,status:'confirmation-needed',reason,rows:[]});skipped.push({account_id:mapping.account_id,reason});
  }
 };
 // MCP transport is shared; cap upstream concurrency at two monthly queries.
 const queries=mappings.flatMap(mapping=>range.months.map(month=>({mapping,month})));
 for(let offset=0;offset<queries.length;offset+=2)await Promise.all(queries.slice(offset,offset+2).map(({mapping,month})=>query(mapping,month)));
 // A stable provider ID cannot describe different records in two months.
 // Hold both affected scopes rather than save one side of a changed identity.
 const claims=new Map<string,ClobePlanActualScope[]>();
 for(const scope of scopes)for(const row of scope.rows){
  const key=JSON.stringify([scope.account_id,row.external_transaction_id]),previous=claims.get(key)??[];
  previous.push(scope);claims.set(key,previous);
 }
 for(const scope of new Set([...claims.values()].filter(group=>group.length>1).flat())){
  const reason=`${scope.from.slice(0,7)} · 은행 거래 식별자가 여러 월의 원본에 중복되어 이전 출금 증거를 유지했습니다.`;
  fetched_outflows-=scope.rows.length;scope.status='confirmation-needed';scope.reason=reason;scope.rows=[];
  skipped.push({account_id:scope.account_id,reason});
 }
 try{
  const saved=await deps.save(scopes),combined=new Map([...skipped,...saved.skipped].map(item=>[item.account_id??item.reason,item]));
  return {...saved,fetched_outflows,skipped:[...combined.values()],complete:mappings.length>0&&skipped.length===0&&saved.skipped.length===0};
 }catch(cause){
  if(cause instanceof Error&&cause.message==='ADMIN_REQUIRED')throw cause;
  return {synced_accounts:0,unchanged_accounts:0,saved_outflows:0,fetched_outflows,complete:false,skipped:[...skipped,{reason:'잔액은 저장했지만 계획용 은행 출금 증거를 저장하지 못했습니다. 기존 계획과 이전 출금 증거는 유지했습니다.'}]};
 }
}
