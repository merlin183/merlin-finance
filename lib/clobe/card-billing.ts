import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ClobeReadError,type ClobeReadSession} from './mcp';
import {clobeReadApiError,validClobeDate,type ClobeReadRouteDependencies} from './read';
import type {ClobeScrapingStatus} from './types';
import type {ClobeCardBill,ClobeCardBillsCompany,ClobeCardBillsRequest,ClobeCardBillsResponse} from './card-billing-types';

export const CLOBE_CARD_MAX_ROWS=20000;
export const CLOBE_CARD_MAX_DAYS=93;
const PAGE_SIZE=100;
const MAX_COMPANIES=100;
const DEADLINE_MS=45000;
const text=z.string().max(4000);
const money=z.number().int().safe();
const date=z.string().refine(validClobeDate);
const contextSchema=z.object({companies:z.array(z.object({companyId:z.string().trim().min(1).max(200),companyName:text})).max(MAX_COMPANIES)});
const itemSchema=z.object({billingItemId:z.number().int().positive().safe(),billingType:z.enum(['PRE_PAYMENT','REGULAR','ADJUSTMENT']),cardNo:z.string().trim().min(1).max(200),paymentAmount:money.nullable(),paymentDate:date});
const pageSchema=z.object({content:z.array(itemSchema).max(PAGE_SIZE),totalElements:z.number().int().nonnegative().max(CLOBE_CARD_MAX_ROWS),page:z.number().int().nonnegative(),size:z.number().int().min(1).max(PAGE_SIZE),hasNext:z.boolean(),totalPayoutAmountSum:money.nullish()});
const scrapingSchema=z.object({assets:z.array(z.object({category:text,status:text,scrapedAt:text.nullish(),failureCategory:text.nullish()})).max(500)});
const privateHeaders={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
type Item=z.infer<typeof itemSchema>;

function parse<T>(schema:z.ZodType<T>,value:unknown):T{
 const result=schema.safeParse(value);if(!result.success)throw new ClobeReadError('invalid_response');return result.data;
}
export function parseClobeCardBillsRequest(value:unknown):ClobeCardBillsRequest{
 const result=z.object({startDate:date,endDate:date}).strict().safeParse(value);
 if(!result.success)throw new ClobeReadError('invalid_request');
 const request=result.data;
 const days=(Date.parse(request.endDate+'T00:00:00Z')-Date.parse(request.startDate+'T00:00:00Z'))/86400000+1;
 if(days<1||days>CLOBE_CARD_MAX_DAYS)throw new ClobeReadError('invalid_request');
 return request;
}
function unknownScraping(error:string):ClobeScrapingStatus{return {status:'UNKNOWN',lastCollectedAt:null,error};}
export function parseClobeCardBillingScraping(value:unknown):ClobeScrapingStatus{
 const assets=parse(scrapingSchema,value).assets.filter(asset=>asset.category.toUpperCase()==='CARD_BILLING');
 // Card approval collection does not establish whether any bill was collected.
 if(!assets.length)return unknownScraping('카드 청구 자료의 수집 상태가 없습니다. 청구액이 0원이라는 뜻은 아닙니다.');
 const failed=assets.some(asset=>['ERROR','FAILED','FAILURE'].includes(asset.status.toUpperCase())||!!asset.failureCategory);
 const pending=assets.some(asset=>['IN_PROGRESS','PENDING','REQUESTED'].includes(asset.status.toUpperCase()));
 const success=assets.every(asset=>['SUCCESS','COMPLETED'].includes(asset.status.toUpperCase()));
 // Provider timestamps without a timezone are source labels. Preserve them,
 // rather than silently converting them to UTC or borrowing approval times.
 const timestamps=assets.map(asset=>asset.scrapedAt?.trim()||null);
 return {status:failed?'ERROR':pending?'IN_PROGRESS':success?'SUCCESS':'UNKNOWN',lastCollectedAt:timestamps.every(Boolean)?(timestamps as string[]).sort()[0]:null,error:failed?'Clobe 카드 청구 자료 수집에 오류가 있습니다. 연결 상태를 확인해주세요.':!success&&!pending?'Clobe 카드 청구 자료 수집 상태를 확인해주세요.':null};
}
async function scraping(session:ClobeReadSession,companyId:string):Promise<ClobeScrapingStatus>{
 try{return parseClobeCardBillingScraping(await session.call('get_scraping_status',{companyId}));}
 catch{return unknownScraping('Clobe 카드 청구 자료 수집 상태를 조회하지 못했습니다.');}
}
function billKey(companyId:string,cardNo:string,paymentDate:string,kind:string){
 const hex=createHash('sha256').update(JSON.stringify(['clobe-card-billing-v1',companyId,cardNo,paymentDate,kind])).digest('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-${((parseInt(hex[16],16)&3)|8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function maskedCard(cardNo:string){
 const suffix=/(\d{4})\D*$/.exec(cardNo);
 return suffix?'•••• '+suffix[1]:'번호 확인 필요';
}
function safeAdd(a:number,b:number){const sum=a+b;if(!Number.isSafeInteger(sum))throw new ClobeReadError('invalid_response');return sum;}
export function aggregateClobeCardBills(companyId:string,items:Item[],today:string):ClobeCardBill[]{
 const groups=new Map<string,{cardNo:string;bill:ClobeCardBill}>();
 for(const item of items){
  const cardNo=item.cardNo.replace(/\s+/g,'');
  const key=billKey(companyId,cardNo,item.paymentDate,item.billingType);
  const existing=groups.get(key);
  if(existing){existing.bill.itemCount++;existing.bill.amount=existing.bill.amount===null||item.paymentAmount===null?null:safeAdd(existing.bill.amount,item.paymentAmount);}
  else groups.set(key,{cardNo,bill:{key,maskedCard:maskedCard(cardNo),date:item.paymentDate,amount:item.paymentAmount,kind:item.billingType,itemCount:1,replaceable:false,reason:null}});
 }
 const values=[...groups.values()];
 const relatedKinds=new Map<string,Set<string>>(),maskIdentities=new Map<string,Set<string>>();
 for(const value of values){
  const relation=JSON.stringify([value.cardNo,value.bill.date.slice(0,7)]);
  const kinds=relatedKinds.get(relation)||new Set<string>();kinds.add(value.bill.kind);relatedKinds.set(relation,kinds);
  const maskKey=JSON.stringify([value.bill.maskedCard,value.bill.date]);
  const identities=maskIdentities.get(maskKey)||new Set<string>();identities.add(value.cardNo);maskIdentities.set(maskKey,identities);
 }
 return values.map(({cardNo,bill})=>{
  const kindsForCardMonth=relatedKinds.get(JSON.stringify([cardNo,bill.date.slice(0,7)]))!;
  const ambiguousMask=maskIdentities.get(JSON.stringify([bill.maskedCard,bill.date]))!.size>1;
  bill.reason=bill.kind==='PRE_PAYMENT'?'선결제 내역은 예정 카드대금으로 반영하지 않습니다.':bill.kind==='ADJUSTMENT'?'조정 내역은 정기 청구액과의 관계 확인이 필요합니다.':bill.date<today?'이미 지난 결제일의 청구입니다.':bill.amount===null?'원본 청구금액을 확인하지 못했습니다.':bill.amount<=0?'양수 청구금액이 없어 기존 계획을 교체하지 않습니다.':kindsForCardMonth.size>1?'같은 카드·납부월의 선결제 또는 조정 내역을 확인해야 합니다.':ambiguousMask||bill.maskedCard==='번호 확인 필요'?'카드 식별 정보 확인이 필요합니다.':null;
  bill.replaceable=bill.reason===null;
  return bill;
 }).sort((a,b)=>a.date.localeCompare(b.date)||a.maskedCard.localeCompare(b.maskedCard)||a.kind.localeCompare(b.kind)||a.key.localeCompare(b.key));
}
async function readCompany(session:ClobeReadSession,companyId:string,request:ClobeCardBillsRequest,now:()=>number,deadline:number,budget:{rows:number}){
 const items:Item[]=[];const ids=new Set<number>();let expectedTotal:number|undefined;let expectedSum:number|null|undefined;
 for(let page=0;page<Math.ceil(CLOBE_CARD_MAX_ROWS/PAGE_SIZE);page++){
  if(now()>=deadline)throw new ClobeReadError('timeout');
  const source=parse(pageSchema,await session.call('get_labeled_card_billing_items',{companyId,...request,page,size:PAGE_SIZE}));
  if(source.page!==page||source.size!==PAGE_SIZE||source.content.length>source.size)throw new ClobeReadError('invalid_response');
  if(expectedTotal!==undefined&&source.totalElements!==expectedTotal)throw new ClobeReadError('invalid_response');
  if(expectedSum!==undefined&&source.totalPayoutAmountSum!==expectedSum)throw new ClobeReadError('invalid_response');
  expectedTotal=source.totalElements;expectedSum=source.totalPayoutAmountSum;
  budget.rows+=source.content.length;
  if(budget.rows>CLOBE_CARD_MAX_ROWS)throw new ClobeReadError('invalid_response');
  for(const item of source.content){
   if(ids.has(item.billingItemId)||item.paymentDate<request.startDate||item.paymentDate>request.endDate)throw new ClobeReadError('invalid_response');
   ids.add(item.billingItemId);items.push(item);
  }
  if(items.length>source.totalElements||items.length>CLOBE_CARD_MAX_ROWS)throw new ClobeReadError('invalid_response');
  if(source.hasNext){
   if(source.content.length!==PAGE_SIZE||items.length>=source.totalElements)throw new ClobeReadError('invalid_response');
   continue;
  }
  if(items.length!==source.totalElements)throw new ClobeReadError('invalid_response');
  if(expectedSum!==null&&expectedSum!==undefined&&items.every(item=>item.paymentAmount!==null)&&items.reduce((sum,item)=>safeAdd(sum,item.paymentAmount!),0)!==expectedSum)throw new ClobeReadError('invalid_response');
  return items;
 }
 throw new ClobeReadError('invalid_response');
}
export async function readClobeCardBills(session:ClobeReadSession,value:unknown,now:()=>number=Date.now):Promise<ClobeCardBillsResponse>{
 const request=parseClobeCardBillsRequest(value);const started=now(),deadline=started+DEADLINE_MS;
 const context=parse(contextSchema,await session.call('get_my_context'));
 if(new Set(context.companies.map(company=>company.companyId)).size!==context.companies.length)throw new ClobeReadError('invalid_response');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(started));
 const companies:ClobeCardBillsCompany[]=[];
 const budget={rows:0};
 for(let index=0;index<context.companies.length;index+=4){
  const batch=await Promise.all(context.companies.slice(index,index+4).map(async company=>{
   if(now()>=deadline)return {id:company.companyId,name:company.companyName,bills:[],error:'카드 청구 조회 시간이 초과되었습니다. 다시 조회해주세요.',scraping:unknownScraping('수집 상태를 조회하지 못했습니다.'),warnings:[]};
   const [source,status]=await Promise.all([readCompany(session,company.companyId,request,now,deadline,budget).then(items=>({bills:aggregateClobeCardBills(company.companyId,items,today),error:null as string|null})).catch(error=>({bills:[],error:error instanceof ClobeReadError&&error.code==='timeout'?'카드 청구 조회 시간이 초과되었습니다. 다시 조회해주세요.':'카드 청구 전체 내역을 확인하지 못했습니다. 기존 계획을 유지합니다.'})),scraping(session,company.companyId)]);
   const bills=source.bills;
   if(status.status==='ERROR')for(const bill of bills){bill.replaceable=false;bill.reason='카드 청구 자료 수집 오류를 확인해야 합니다.';}
   const warnings=[...(status.error?[status.error]:[]),...(!source.error&&!bills.length?['조회 기간에 수집된 카드 청구가 없습니다. 기존 계획을 유지하며 0원으로 교체하지 않습니다.']:[])];
   return {id:company.companyId,name:company.companyName,bills,error:source.error,scraping:status,warnings};
  }));companies.push(...batch);
 }
 return {...request,fetchedAt:new Date(now()).toISOString(),companies};
}
export function clobeCardBillsHandler(deps:ClobeReadRouteDependencies){
 return async(request:Request)=>{
  let session:ClobeReadSession|undefined;
  try{
   const params=new URL(request.url).searchParams;
   if([...params.keys()].some(key=>!['startDate','endDate'].includes(key))||params.getAll('startDate').length!==1||params.getAll('endDate').length!==1)throw new ClobeReadError('invalid_request');
   let input:ClobeCardBillsRequest;
   try{input=parseClobeCardBillsRequest({startDate:params.get('startDate'),endDate:params.get('endDate')});}catch{throw new ClobeReadError('invalid_request');}
   const {db,ownerId}=await deps.authenticate();
   session=await deps.openSession(await deps.getAccessToken(db,ownerId),{signal:AbortSignal.any([request.signal,AbortSignal.timeout(50000)])});
   return Response.json(await readClobeCardBills(session,input),{headers:privateHeaders});
  }catch(error){return clobeReadApiError(error);}finally{await session?.close();}
 };
}
