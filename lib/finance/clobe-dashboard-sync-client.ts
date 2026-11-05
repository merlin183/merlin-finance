import type {ClobeSyncApplied,ClobeSyncPrepared} from '../clobe/import-types';
import type {ClobeBalanceSyncResult} from '../clobe/balance-sync';
import type {ClobeImportSummary} from './clobe-import';
import {publishDatasetChange} from './dataset-change-signal';
import {parseFinanceDate} from './date-range';
import {clobeSyncRange} from './clobe-sync-range';

export type ClobeDashboardSyncBalance=Omit<ClobeBalanceSyncResult,'accounts'>;
export type ClobeDashboardSyncFailure={month:string;stage:'prepare'|'apply';message:string;uncertain:boolean;code:'authentication'|'mapping'|'collection'|'scope'|'conflict'|'request'|'unknown-result'};
export type ClobeDashboardSyncAccountFailureCode='collection'|'access'|'currency'|'pagination'|'timeout'|'source';
export type ClobeDashboardSyncAccountFailure={month:string;account_id:string;code:ClobeDashboardSyncAccountFailureCode;reason:string};
export type ClobeDashboardSyncMonthScope={month:string;configuredAccounts:number;verifiedAccounts:number};
export type ClobeDashboardSyncCompletion={
 scope:{from:string;to:string};ledger:ClobeImportSummary&{unclassified:number};
 completedMonths:number;totalMonths:number;failures:ClobeDashboardSyncFailure[];recoveredMonths:string[];
 accountFailures:ClobeDashboardSyncAccountFailure[];monthScopes:ClobeDashboardSyncMonthScope[];
 sourceThrough:{earliest:string|null;latest:string|null};
 balanceResult:ClobeDashboardSyncBalance|null;balanceError:string|null;
 refreshed:boolean;refreshError:string|null;fullSuccess:boolean;
};
export type ClobeDashboardSyncSnapshot={
 phase:'idle'|'preparing'|'applying'|'balances'|'refreshing'|'done'|'refresh-needed';
 month:string|null;completedMonths:number;totalMonths:number;
 result:ClobeDashboardSyncCompletion|null;error:string|null;
};
type SyncOptions={actorKey:string;refresh:()=>Promise<void>};
type Dependencies={requestFetch?:typeof fetch;now?:()=>number;notify?:()=>void;requestTimeoutMs?:number;wait?:(milliseconds:number)=>Promise<void>};
type AccountScope={configuredAccounts:number;verifiedAccounts:number;skipped:Omit<ClobeDashboardSyncAccountFailure,'month'>[]};
type PendingApply={month:string;previewId:string;unclassified:number;accountScope:AccountScope};
const idleSnapshot:ClobeDashboardSyncSnapshot={phase:'idle',month:null,completedMonths:0,totalMonths:0,result:null,error:null};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const emptySummary=():ClobeImportSummary=>({inserted:0,referenced:0,unchanged:0,sourceDuplicates:0,blocked:0,updated:0,removed:0});
const validSummary=(value:unknown):value is ClobeImportSummary=>object(value)&&['inserted','referenced','unchanged','sourceDuplicates','blocked'].every(key=>count(value[key]))&&value.updated===0&&value.removed===0;
const skipReasons:Record<ClobeDashboardSyncAccountFailureCode,string>={
 collection:'은행 자료 수집이 완료되지 않아 이 통장은 저장하지 않았습니다.',
 access:'Clobe 사업자·통장 접근 권한을 확인해주세요.',
 currency:'원화 통장이 아니어서 거래를 저장하지 않았습니다.',
 pagination:'거래 전체 페이지를 확인하지 못해 이 통장은 저장하지 않았습니다.',
 timeout:'조회 제한 시간 안에 거래를 확인하지 못해 이 통장은 저장하지 않았습니다.',
 source:'은행 원본 자료가 바뀌었거나 확인되지 않아 이 통장은 저장하지 않았습니다.',
};
function accountScope(value:unknown,activeIds:ReadonlySet<string>,errorResponse=false):AccountScope|null{
 if(!object(value))return null;
 const source=errorResponse?value:value.scope;if(!object(source))return null;
 const configured=source.configured_account_count??(errorResponse?undefined:activeIds.size),skipped=value.skipped??[];
 if(!count(configured)||configured<1||configured>100||!Array.isArray(skipped)||activeIds.size+skipped.length!==configured)return null;
 const ids=new Set(activeIds),safe:AccountScope['skipped']=[];
 for(const item of skipped){
  if(!object(item)||typeof item.account_id!=='string'||!uuid.test(item.account_id)||ids.has(item.account_id)||typeof item.code!=='string'||!Object.hasOwn(skipReasons,item.code)||typeof item.reason!=='string')return null;
  const code=item.code as ClobeDashboardSyncAccountFailureCode;ids.add(item.account_id);safe.push({account_id:item.account_id,code,reason:skipReasons[code]});
 }
 return {configuredAccounts:configured,verifiedAccounts:activeIds.size,skipped:safe};
}

