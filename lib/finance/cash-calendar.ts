import type {AccountFundingBusiness,AccountFundingItem} from './account-funding';
import {unionBankPlanTransactions} from './clobe-plan-actuals';
import {formatFinanceDate,isValidDateRange,parseFinanceDate,type DateRange} from './date-range';
import type {CashPlanEditorItem} from './editable-cash-plan';
import type {PaymentKind,PaymentStatus} from './cash-plan-edits';
import {cashPlanPaymentConfirmation} from './cash-plan-payment-confirmation';
import {getSourceDetailEntries,sourceCounterparty} from './source-details';
import type {Business,Dataset,Transaction} from './types';

export type CashCalendarItem={
 key:string;kind:'actual'|'planned'|'confirmed';businessId:string;accountId:string|null;
 date:string|null;title:string;amount:number;note:string;
 source:'bank-query'|'ledger'|'plan'|'manual-confirmation';planLink:string|null;
 transactionId?:string;from?:string;to?:string;paymentKind?:PaymentKind;paymentStatus?:PaymentStatus;
};
export type CashCalendarBusinessDay={
 business:Business;businessId:string;actualExpenses:number;plannedExpenses:number;confirmedExpenses:number;
};
export type CashCalendarDay={
 date:string;items:CashCalendarItem[];businesses:CashCalendarBusinessDay[];
 actualExpenses:number;plannedExpenses:number;confirmedExpenses:number;
};
export type CashCalendarModel={
 range:DateRange;days:CashCalendarDay[];undatedItems:CashCalendarItem[];
 /** All observed bank withdrawals, including transfers and loan movements. */
 actualExpenses:number;
 /** Remaining plans, including undated plans, using the funding model unchanged. */
 plannedExpenses:number;datedPlannedExpenses:number;undatedPlannedExpenses:number;
 /** User confirmation in excess of observed transactions; never bank actuals. */
 confirmedExpenses:number;
};
export type CashCalendar=CashCalendarModel;
export type CashCalendarInput={
 data:Dataset;items:readonly CashPlanEditorItem[];funding:readonly AccountFundingBusiness[];
 range:DateRange;asOf:string;basis:'registered'|'estimated';businessId?:string;accountId?:string;
};

const compareText=(left:string,right:string)=>left<right?-1:left>right?1:0;
const positiveMoney=(amount:number)=>Number.isSafeInteger(amount)&&amount>0;
const selected=(value:string|undefined)=>value&&value!=='all'?value:null;
const sum=(items:readonly CashCalendarItem[],kind:CashCalendarItem['kind'])=>items.reduce((total,item)=>total+(item.kind===kind?item.amount:0),0);
const sortItems=(left:CashCalendarItem,right:CashCalendarItem)=>compareText(left.businessId,right.businessId)||compareText(left.kind,right.kind)||compareText(left.title,right.title)||compareText(left.key,right.key);
const financialIdentity=(row:Transaction)=>JSON.stringify([row.business_id,row.account_id,row.txn_date,row.txn_time??null,row.direction,row.amount,row.balance]);

/** Shared, read-only source for actual-withdrawal displays. Keep bank/ledger
 * deduplication and conflicting IDs identical in the calendar and worksheet. */
export function cashCalendarActualTransactions(data:Dataset,asOf:string){
 if(!parseFinanceDate(asOf))throw new RangeError('실제 출금 조회 기준일을 확인해주세요.');
 const union=unionBankPlanTransactions(data,asOf),unique=new Map<string,Transaction>(),conflicts=new Set<string>();
 const owners=new Map(data.accounts.map(account=>[account.id,account.business_id]));
 for(const row of union.rows){
  const previous=unique.get(row.id);
  if(previous&&financialIdentity(previous)!==financialIdentity(row))conflicts.add(row.id);
  else if(!previous)unique.set(row.id,row);
 }
 const transactions=[...unique.values()].filter(row=>!conflicts.has(row.id)&&row.direction==='out'&&positiveMoney(row.amount)
  &&!!parseFinanceDate(row.txn_date)&&row.txn_date<=asOf&&owners.get(row.account_id)===row.business_id);
 return {transactions,bankById:union.bankById};
}

/** Funding keys identify their original source; titles and amounts alone never
 * establish a link. A link is optional and never changes either model's sums. */
