import type {TossSettlementGroup} from '../toss/types';
import type {AccountFundingIncome} from './account-funding';
import {isValidDateRange,parseFinanceDate,type DateRange} from './date-range';
import type {CashPlan} from './cash-plan';

/** Only future, unreconciled provider receipts can change the cash projection. */
export function tossFundingIncome(groups:TossSettlementGroup[],range:DateRange,asOf:string):AccountFundingIncome[]{
 const unique=new Map<string,AccountFundingIncome>();
 for(const item of groups){
  if(item.status!=='pending'||!Number.isSafeInteger(item.pendingAmount)||item.pendingAmount<=0||!parseFinanceDate(item.date)||item.date<=asOf||item.date<range.from||item.date>range.to)continue;
  unique.set(item.id,{key:item.id,businessId:item.businessId,accountId:item.accountId,date:item.date,title:'토스 정산 입금',amount:item.pendingAmount});
 }
 return [...unique.values()];
}

export type TossCalendarIncome={
 key:string;
 businessId:string;
 accountId:string;
 date:string;
 title:string;
 /** Original signed provider net amount, not another bank deposit. */
 amount:number;
 status:TossSettlementGroup['status']|'zero'|'adjustment';
 label:string;
 receivedAmount:number;
 pendingAmount:number;
 /** A comparison only; a positive difference is not confirmed unpaid income. */
 differenceAmount:number;
 reason:string|null;
 merchantIds:string[];
 matchedTransactionIds:string[];
 /** Every calendar row is display-only, including a future expected receipt. */
 noCash:true;
};

const calendarStatuses=new Set<TossSettlementGroup['status']>(['pending','received','confirmation-needed','overdue']);
const calendarFingerprint=(item:TossSettlementGroup)=>JSON.stringify([item.businessId,item.accountId,item.date,item.amount,item.receivedAmount,item.pendingAmount,item.status,item.reason,[...item.merchantIds].sort(),[...item.matchedTransactionIds].sort()]);

/** Keep the provider date visible across today and receipt confirmation. Cash
 * projections must continue using tossFundingIncome, never these display rows.
 * Account/business eligibility is established by reconcileTossSettlements. */
export function tossCalendarIncome(groups:readonly TossSettlementGroup[],range:DateRange,asOf?:string):TossCalendarIncome[]{
 if(!isValidDateRange(range)||(asOf!==undefined&&!parseFinanceDate(asOf)))return [];
 type Entry={source:TossSettlementGroup;fingerprint:string;conflict:boolean};
 const byId=new Map<string,Entry>(),byScope=new Map<string,Entry>();
 for(const item of groups){
  if(!item.id.trim()||!item.businessId.trim()||!item.accountId.trim()||!parseFinanceDate(item.date)||!calendarStatuses.has(item.status)||!Number.isSafeInteger(item.amount)||!Number.isSafeInteger(item.receivedAmount)||item.receivedAmount<0||!Number.isSafeInteger(item.pendingAmount)||item.pendingAmount<0||!Number.isSafeInteger(item.amount-item.receivedAmount))continue;
  const scope=JSON.stringify([item.businessId,item.accountId,item.date]),fingerprint=calendarFingerprint(item);
  const idEntry=byId.get(item.id),scopeEntry=byScope.get(scope),previous=idEntry??scopeEntry;
  if(previous){
   if(idEntry&&scopeEntry&&idEntry!==scopeEntry){
    previous.conflict=true;
    for(const [key,entry] of byId)if(entry===scopeEntry)byId.set(key,previous);
    for(const [key,entry] of byScope)if(entry===scopeEntry)byScope.set(key,previous);
   }
   if(previous.fingerprint!==fingerprint)previous.conflict=true;
   byId.set(item.id,previous);byScope.set(scope,previous);
  }else{
   const entry={source:item,fingerprint,conflict:false};
   byId.set(item.id,entry);byScope.set(scope,entry);
  }
 }
 const result:TossCalendarIncome[]=[];
 for(const {source:item,conflict} of new Set(byId.values())){
  if(item.date<range.from||item.date>range.to)continue;
  let status:TossCalendarIncome['status']=item.status,label:string;
  let reason=item.reason;
  if(conflict){
   status='confirmation-needed';label='정산 자료 확인 필요';
   reason=[reason,'같은 정산 묶음의 자료가 달라 한 번만 표시합니다. 원본을 확인해주세요.'].filter(Boolean).join(' ');
  }else if(item.amount===0){status='zero';label='정산액 0';}
  else if(item.amount<0){status='adjustment';label='정산 차감액 확인';}
  else if(item.receivedAmount>0&&item.receivedAmount!==item.amount){status='confirmation-needed';label=item.receivedAmount<item.amount?'부분 입금 · 차액 확인':'입금 차액 확인';}
  else if(item.status==='received'&&item.receivedAmount===item.amount){status='received';label='입금 완료';}
  else if(item.status==='pending'&&item.receivedAmount===0&&item.pendingAmount===item.amount&&(!asOf||item.date>asOf)){status='pending';label='입금 예정';}
  else if(item.status==='overdue'||(asOf&&item.date<asOf)){status='overdue';label='지급일 경과 · 입금 확인 필요';}
  else{status='confirmation-needed';label=asOf&&item.date===asOf?'오늘 입금 확인 필요':'입금 확인 필요';}
  result.push({key:item.id,businessId:item.businessId,accountId:item.accountId,date:item.date,title:'토스 정산',amount:item.amount,status,label,receivedAmount:item.receivedAmount,pendingAmount:status==='pending'?item.pendingAmount:0,differenceAmount:item.amount-item.receivedAmount,reason,merchantIds:[...item.merchantIds],matchedTransactionIds:[...item.matchedTransactionIds],noCash:true});
 }
 return result.sort((a,b)=>a.date.localeCompare(b.date)||a.businessId.localeCompare(b.businessId)||a.accountId.localeCompare(b.accountId)||a.key.localeCompare(b.key));
}

/** The provider scenario never combines possibly duplicate manual income. */
export function tossCashForecastPlan(plan:CashPlan,incoming:AccountFundingIncome[]):CashPlan{
 return {...plan,businesses:plan.businesses.map(item=>{
  const scheduledIncome=incoming.filter(receipt=>receipt.businessId===item.business.id).map(receipt=>({date:receipt.date,title:receipt.title,amount:receipt.amount,direction:'in' as const,frequency:'once' as const,recurringId:`toss:${receipt.key}`,businessId:receipt.businessId,accountId:receipt.accountId}));
  const income=scheduledIncome.reduce((sum,receipt)=>sum+receipt.amount,0);
  return {...item,scheduledIncome,income,projected:item.afterExpenses===null?null:item.afterExpenses+income};
 })};
}
