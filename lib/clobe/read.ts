import {z} from 'zod';
import {ClobeReadError,type ClobeReadSession} from './mcp';
import {ClobeAuthError} from './auth';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {ClobeAccountsResponse,ClobeBankAccount,ClobeScrapingStatus,ClobeTransactionsRequest,ClobeTransactionsResponse} from './types';

const text=z.string().max(4000);
const identifier=z.string().min(1).max(200);
const id=z.number().int().positive().safe();
const money=z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const optionalMoney=money.nullish();
const contextSchema=z.object({companies:z.array(z.object({companyId:identifier,companyName:text,role:text})).max(100)});
const accountSchema=z.object({bankAccountId:id,accountName:text,aliasName:text.nullish(),displayAccountNumber:z.string().max(200).nullish(),bankName:text.nullish(),currencyCode:z.string().regex(/^[A-Z]{3}$/),isHidden:z.boolean(),balance:optionalMoney,krwBalance:optionalMoney});
const accountsSchema=z.object({accounts:z.array(accountSchema).max(200)});
const scrapingSchema=z.object({overallStatus:text,assets:z.array(z.object({category:text,label:text,status:text,scrapedAt:text.nullish(),failureCategory:text.nullish(),failureMessage:text.nullish()})).max(500)});
const transactionSchema=z.object({transactionId:id,accountId:id,transactionAt:z.string().max(60),transactionName:text,transactionDescription:text,inAmount:money.nonnegative(),outAmount:money.nonnegative(),afterBalance:optionalMoney,businessEntityName:text.nullish(),category:text.nullish(),memo:text.nullish()});
const pageSchema=z.object({content:z.array(transactionSchema).max(100),hasNext:z.boolean(),nextCursor:z.string().min(1).max(4096).nullable(),totalElements:z.number().int().nonnegative().safe().nullish(),inAmountSumKrw:money.nonnegative().nullish(),outAmountSumKrw:money.nonnegative().nullish()});
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new ClobeReadError('invalid_response');return result.data;}