function fundingPlanLink(source:AccountFundingItem,businessId:string,accountId:string|null,items:readonly CashPlanEditorItem[]):string|null{
 const active=items.filter(item=>item.businessId===businessId&&item.accountId===accountId);
 const exact=active.filter(item=>item.key===source.key);
 if(exact.length===1)return exact[0].key;
 let parts:unknown;
 try{parts=JSON.parse(source.key);}catch{return null;}
 if(!Array.isArray(parts)||parts.length<3||typeof parts[1]!=='string')return null;
 const [kind,sourceKey,period]=parts;
 if(kind!=='estimated'&&kind!=='budget'&&kind!=='registered')return null;
 const found=active.filter(item=>item.source_key===sourceKey&&(kind==='budget'?item.month===period:item.date===period));
 return found.length===1?found[0].key:null;
}

/** A display-only calendar beside the unchanged funding projection. Actuals
 * use the shared strict bank/ledger union and their original account and date.
 * Every observed withdrawal is shown even without a plan or when its plan was
 * excluded; bank transfers and loans are withdrawals, not operating costs.
 * Remaining plans come exclusively from funding items. User confirmations are
 * separate evidence and cannot invent bank transactions or payment dates.
 */
export function buildCashCalendarModel({data,items,funding,range,asOf,basis,businessId,accountId}:CashCalendarInput):CashCalendarModel{
 if(!isValidDateRange(range)||!parseFinanceDate(asOf))throw new RangeError('지출 달력의 조회 기간과 기준일을 확인해주세요.');
 const businessFilter=selected(businessId),accountFilter=selected(accountId);
 // The parent can already have selected a business. Never expand that scope
 // back to every business merely because the panel's local filter is "all".
 const businesses=new Map(funding.filter(item=>!businessFilter||item.business.id===businessFilter).map(item=>[item.business.id,item.business]));
 const owners=new Map(data.accounts.map(account=>[account.id,account.business_id]));
 const inScope=(business:string,account:string|null)=>businesses.has(business)&&(!accountFilter||account===accountFilter);
 const validAccount=(business:string,account:string|null)=>account!==null&&owners.get(account)===business;
 const inRange=(date:string)=>!!parseFinanceDate(date)&&date>=range.from&&date<=range.to;
 const visiblePlans=items.filter(item=>businesses.has(item.businessId)&&!item.excluded&&item.inRange&&(item.source_type===basis||item.source_type==='manual'||!!item.seriesId));
 const planByTransaction=new Map<string,CashPlanEditorItem[]>();
 for(const item of visiblePlans)for(const row of item.recordedTransactions??[]){
  const candidates=planByTransaction.get(row.id)??[];
  if(!candidates.some(candidate=>candidate.key===item.key))candidates.push(item);
  planByTransaction.set(row.id,candidates);
 }
 const byDate=new Map<string,CashCalendarItem[]>(),undatedItems:CashCalendarItem[]=[];
 const append=(item:CashCalendarItem)=>{
  if(item.date===null){undatedItems.push(item);return;}
  const day=byDate.get(item.date)??[];day.push(item);byDate.set(item.date,day);
 };
 const actuals=cashCalendarActualTransactions(data,asOf);
 const categories=new Map(data.categories.map(category=>[category.id,category]));
 const linked=new Set(data.links.map(link=>link.out_transaction_id));
 const observed=new Map<string,Transaction>();
 for(const row of actuals.transactions){
  observed.set(row.id,row);
  if(!inScope(row.business_id,row.account_id)||!inRange(row.txn_date))continue;
  const candidates=planByTransaction.get(row.id)??[],plan=candidates.length===1?candidates[0]:null;
  const category=categories.get(row.category_id??''),source=actuals.bankById.has(row.id)?'bank-query':'ledger';
  const title=sourceCounterparty(row)||row.description||'출금';
  const note=[source==='bank-query'?'은행 조회 확인':'통장 거래',
   row.description&&row.description!==title?`적요: ${row.description}`:'',
   ...getSourceDetailEntries(row).filter(entry=>entry.value!==title&&entry.value!==row.description).map(entry=>`${entry.label}: ${entry.value}`),
   category?`계정과목: ${category.name}`:row.raw_gwamok?`계정과목: ${row.raw_gwamok}`:'',
   row.is_internal||category?.is_internal||linked.has(row.id)?'내부 자금 이동':'',
   plan?`연결 계획: ${plan.title}`:'',
  ].filter(Boolean).join(' · ');
  append({key:JSON.stringify(['actual',row.id]),kind:'actual',businessId:row.business_id,accountId:row.account_id,date:row.txn_date,title,amount:row.amount,note,source,planLink:plan?.key??null,transactionId:row.id,paymentKind:plan?.paymentKind,paymentStatus:plan?.paymentStatus});
 }
 for(const business of funding){
  if(!businesses.has(business.business.id))continue;
  const putPlan=(source:AccountFundingItem,account:string|null)=>{
   if(!inScope(business.business.id,account)||!positiveMoney(source.amount)||source.date!==null&&!inRange(source.date)||source.date===null&&(source.from&&source.from>range.to||source.to&&source.to<range.from))return;
   if(account!==null&&!validAccount(business.business.id,account))return;
   append({key:JSON.stringify(['planned',business.business.id,account,source.key]),kind:'planned',businessId:business.business.id,accountId:account,date:source.date,title:source.title,amount:source.amount,note:source.note,source:'plan',planLink:fundingPlanLink(source,business.business.id,account,visiblePlans),from:source.from,to:source.to,paymentKind:source.paymentKind,paymentStatus:source.paymentStatus});
  };
  for(const account of business.accounts)for(const source of account.items)putPlan(source,account.account.id);
  for(const source of business.unassignedItems)putPlan(source,null);
 }
 for(const item of visiblePlans){
  const date=item.confirmedDate,confirmed=item.confirmedAmount;
  if(confirmed===null||!positiveMoney(confirmed)||!date||date>asOf||!inRange(date)||!inScope(item.businessId,item.accountId))continue;
  if(item.accountId!==null&&!validAccount(item.businessId,item.accountId))continue;
  // A confirmation is cumulative for its plan/month. Compare with all its
  // observed payments, including payments outside this selected date interval.
  // Do not add the cumulative confirmation on top of those same transactions.
  const ids=new Set((item.recordedTransactions??[]).filter(row=>row.business_id===item.businessId&&row.txn_date.slice(0,7)===item.month).map(row=>row.id));
  const actual=[...ids].reduce((total,id)=>total+(observed.get(id)?.amount??0),0);
  const amount=Math.max(0,confirmed-actual);
  if(!amount)continue;
  const confirmation=cashPlanPaymentConfirmation(item.edit,asOf);
  const note=[`사용자 누적 출금 확인 ${confirmed.toLocaleString('ko-KR')}원`,actual?`통장 실거래 ${actual.toLocaleString('ko-KR')}원과 겹치는 금액 제외`:'통장 거래 자동 확인 없음',item.confirmationComplete?'출금 완료 확인':'일부 출금 확인',confirmation?.returnedAmount?`반환 입금 직접 확인 ${confirmation.returnedDate} ${confirmation.returnedAmount.toLocaleString('ko-KR')}원`:'',confirmation?.memo].filter(Boolean).join(' · ');
  append({key:JSON.stringify(['confirmed',item.key]),kind:'confirmed',businessId:item.businessId,accountId:item.accountId,date,title:item.title,amount,note,source:'manual-confirmation',planLink:item.key,paymentKind:item.paymentKind,paymentStatus:item.paymentStatus});
 }
 const days:CashCalendarDay[]=[],cursor=parseFinanceDate(range.from)!;
 for(let date=range.from;date<=range.to;cursor.setDate(cursor.getDate()+1),date=formatFinanceDate(cursor)){
  const dayItems=(byDate.get(date)??[]).sort(sortItems);
  const dayBusinesses=[...businesses.values()].flatMap(business=>{
   const own=dayItems.filter(item=>item.businessId===business.id);
   return own.length?[{business,businessId:business.id,actualExpenses:sum(own,'actual'),plannedExpenses:sum(own,'planned'),confirmedExpenses:sum(own,'confirmed')}]:[];
  });
  days.push({date,items:dayItems,businesses:dayBusinesses,actualExpenses:sum(dayItems,'actual'),plannedExpenses:sum(dayItems,'planned'),confirmedExpenses:sum(dayItems,'confirmed')});
  if(date===range.to)break;
 }
 undatedItems.sort(sortItems);
 const datedPlannedExpenses=days.reduce((total,day)=>total+day.plannedExpenses,0),undatedPlannedExpenses=sum(undatedItems,'planned');
 return {range:{...range},days,undatedItems,actualExpenses:days.reduce((total,day)=>total+day.actualExpenses,0),plannedExpenses:datedPlannedExpenses+undatedPlannedExpenses,datedPlannedExpenses,undatedPlannedExpenses,confirmedExpenses:days.reduce((total,day)=>total+day.confirmedExpenses,0)};
}
