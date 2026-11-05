import {TossError,type TossServerMerchant} from './config';
import {parseFinanceDate} from '../finance/date-range';
import type {TossSettlement} from './types';

const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f]/.test(value);
const money=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value);
export const TOSS_SETTLEMENT_PAGE_SIZE=5000;
export const TOSS_SETTLEMENT_ROW_LIMIT=20000;
/** Preserve the provider's signed payout amount; never infer cancellation
 * deductions by subtracting cancelAmount a second time. Payment/transaction
 * keys remain opaque and are not parsed to derive identity or timestamps. */
export function normalizeTossSettlement(input:unknown,merchant:TossServerMerchant,range:{from:string;to:string},syncedAt:string):TossSettlement{
 if(!isObject(input)||input.mId!==merchant.merchantId||input.currency!=='KRW'||!text(input.transactionKey,200)||!text(input.paymentKey,200)
  ||!text(input.paidOutDate,10)||!parseFinanceDate(input.paidOutDate)||input.paidOutDate<range.from||input.paidOutDate>range.to
  ||!text(input.soldDate,10)||!parseFinanceDate(input.soldDate)||!money(input.amount)||!money(input.payOutAmount)||!money(input.supplyAmount)||!money(input.vat))throw new TossError('incomplete');
 // A cancellation DTO using unsigned positive payout figures would overstate
 // receivables. Such undocumented shapes require review rather than guessing.
 if(input.cancel!==null&&input.cancel!==undefined&&(!isObject(input.cancel)||input.payOutAmount>0))throw new TossError('incomplete');
 const fee=input.supplyAmount+input.vat;if(!money(fee))throw new TossError('incomplete');
 return {merchant_id:merchant.merchantId,transaction_key:input.transactionKey,payment_key:input.paymentKey,business_id:merchant.businessId,account_id:merchant.accountId,paid_out_date:input.paidOutDate,sold_date:input.soldDate,amount:input.amount,pay_out_amount:input.payOutAmount,fee_amount:fee,synced_at:syncedAt};
}
export function tossSyncRange(now=Date.now()){
 const today=new Date(now+9*3600000).toISOString().slice(0,10),[year,month]=today.split('-').map(Number);
 return {from:new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,10),to:new Date(Date.parse(today+'T00:00:00Z')+90*86400000).toISOString().slice(0,10)};
}
async function boundedJson(response:Response):Promise<unknown>{
 if(Number(response.headers.get('content-length'))>12*1024*1024)throw new TossError('incomplete');
 if(!response.body)throw new TossError('incomplete');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>12*1024*1024){await reader.cancel();throw new TossError('incomplete');}chunks.push(part.value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new TossError('incomplete');}
 }finally{reader.releaseLock();}
}
export async function readTossSettlements(merchants:readonly TossServerMerchant[],range:{from:string;to:string},signal:AbortSignal,now=Date.now,fetcher:typeof fetch=fetch):Promise<TossSettlement[]>{
 const all:TossSettlement[]=[],syncedAt=new Date(now()).toISOString(),keys=new Map<string,string>();
 for(const merchant of merchants){
  let complete=false;
  for(let page=1;page<=TOSS_SETTLEMENT_ROW_LIMIT/TOSS_SETTLEMENT_PAGE_SIZE+1;page++){
   signal.throwIfAborted();
   const url=new URL('https://api.tosspayments.com/v1/settlements');
   for(const [key,value] of Object.entries({startDate:range.from,endDate:range.to,dateType:'paidOutDate',page:String(page),size:String(TOSS_SETTLEMENT_PAGE_SIZE)}))url.searchParams.set(key,value);
   let response:Response;
   try{response=await fetcher(url,{method:'GET',headers:{Authorization:`Basic ${Buffer.from(merchant.secretKey+':').toString('base64')}`},cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(65000)])});}
   catch{throw new TossError('provider');}
   if(response.status===401||response.status===403)throw new TossError('provider_auth');
   if(!response.ok)throw new TossError('provider');
   const payload=await boundedJson(response);
   if(!Array.isArray(payload)||payload.length>TOSS_SETTLEMENT_PAGE_SIZE)throw new TossError('incomplete');
   let newRows=0;
   for(const input of payload){
    const row=normalizeTossSettlement(input,merchant,range,syncedAt),key=JSON.stringify([row.merchant_id,row.transaction_key]),signature=JSON.stringify(row),previous=keys.get(key);
    if(previous!==undefined){if(previous!==signature)throw new TossError('incomplete');continue;}
    keys.set(key,signature);all.push(row);newRows++;
    if(all.length>TOSS_SETTLEMENT_ROW_LIMIT)throw new TossError('incomplete');
   }
   // A repeated full page cannot prove that every remaining row was fetched.
   if(payload.length===TOSS_SETTLEMENT_PAGE_SIZE&&newRows===0)throw new TossError('incomplete');
   if(payload.length<TOSS_SETTLEMENT_PAGE_SIZE){complete=true;break;}
  }
  if(!complete)throw new TossError('incomplete');
 }
 return all;
}