export function validClobeDate(value:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const [year,month,day]=value.split('-').map(Number);
 if(year<1900||year>2100||month<1||month>12||day<1)return false;
 const leap=year%4===0&&(year%100!==0||year%400===0);
 return day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
}
export const clobeTransactionsRequestSchema=z.object({companyId:identifier,bankAccountId:id,startDate:z.string().refine(validClobeDate),endDate:z.string().refine(validClobeDate),cursor:z.string().min(1).max(4096).optional(),size:z.number().int().min(1).max(100).optional()}).strict().refine(value=>value.startDate<=value.endDate);
export function parseClobeTransactionsRequest(value:unknown):ClobeTransactionsRequest{
 const result=clobeTransactionsRequestSchema.safeParse(value);if(!result.success)throw new ClobeReadError('invalid_request');return result.data;
}
export function maskClobeAccountNumber(displayNumber:string|null|undefined){
 const digits=(displayNumber||'').replace(/\D/g,'');
 return digits.length?'•••• '+digits.slice(-4):'번호 미제공';
}
function displayAccount(account:z.infer<typeof accountSchema>):ClobeBankAccount{
 return {id:account.bankAccountId,name:account.aliasName?.trim()||account.accountName,bankName:account.bankName?.trim()||null,maskedNumber:maskClobeAccountNumber(account.displayAccountNumber),currency:account.currencyCode,balance:account.balance??null,krwBalance:account.krwBalance??null,isHidden:account.isHidden};
}
const unknownScraping=(error:string|null=null):ClobeScrapingStatus=>({status:'UNKNOWN',lastCollectedAt:null,error});
export function parseClobeScraping(value:unknown):ClobeScrapingStatus{
 const source=parse(scrapingSchema,value);
 // Bank freshness must not be inferred from card/tax-invoice collection times.
 const assets=source.assets.filter(asset=>/^BANK(?:_ACCOUNTS?)?$/i.test(asset.category)||/은행|통장|bank\s*account/i.test(asset.label));
 if(!assets.length)return unknownScraping('은행 자료의 수집 시각을 확인하지 못했습니다.');
 const failed=assets.some(asset=>['ERROR','FAILED','FAILURE'].includes(asset.status.toUpperCase())||!!asset.failureCategory);
 const pending=assets.some(asset=>['IN_PROGRESS','PENDING','REQUESTED'].includes(asset.status.toUpperCase()));
 const success=assets.every(asset=>['SUCCESS','COMPLETED'].includes(asset.status.toUpperCase()));
 // Earliest collected bank asset is conservative when several bank connections exist.
 const timestamps=assets.map(asset=>asset.scrapedAt||null);
 const valid=timestamps.every(value=>value!==null&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value));
 return {status:failed?'ERROR':pending?'IN_PROGRESS':success?'SUCCESS':'UNKNOWN',lastCollectedAt:valid?(timestamps as string[]).sort()[0]:null,error:failed?'Clobe에서 은행 자료 수집 오류가 있습니다. Clobe 앱에서 연결 상태를 확인해주세요.':!success&&!pending?'은행 자료의 수집 상태를 확인해주세요.':null};
}
async function scraping(session:ClobeReadSession,companyId:string):Promise<ClobeScrapingStatus>{
 try{return parseClobeScraping(await session.call('get_scraping_status',{companyId}));}catch{return unknownScraping('은행 자료의 수집 상태를 조회하지 못했습니다.');}
}
async function companies(session:ClobeReadSession){
 const result=parse(contextSchema,await session.call('get_my_context'));
 if(new Set(result.companies.map(company=>company.companyId)).size!==result.companies.length)throw new ClobeReadError('invalid_response');
 return result.companies;
}
async function bankAccounts(session:ClobeReadSession,companyId:string){
 const result=parse(accountsSchema,await session.call('get_bank_accounts',{companyId}));
 if(new Set(result.accounts.map(account=>account.bankAccountId)).size!==result.accounts.length)throw new ClobeReadError('invalid_response');
 return result.accounts;
}
export async function readClobeAccounts(session:ClobeReadSession,now:()=>number=Date.now):Promise<ClobeAccountsResponse>{
 const context=await companies(session);
 const result:ClobeAccountsResponse['companies']=[];
 // Bound upstream concurrency and preserve context order, including partial failures.
 for(let i=0;i<context.length;i+=4){
  const batch=await Promise.all(context.slice(i,i+4).map(async company=>{
   const [accountsResult,status]=await Promise.all([bankAccounts(session,company.companyId).then(accounts=>({accounts,error:null as string|null})).catch(()=>({accounts:[],error:'Clobe 계좌 목록을 조회하지 못했습니다. 다시 조회해주세요.'})),scraping(session,company.companyId)]);
   return {id:company.companyId,name:company.companyName,role:company.role,accounts:accountsResult.accounts.map(displayAccount),scraping:status,error:accountsResult.error};
  }));result.push(...batch);
 }
 return {fetchedAt:new Date(now()).toISOString(),companies:result};
}
function sourceDateTime(value:string){
 const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?$/.exec(value);
 if(!match||!validClobeDate(match[1]))throw new ClobeReadError('invalid_response');
 const [h,m,s]=match[2].split(':').map(Number);if(h>23||m>59||s>59)throw new ClobeReadError('invalid_response');
 return {date:match[1],time:match[2]};
}
export function parseClobeTransactionPage(value:unknown,request:ClobeTransactionsRequest,currency:string,scrapingStatus:ClobeScrapingStatus,now:()=>number=Date.now):ClobeTransactionsResponse{
 const source=parse(pageSchema,value),size=request.size??100;
 if(source.content.length>size||(source.hasNext&&(!source.nextCursor||!source.content.length||source.nextCursor===request.cursor))||(!source.hasNext&&source.nextCursor!==null)||(source.totalElements!==null&&source.totalElements!==undefined&&source.totalElements<source.content.length))throw new ClobeReadError('invalid_response');
 const ids=new Set<number>();
 const rows=source.content.map(row=>{
  const {date,time}=sourceDateTime(row.transactionAt);
  if(row.accountId!==request.bankAccountId||date<request.startDate||date>request.endDate||ids.has(row.transactionId))throw new ClobeReadError('invalid_response');
  ids.add(row.transactionId);
  if((row.inAmount>0)===(row.outAmount>0))throw new ClobeReadError('invalid_response');
  // Both fields are original bank text. Keep the transaction name visible even
  // when its description only says, for example, "급여". Party is an explicit
  // provider business entity, never an inferred person or classification.
  const description=[...new Set([row.transactionName.trim(),row.transactionDescription.trim()].filter(Boolean))].join(' · ');
  return {id:String(row.transactionId),date,time,description,party:row.businessEntityName?.trim()||null,category:row.category?.trim()||null,memo:row.memo?.trim()||null,direction:(row.inAmount>0?'in':'out') as 'in'|'out',amount:row.inAmount>0?row.inAmount:row.outAmount,balance:row.afterBalance??null,currency};
 });
 // Provider aggregate fields are KRW conversions. FX row values remain raw;
 // withholding these sums avoids pretending a converted total is source currency.
 return {fetchedAt:new Date(now()).toISOString(),companyId:request.companyId,bankAccountId:request.bankAccountId,startDate:request.startDate,endDate:request.endDate,rows,hasNext:source.hasNext,nextCursor:source.nextCursor,totalElements:source.totalElements??null,inAmountSum:currency==='KRW'?source.inAmountSumKrw??null:null,outAmountSum:currency==='KRW'?source.outAmountSumKrw??null:null,scraping:scrapingStatus};
}
export async function readClobeTransactions(session:ClobeReadSession,value:unknown,now:()=>number=Date.now):Promise<ClobeTransactionsResponse>{
 const request=parseClobeTransactionsRequest(value);
 if(!(await companies(session)).some(company=>company.companyId===request.companyId))throw new ClobeReadError('forbidden');
 const account=(await bankAccounts(session,request.companyId)).find(account=>account.bankAccountId===request.bankAccountId);
 if(!account)throw new ClobeReadError('forbidden');
 // The transaction contract does not establish raw versus converted amount
 // currency for FX accounts. Their collected balances can be shown, but these
 // amounts must not acquire a guessed USD/other currency label.
 if(account.currencyCode!=='KRW')throw new ClobeReadError('unsupported_currency');
 const [page,status]=await Promise.all([session.call('get_labeled_transactions',{companyId:request.companyId,accountId:request.bankAccountId,startDate:request.startDate,endDate:request.endDate,size:request.size??100,...(request.cursor?{cursor:request.cursor}:{})}),scraping(session,request.companyId)]);
 return parseClobeTransactionPage(page,request,account.currencyCode,status,now);
}