/** The server and browser share the same two-month automatic query window. */
export function clobeDashboardSyncMonths(instant=Date.now()){
 return clobeSyncRange(instant);
}

class SyncRequestError extends Error{
 constructor(readonly status:number|null,readonly uncertain:boolean,readonly code:ClobeDashboardSyncFailure['code'],message:string,readonly accountScope?:AccountScope){super(message);}
}
class SyncSessionChangedError extends Error{constructor(){super('로그인 계정이 변경되어 동기화를 중단했습니다.');}}
function requestError(status:number|null,value:unknown,applying:boolean){
 const source=object(value)&&typeof value.error==='string'?value.error:'';
 const uncertain=applying&&(status===null||status>=500||status===408);
 const scope=!applying?accountScope(value,new Set(),true)??undefined:undefined;
 if(status===401||status===403)return new SyncRequestError(status,false,'authentication','대시보드·Clobe 접근 권한을 확인해주세요.',scope);
 if(/통장 연결|계좌 연결|매핑|mapping/i.test(source))return new SyncRequestError(status,uncertain,'mapping','저장된 Clobe 통장 연결을 확인해주세요.',scope);
 if(/은행 수집|수집 상태|수집 자료/i.test(source))return new SyncRequestError(status,uncertain,'collection','Clobe 은행 자료 수집 상태를 확인해주세요.',scope);
 if(/기간|조회 범위/.test(source))return new SyncRequestError(status,uncertain,'scope','은행 거래 조회 기간을 확인해주세요.',scope);
 if(status===409)return new SyncRequestError(status,false,'conflict','자료나 계좌 연결이 변경되어 해당 월을 다시 확인해야 합니다.',scope);
 return new SyncRequestError(status,uncertain,uncertain?'unknown-result':'request',uncertain?'저장 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해야 합니다.':applying?'해당 월 거래를 저장하지 못했습니다.':'해당 월 은행 거래 조회를 완료하지 못했습니다.',scope);
}

