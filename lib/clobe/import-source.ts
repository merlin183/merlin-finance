import {z} from 'zod';
import {ClobeReadError,type ClobeReadSession} from './mcp';
import {parseClobeTransactionPage,parseClobeScraping,readClobeAccounts} from './read';
import {CLOBE_IMPORT_LIMIT,type ClobeImportRow,type ClobeImportScope} from '../finance/clobe-import';
import {normalizeSourceDetails} from '../finance/source-details';
import {ClobeImportError} from './import-security';
import {clobeCollectedInstant} from './balance-sync';
import type {ClobeAccountsResponse} from './types';
import type {ClobeSyncAccountScope,ClobeSyncSkip,ClobeSyncSource} from './import-types';
import {ClobeSyncSourceError} from './import-sync-error';

const originalPage=z.object({content:z.array(z.object({transactionId:z.number().int().positive().safe(),transactionName:z.string().max(1000),transactionDescription:z.string().max(1000),businessEntityName:z.string().max(1000).nullish(),memo:z.string().max(1000).nullish(),category:z.string().max(500).nullish()})).max(100)});
const accessCompanies=z.object({companies:z.array(z.object({companyId:z.string().min(1).max(200)})).max(100)});
const accessAccounts=z.object({accounts:z.array(z.object({bankAccountId:z.number().int().positive().safe(),currencyCode:z.string().regex(/^[A-Z]{3}$/)})).max(200)});
/** Applying a frozen source requires current access, without re-downloading or
 * letting changed provider categories replace the user's reviewed choices. */
export async function verifyClobeImportAccess(session:ClobeReadSession,scope:ClobeImportScope){
 const context=accessCompanies.safeParse(await session.call('get_my_context'));
 if(!context.success)throw new ClobeReadError('invalid_response');
 const companies=[...new Set(scope.mappings.map(m=>m.company_id))];
 if(companies.some(id=>!context.data.companies.some(c=>c.companyId===id)))throw new ClobeImportError('stale','Clobe 회사 접근 권한이 변경되었습니다. 거래를 다시 불러와주세요.');
 for(let i=0;i<companies.length;i+=4){
  await Promise.all(companies.slice(i,i+4).map(async companyId=>{
   const response=accessAccounts.safeParse(await session.call('get_bank_accounts',{companyId}));
   if(!response.success)throw new ClobeReadError('invalid_response');
   for(const mapping of scope.mappings.filter(m=>m.company_id===companyId)){
    const account=response.data.accounts.find(a=>String(a.bankAccountId)===mapping.external_account_id);
    if(!account||account.currencyCode!=='KRW')throw new ClobeImportError('stale','Clobe 통장 접근 권한이나 통화가 변경되었습니다. 거래를 다시 불러와주세요.');
   }
  }));
 }
}
/** Exhaust every selected account before returning any importable snapshot. */
export async function fetchClobeImportRows(session:ClobeReadSession,scope:ClobeImportScope,signal?:AbortSignal,now:()=>number=Date.now,automatic?:{accounts:ClobeAccountsResponse;collections:ClobeSyncAccountScope[];started:number}){
 const started=automatic?.started??now(),accounts=automatic?.accounts??await readClobeAccounts(session,now),rows:ClobeImportRow[]=[];
 for(const mapping of scope.mappings){
  const company=accounts.companies.find(c=>c.id===mapping.company_id);
  if(!company||company.error)throw new ClobeReadError(company?'request_failed':'forbidden');
  const account=company.accounts.find(a=>String(a.id)===mapping.external_account_id);
  if(!account)throw new ClobeReadError('forbidden');
  if(account.currency!=='KRW')throw new ClobeReadError('unsupported_currency');
  let endDate=scope.end_date,sourceInstant:number|null=null;
  if(automatic){
   const source=company.scraping.lastCollectedAt;
   sourceInstant=source?clobeCollectedInstant(source):null;
   if(company.scraping.status!=='SUCCESS'||company.scraping.error||sourceInstant===null||sourceInstant>now()+300000)throw new ClobeImportError('incomplete','은행 수집이 완료되지 않아 이 월의 거래는 저장하지 않았습니다. Clobe 수집 상태를 확인해주세요.');
   endDate=source!.slice(0,10)<endDate?source!.slice(0,10):endDate;
   if(endDate<scope.start_date)throw new ClobeImportError('incomplete','이 월의 은행 수집 자료가 아직 없어 거래를 저장하지 않았습니다.');
   automatic.collections.push({account_id:mapping.account_id,from:scope.start_date,to:endDate,collected_at:source!});
  }
  let cursor:string|undefined;const seenCursors=new Set<string>(),seenRows=new Set<string>();let pages=0,expectedTotal:number|null=null;
  while(true){
   if(signal?.aborted||now()-started>45000)throw new ClobeImportError('incomplete');
   if(++pages>201)throw new ClobeImportError('too_large');
   const input={companyId:company.id,bankAccountId:account.id,startDate:scope.start_date,endDate,size:100,...(cursor?{cursor}:{})};
   const raw=await session.call('get_labeled_transactions',{companyId:company.id,accountId:account.id,startDate:scope.start_date,endDate,size:100,...(cursor?{cursor}:{})});
   if(signal?.aborted||now()-started>45000)throw new ClobeImportError('incomplete');
   const page=parseClobeTransactionPage(raw,input,'KRW',company.scraping,now),original=originalPage.safeParse(raw);
   if(page.totalElements!==null){
    if(expectedTotal!==null&&expectedTotal!==page.totalElements)throw new ClobeImportError('incomplete');
    expectedTotal=page.totalElements;if(expectedTotal>CLOBE_IMPORT_LIMIT)throw new ClobeImportError('too_large');
   }
   if(!original.success)throw new ClobeReadError('invalid_response');
   const originalById=new Map(original.data.content.map(row=>[String(row.transactionId),row]));
   for(const row of page.rows){
    if(automatic){
     const instant=clobeCollectedInstant(`${row.date}T${row.time}`);
     if(!Number.isSafeInteger(row.amount)||!Number.isSafeInteger(row.balance??0)||instant===null||instant>sourceInstant!)throw new ClobeReadError('invalid_response');
    }
    // Repeated IDs across pages indicate an unstable/corrupt cursor traversal;
    // never silently omit records and call that a complete import.
    if(seenRows.has(row.id))throw new ClobeImportError('incomplete');seenRows.add(row.id);
    const source=originalById.get(row.id);if(!source)throw new ClobeReadError('invalid_response');
    rows.push({company_id:company.id,external_account_id:String(account.id),external_transaction_id:row.id,account_id:mapping.account_id,currency:'KRW',txn_date:row.date,txn_time:row.time,amount:row.amount,direction:row.direction,balance:row.balance,description:row.description,raw_gwamok:'',source_details:normalizeSourceDetails({basic:source.transactionName,detail:source.transactionDescription,counterparty:source.businessEntityName,memo:source.memo,note:source.category?`Clobe 원본 분류(표시용): ${source.category}`:undefined})});
    if(rows.length>CLOBE_IMPORT_LIMIT)throw new ClobeImportError('too_large');
   }
   if(expectedTotal!==null&&seenRows.size>expectedTotal)throw new ClobeImportError('incomplete');
   if(!page.hasNext){if(expectedTotal!==null&&seenRows.size!==expectedTotal)throw new ClobeImportError('incomplete');break;}
   if(!page.nextCursor||seenCursors.has(page.nextCursor))throw new ClobeImportError('incomplete');
   seenCursors.add(page.nextCursor);cursor=page.nextCursor;
  }
 }
 return rows;
}