const privateHeaders={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
export function clobeReadApiError(error:unknown){
 const message=error instanceof Error?error.message:'';
 const status=message==='UNAUTHORIZED'?401:message==='ADMIN_REQUIRED'?403:error instanceof ClobeReadError?(error.code==='forbidden'?403:error.code==='invalid_request'?400:error.code==='unsupported_currency'?422:error.code==='timeout'?504:502):error instanceof ClobeAuthError?409:502;
 return Response.json({error:status===401?'로그인이 필요합니다.':status===403?'조회 권한이 없는 회사 또는 계좌입니다.':error instanceof ClobeReadError||error instanceof ClobeAuthError?error.message:'Clobe 자료를 조회하지 못했습니다. 잠시 후 다시 조회해주세요.'},{status,headers:privateHeaders});
}
export type ClobeReadRouteDependencies={authenticate:()=>Promise<{db:SupabaseClient;ownerId:string}>;getAccessToken:(db:SupabaseClient,ownerId:string)=>Promise<string>;openSession:(token:string,options:{signal:AbortSignal})=>Promise<ClobeReadSession>;getOrigin:()=>string};
export function clobeAccountsHandler(deps:ClobeReadRouteDependencies){
 return async(request:Request)=>{
  let session:ClobeReadSession|undefined;
  try{
   const {db,ownerId}=await deps.authenticate();
   session=await deps.openSession(await deps.getAccessToken(db,ownerId),{signal:request.signal});
   return Response.json(await readClobeAccounts(session),{headers:privateHeaders});
  }catch(error){return clobeReadApiError(error);}finally{await session?.close();}
 };
}
async function readRequest(request:Request){
 const limit=8192;
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||Number(request.headers.get('content-length'))>limit||!request.body)throw new ClobeReadError('invalid_request');
 const reader=request.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
 try{
  while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>limit){await reader.cancel();throw new ClobeReadError('invalid_request');}chunks.push(next.value);}
  return parseClobeTransactionsRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
 }catch{throw new ClobeReadError('invalid_request');}finally{reader.releaseLock();}
}
export function clobeTransactionsHandler(deps:ClobeReadRouteDependencies){
 return async(request:Request)=>{
  let session:ClobeReadSession|undefined;
  try{
   // Browser-triggered POST requires the configured canonical origin. Neither
   // request Host nor forwarded headers can redirect the trusted comparison.
   if(request.headers.get('origin')!==deps.getOrigin())throw new ClobeReadError('forbidden');
   const input=await readRequest(request);
   const {db,ownerId}=await deps.authenticate();
   session=await deps.openSession(await deps.getAccessToken(db,ownerId),{signal:request.signal});
   return Response.json(await readClobeTransactions(session,input),{headers:privateHeaders});
  }catch(error){return clobeReadApiError(error);}finally{await session?.close();}
 };
}