function preparedResponse(value:unknown,month:string,to:string):ClobeSyncPrepared{
 if(!object(value)||typeof value.previewId!=='string'||!uuid.test(value.previewId)||typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt))||value.month!==month||!validSummary(value.summary)||!count(value.unclassified)||value.unclassified>value.summary.inserted||!object(value.scope)||!Array.isArray(value.conflicts))throw requestError(null,null,false);
 const scope=value.scope,last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10),end=last<to?last:to;
 if(scope.start_date!==`${month}-01`||scope.end_date!==end||!count(scope.account_count)||scope.account_count<1||scope.account_count>100||!count(scope.business_count)||scope.business_count<1||scope.business_count>scope.account_count||!Array.isArray(scope.accounts)||scope.accounts.length!==scope.account_count)throw requestError(null,null,false);
 const ids=new Set<string>();
 for(const account of scope.accounts){
  if(!object(account)||typeof account.account_id!=='string'||!uuid.test(account.account_id)||ids.has(account.account_id)||account.from!==scope.start_date||typeof account.to!=='string'||!parseFinanceDate(account.to)||account.to<scope.start_date||account.to>end||typeof account.collected_at!=='string'||!Number.isFinite(Date.parse(account.collected_at))||account.collected_at.slice(0,10)<account.to)throw requestError(null,null,false);
  ids.add(account.account_id);
 }
 if(!accountScope(value,ids))throw requestError(null,null,false);
 return value as ClobeSyncPrepared;
}
function appliedResponse(value:unknown,pending:PendingApply):ClobeSyncApplied{
 if(!object(value))throw requestError(null,null,true);
 const {run_id,unclassified,replayed}=value;
 if(!validSummary(value)||run_id!==pending.previewId||unclassified!==null&&(!count(unclassified)||unclassified>value.inserted)||replayed!==undefined&&typeof replayed!=='boolean')throw requestError(null,null,true);
 return value as ClobeSyncApplied;
}
function safeSkip(value:unknown){
 if(!object(value)||typeof value.reason!=='string'||value.account_id!==undefined&&typeof value.account_id!=='string')throw requestError(null,null,false);
 const reason=/외화/.test(value.reason)?'외화 통장은 원화 계산에서 제외했습니다.':/시각|미래/.test(value.reason)?'은행 자료 수집 시각을 확인해주세요.':/연결|통장|계좌/.test(value.reason)?'해당 통장의 연결·은행 수집 상태를 확인해주세요.':'일부 은행 자료를 확인하지 못했습니다.';
 return {...(typeof value.account_id==='string'?{account_id:value.account_id}:{}),reason};
}
function balanceResponse(value:unknown):ClobeDashboardSyncBalance{
 if(!object(value)||!count(value.synced)||!count(value.unchanged)||!Array.isArray(value.skipped))throw requestError(null,null,false);
 const result:ClobeDashboardSyncBalance={synced:value.synced,unchanged:value.unchanged,skipped:value.skipped.map(safeSkip)};
 if(value.plan_actuals!==undefined){
  const actuals=value.plan_actuals;
  if(!object(actuals)||!['synced_accounts','unchanged_accounts','saved_outflows','fetched_outflows'].every(key=>count(actuals[key]))||typeof actuals.complete!=='boolean'||!Array.isArray(actuals.skipped))throw requestError(null,null,false);
  result.plan_actuals={synced_accounts:actuals.synced_accounts as number,unchanged_accounts:actuals.unchanged_accounts as number,saved_outflows:actuals.saved_outflows as number,fetched_outflows:actuals.fetched_outflows as number,complete:actuals.complete,skipped:actuals.skipped.map(safeSkip)};
 }
 return result;
}
function complete(result:ClobeDashboardSyncCompletion){
 const balance=result.balanceResult;
 return result.refreshed&&!result.failures.length&&!result.accountFailures.length&&!result.ledger.blocked&&!result.balanceError&&!!balance&&balance.synced+balance.unchanged>0&&!balance.skipped.length&&!!balance.plan_actuals?.complete&&!balance.plan_actuals.skipped.length;
}

/** One document-wide run survives view unmounts. Only counts and opaque pending
 * preview IDs are retained; bank rows, company names and credentials are not. */