/** Strict automatic source collection is separate from the manually reviewed
 * import path. No partial account/month rows escape when a page/source fails. */
export async function fetchClobeSyncRows(session:ClobeReadSession,scope:ClobeImportScope,signal?:AbortSignal,now:()=>number=Date.now):Promise<ClobeSyncSource>{
 const started=now(),queryDeadline=started+32000,finalDeadline=started+43000;
 const bounded=(deadline:number):ClobeReadSession=>({close:async()=>{},call:async(tool,input,options)=>{
  if(signal?.aborted||now()>=deadline)throw new ClobeReadError('timeout');
  const deadlineSignal=AbortSignal.timeout(Math.max(1,deadline-now())),callSignal=AbortSignal.any([deadlineSignal,...(signal?[signal]:[]),...(options?.signal?[options.signal]:[])]);
  const value=await session.call(tool,input,{signal:callSignal});
  if(callSignal.aborted||now()>=deadline)throw new ClobeReadError('timeout');
  return value;
 }});
 // A failed global context/authentication prevents all preparation. Company
 // bank errors remain per-account diagnostics in this confirmed context.
 const accounts=await readClobeAccounts(bounded(queryDeadline),now),skipped=new Map<string,ClobeSyncSkip>();
 const complete=new Map<string,{rows:ClobeImportRow[];collection:ClobeSyncAccountScope;company_id:string}>();
 const skip=(account_id:string,code:ClobeSyncSkip['code'])=>{
  const reason={collection:'은행 수집이 완료되지 않아 이 통장의 해당 월 거래는 저장하지 않았습니다.',access:'확인된 회사·통장 접근 정보를 조회하지 못해 해당 월 거래는 저장하지 않았습니다.',currency:'원화로 확인되지 않은 통장은 거래 동기화에서 제외했습니다.',pagination:'월 전체 페이지·총건수를 검증하지 못해 이 통장의 해당 월 거래를 저장하지 않았습니다.',timeout:'조회 시간이 초과되어 이 통장의 해당 월 거래는 저장하지 않았습니다.',source:'은행 원본이나 수집 시각이 달라 이 통장의 해당 월 거래는 저장하지 않았습니다.'}[code];
  complete.delete(account_id);skipped.set(account_id,{account_id,code,reason});
 };
 const eligible=scope.mappings.filter(mapping=>{
  const company=accounts.companies.find(c=>c.id===mapping.company_id),account=company?.accounts.find(a=>String(a.id)===mapping.external_account_id),source=company?.scraping.lastCollectedAt;
  const instant=source?clobeCollectedInstant(source):null;
  if(!company||company.error||!account){skip(mapping.account_id,'access');return false;}
  if(account.currency!=='KRW'){skip(mapping.account_id,'currency');return false;}
  if(company.scraping.status!=='SUCCESS'||company.scraping.error||instant===null||instant>now()+300000||source!.slice(0,10)<scope.start_date){skip(mapping.account_id,'collection');return false;}
  return true;
 });
 let next=0;
 const worker=async()=>{
  while(next<eligible.length){
   const mapping=eligible[next++],collections:ClobeSyncAccountScope[]=[];
   try{
    const localDeadline=Math.min(queryDeadline,now()+20000);
    const rows=await fetchClobeImportRows(bounded(localDeadline),{...scope,mappings:[mapping]},signal,now,{accounts,collections,started});
    if(signal?.aborted||now()>=queryDeadline||collections.length!==1)throw new ClobeReadError('timeout');
    complete.set(mapping.account_id,{rows,collection:collections[0],company_id:mapping.company_id});
   }catch(cause){
    const code=cause instanceof ClobeReadError&&cause.code==='timeout'?'timeout':cause instanceof ClobeReadError&&cause.code==='forbidden'?'access':cause instanceof ClobeReadError&&cause.code==='unsupported_currency'?'currency':cause instanceof ClobeImportError&&['incomplete','too_large'].includes(cause.code)?'pagination':'source';
    skip(mapping.account_id,code);
   }
  }
 };
 // Dynamic workers keep a slow account from blocking a healthy account batch.
 await Promise.all(Array.from({length:Math.min(2,eligible.length)},worker));
 const companies=[...new Set([...complete.values()].map(value=>value.company_id))];next=0;
 const verifyWorker=async()=>{
  while(next<companies.length){
   const companyId=companies[next++];
   try{
    const status=parseClobeScraping(await bounded(finalDeadline).call('get_scraping_status',{companyId}));
    if(status.status!=='SUCCESS'||status.error||status.lastCollectedAt!==accounts.companies.find(c=>c.id===companyId)!.scraping.lastCollectedAt)throw new ClobeImportError('incomplete');
   }catch(cause){
    for(const mapping of scope.mappings.filter(m=>m.company_id===companyId))skip(mapping.account_id,cause instanceof ClobeReadError&&cause.code==='timeout'?'timeout':'source');
   }
  }
 };
 await Promise.all(Array.from({length:Math.min(2,companies.length)},verifyWorker));
 const rows:ClobeImportRow[]=[],collections:ClobeSyncAccountScope[]=[];
 for(const mapping of scope.mappings){
  const account=complete.get(mapping.account_id);if(!account)continue;
  if(rows.length+account.rows.length>CLOBE_IMPORT_LIMIT){skip(mapping.account_id,'pagination');continue;}
  rows.push(...account.rows);collections.push(account.collection);
 }
 if(!collections.length)throw new ClobeSyncSourceError([...skipped.values()],scope.mappings.length);
 return {rows,accounts:collections,skipped:[...skipped.values()]};
}
export async function verifyClobeSyncSource(session:ClobeReadSession,scope:ClobeImportScope,collections:ClobeSyncAccountScope[],now:()=>number=Date.now){
 await verifyClobeImportAccess(session,scope);
 if(collections.length!==scope.mappings.length||new Set(collections.map(c=>c.account_id)).size!==scope.mappings.length)throw new ClobeImportError('invalid_request');
 for(const companyId of new Set(scope.mappings.map(m=>m.company_id))){
  const status=parseClobeScraping(await session.call('get_scraping_status',{companyId}));
  const source=status.lastCollectedAt,instant=source?clobeCollectedInstant(source):null;
  if(status.status!=='SUCCESS'||status.error||instant===null||instant>now()+300000||scope.mappings.filter(m=>m.company_id===companyId).some(m=>collections.find(c=>c.account_id===m.account_id)?.collected_at!==source))throw new ClobeImportError('stale','은행 수집 자료가 변경되었습니다. 해당 월을 다시 동기화해주세요.');
 }
}