export function createClobeDashboardSyncCoordinator(deps:Dependencies={}){
 const requestFetch=deps.requestFetch??fetch,now=deps.now??Date.now,notify=deps.notify??publishDatasetChange;
 const wait=deps.wait??((milliseconds:number)=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds)));
 let actorKey:string|null=null,generation=0,snapshot=idleSnapshot,inFlight:Promise<ClobeDashboardSyncCompletion>|null=null;
 const listeners=new Set<()=>void>(),pendingApplies=new Map<string,PendingApply>();
 const publish=(next:ClobeDashboardSyncSnapshot)=>{snapshot=next;for(const listener of listeners){try{listener();}catch{/* Subscribers cannot cancel committed saves. */}}};
 const current=(key:string,version:number)=>actorKey===key&&generation===version;
 const check=(key:string,version:number)=>{if(!current(key,version))throw new SyncSessionChangedError();};
 function reset(){generation++;actorKey=null;inFlight=null;pendingApplies.clear();publish(idleSnapshot);}
 function selectActor(key:string){
  if(!key.trim())throw Error('로그인 계정을 확인해주세요.');
  if(actorKey!==key){reset();actorKey=key;}
 }
 async function request(path:string,body:Record<string,string>,key:string,version:number,applying=false){
  check(key,version);let response:Response;
  try{response=await requestFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(deps.requestTimeoutMs??65000)});}catch{check(key,version);throw requestError(null,null,applying);}
  check(key,version);let value:unknown;
  try{value=await response.json();}catch{throw requestError(response.ok?null:response.status,null,applying);}
  check(key,version);
  if(!response.ok){
   if(response.status===401&&typeof window!=='undefined')window.dispatchEvent(new Event('finance-auth-invalid'));
   check(key,version);throw requestError(response.status,value,applying);
  }
  return value;
 }
 async function apply(pending:PendingApply,key:string,version:number){
  for(let attempt=0;attempt<2;attempt++){
   try{return appliedResponse(await request('/api/clobe/import',{action:'sync_apply',previewId:pending.previewId},key,version,true),pending);}
   catch(error){if(error instanceof SyncSessionChangedError)throw error;if(!(error instanceof SyncRequestError)||!error.uncertain||attempt===1)throw error;}
  }
  throw requestError(null,null,true);
 }
 async function refreshResult(result:ClobeDashboardSyncCompletion,options:SyncOptions,version:number){
  check(options.actorKey,version);publish({...snapshot,phase:'refreshing',month:null,result,error:null});
  try{
   for(let attempt=0;attempt<2;attempt++){
    check(options.actorKey,version);
    try{await options.refresh();check(options.actorKey,version);result={...result,refreshed:true,refreshError:null};break;}
    catch(error){
     check(options.actorKey,version);if(error instanceof SyncSessionChangedError)throw error;
     result={...result,refreshed:false,refreshError:'저장된 자료를 화면에 다시 불러오지 못했습니다. 화면 조회만 다시 시도해주세요.'};
     if(attempt===0){
      try{await wait(2000);}catch{check(options.actorKey,version);break;}
      check(options.actorKey,version);
     }
    }
   }
  }finally{
   // Read this document first so unsupported browsers do not immediately fan
   // out competing dataset RPCs. Each completed read attempt series signals once.
   if(current(options.actorKey,version)){try{notify();}catch{/* Direct read already completed. */}}
  }
  result={...result,fullSuccess:complete(result)};
  publish({...snapshot,phase:result.refreshed?'done':'refresh-needed',month:null,result,error:result.refreshError});return result;
 }
 async function run(options:SyncOptions,version:number){
  const range=clobeDashboardSyncMonths(now()),result:ClobeDashboardSyncCompletion={scope:{from:range.from,to:range.to},ledger:{...emptySummary(),unclassified:0},completedMonths:0,totalMonths:range.months.length,failures:[],recoveredMonths:[],accountFailures:[],monthScopes:[],sourceThrough:{earliest:null,latest:null},balanceResult:null,balanceError:null,refreshed:false,refreshError:null,fullSuccess:false};
  const scopeCounts=new Map<string,Pick<ClobeImportSummary,'unchanged'|'sourceDuplicates'|'blocked'>>();
  const accountScopes=new Map<string,AccountScope>();
  const recordScope=(month:string,scope:AccountScope)=>{
   accountScopes.set(month,scope);
   result.monthScopes=[...accountScopes].map(([month,item])=>({month,configuredAccounts:item.configuredAccounts,verifiedAccounts:item.verifiedAccounts}));
   result.accountFailures=[...accountScopes].flatMap(([month,item])=>item.skipped.map(skip=>({month,...skip})));
  };
  const add=(applied:ClobeSyncApplied,pending:PendingApply)=>{
   recordScope(pending.month,pending.accountScope);
   for(const field of ['inserted','referenced'] as const)result.ledger[field]+=applied[field];
   result.ledger.unclassified+=applied.unclassified??pending.unclassified;
   // Saved changes accumulate, but these counts describe a month-wide source
   // snapshot. A fresh success replaces its recovered snapshot exactly once.
   const previous=scopeCounts.get(pending.month);
   for(const field of ['unchanged','sourceDuplicates','blocked'] as const)result.ledger[field]+=applied[field]-(previous?.[field]??0);
   scopeCounts.set(pending.month,{unchanged:applied.unchanged,sourceDuplicates:applied.sourceDuplicates,blocked:applied.blocked});
  };
  const failed=(month:string,stage:'prepare'|'apply',error:unknown)=>{
   if(error instanceof SyncSessionChangedError)throw error;
   const value=error instanceof SyncRequestError?error:requestError(null,null,stage==='apply');
   if(stage==='prepare'&&value.accountScope)recordScope(month,value.accountScope);
   result.failures.push({month,stage,message:value.message,uncertain:value.uncertain,code:value.code});
  };
  // An ambiguous reply may have committed. Recover its original opaque request
  // first; never create a replacement preview while that result is unknown.
  const unresolved=new Set<string>();
  for(const pending of [...pendingApplies.values()]){
   check(options.actorKey,version);publish({phase:'applying',month:pending.month,completedMonths:0,totalMonths:range.months.length,result:null,error:null});
   try{add(await apply(pending,options.actorKey,version),pending);pendingApplies.delete(pending.month);result.recoveredMonths.push(pending.month);}
   catch(error){
    if(error instanceof SyncSessionChangedError)throw error;
    if(error instanceof SyncRequestError&&!error.uncertain){pendingApplies.delete(pending.month);continue;}
    failed(pending.month,'apply',error);unresolved.add(pending.month);
   }
  }
  for(const month of range.months){
   if(unresolved.has(month))continue;
   check(options.actorKey,version);publish({phase:'preparing',month,completedMonths:result.completedMonths,totalMonths:result.totalMonths,result:null,error:null});
   let prepared:ClobeSyncPrepared;
   try{prepared=preparedResponse(await request('/api/clobe/import',{action:'sync_prepare',month},options.actorKey,version),month,range.to);}
   catch(error){failed(month,'prepare',error);continue;}
   const verifiedScope=accountScope(prepared,new Set(prepared.scope.accounts.map(account=>account.account_id)))!;
   recordScope(month,verifiedScope);
   if(month===range.to.slice(0,7)){
    const dates=prepared.scope.accounts.map(account=>account.to).sort();result.sourceThrough={earliest:dates[0]??null,latest:dates.at(-1)??null};
   }
   const pending={month,previewId:prepared.previewId,unclassified:prepared.unclassified,accountScope:verifiedScope};
   publish({...snapshot,phase:'applying'});
   try{add(await apply(pending,options.actorKey,version),pending);result.completedMonths++;}
   catch(error){if(error instanceof SyncRequestError&&error.uncertain)pendingApplies.set(month,pending);failed(month,'apply',error);}
  }
  check(options.actorKey,version);publish({phase:'balances',month:null,completedMonths:result.completedMonths,totalMonths:result.totalMonths,result:null,error:null});
  // Ledger errors must not prevent independent current balance collection.
  try{result.balanceResult=balanceResponse(await request('/api/clobe/balance-sync',{},options.actorKey,version));}
  catch(error){if(error instanceof SyncSessionChangedError)throw error;result.balanceError='잔액·계획용 출금 조회를 완료하지 못했습니다. 화면에 저장된 자료를 다시 확인해주세요.';}
  return refreshResult(result,options,version);
 }
 return {
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  getSnapshot:()=>snapshot,getServerSnapshot:()=>idleSnapshot,reset,
  start(options:SyncOptions):Promise<ClobeDashboardSyncCompletion>|null{
   selectActor(options.actorKey);if(inFlight)return inFlight;if(snapshot.phase==='refresh-needed')return null;
   const version=generation;
   const totalMonths=clobeDashboardSyncMonths(now()).months.length;
   const task=Promise.resolve().then(()=>run(options,version)).finally(()=>{if(current(options.actorKey,version)&&inFlight===task)inFlight=null;});
   inFlight=task;publish({phase:'preparing',month:null,completedMonths:0,totalMonths,result:null,error:null});return task;
  },
  retryRefresh(options:SyncOptions):Promise<ClobeDashboardSyncCompletion>|null{
   selectActor(options.actorKey);if(inFlight)return inFlight;if(snapshot.phase!=='refresh-needed'||!snapshot.result)return null;
   const version=generation,result=snapshot.result;
   const task=Promise.resolve().then(()=>refreshResult(result,options,version)).finally(()=>{if(current(options.actorKey,version)&&inFlight===task)inFlight=null;});
   inFlight=task;return task;
  },
 };
}

export const clobeDashboardSyncCoordinator=createClobeDashboardSyncCoordinator();
