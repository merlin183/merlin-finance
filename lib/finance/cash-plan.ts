import {occurrences} from './aggregate';
import {accountSnapshot,type BalanceSnapshot} from './balances';
import {isValidDateRange,parseFinanceDate,type DateRange} from './date-range';
import {addDays} from './format';
import {resolveCashPlanPeriod} from './cash-plan-period';
import type {Account,Business,Dataset,Recurring,Transaction} from './types';
import type {PaymentKind,PaymentStatus} from './cash-plan-edits';

export type CashPlanOccurrence={date:string;title:string;amount:number;direction:'in'|'out';frequency:'monthly'|'once';recurringId:string;businessId:string;accountId?:string|null;memo?:string;sourceType?:'registered'|'manual'|'estimated';paymentKind?:PaymentKind;paymentStatus?:PaymentStatus};
export type CashPlanUndatedExpense={key:string;businessId:string;accountId:string|null;title:string;amount:number;month:string;from:string;to:string;memo?:string;expectedDate?:string;sourceType:'registered'|'manual'|'estimated';paymentKind?:PaymentKind;paymentStatus?:PaymentStatus};
export type CashPlanAccount={account:Account;snapshot:BalanceSnapshot};
export type CashPlanBusiness={
 business:Business;
 accounts:CashPlanAccount[];
 balance:number|null;
 /** Only the known accounts' subtotal; never a substitute for a missing total. */
 knownBalance:number;
 registeredItemCount:number;
 scheduledExpenses:CashPlanOccurrence[];
 scheduledIncome:CashPlanOccurrence[];
 /** Past/today registrations have no payment link. Do not mark them paid. */
 unconfirmedExpenses?:CashPlanOccurrence[];
 /** Explicit budgets with no payment date. Never invent a timeline date. */
 undatedExpenses?:CashPlanUndatedExpense[];
 expenses:number;
 income:number;
 afterExpenses:number|null;
 projected:number|null;
 reserve:number;
 available:number|null;
};
export type CashPlan={asOf:string;horizon:number;range:DateRange;businesses:CashPlanBusiness[]};

const compareText=(left:string,right:string)=>left<right?-1:left>right?1:0;
const compareOccurrences=(left:CashPlanOccurrence,right:CashPlanOccurrence)=>compareText(left.date,right.date)||compareText(left.title,right.title)||compareText(left.recurringId,right.recurringId);

/**
 * Project only explicitly registered schedules from tomorrow through the
 * horizon. Historical transactions establish balances, not future obligations
 * or whether a registered schedule has already been paid.
 */
export function buildCashPlan(data:Dataset,asOf:string,horizon=30):CashPlan {
 if(!parseFinanceDate(asOf))throw new RangeError('잔액 기준일을 확인해주세요.');
 if(!Number.isSafeInteger(horizon)||horizon<1)throw new RangeError('예정 기간은 1일 이상의 정수로 입력해주세요.');
 const range={from:addDays(asOf,1),to:addDays(asOf,horizon)};
 if(!isValidDateRange(range))throw new RangeError('조회할 예정 기간을 확인해주세요.');
 return buildPlanPeriod(data,asOf,horizon,range);
}

function buildPlanPeriod(data:Dataset,asOf:string,horizon:number,range:DateRange,useCollectedBalances=false):CashPlan {
 const transactionsByAccount=new Map<string,Transaction[]>();
 for(const transaction of data.transactions){
  const rows=transactionsByAccount.get(transaction.account_id);
  if(rows)rows.push(transaction);else transactionsByAccount.set(transaction.account_id,[transaction]);
 }
 const accountsByBusiness=new Map<string,Account[]>();
 for(const account of data.accounts){
  const accounts=accountsByBusiness.get(account.business_id);
  if(accounts)accounts.push(account);else accountsByBusiness.set(account.business_id,[account]);
 }
 const recurringByBusiness=new Map<string,Recurring[]>();
 for(const item of data.recurring){
  const items=recurringByBusiness.get(item.business_id);
  if(items)items.push(item);else recurringByBusiness.set(item.business_id,[item]);
 }
 const businesses=data.businesses.map((business):CashPlanBusiness=>{
  const accounts=(accountsByBusiness.get(business.id)||[]).map(account=>({account,snapshot:accountSnapshot(account,transactionsByAccount.get(account.id)||[],asOf,useCollectedBalances?data.balance_snapshots:undefined)}));
  const knownBalance=accounts.reduce((sum,{snapshot})=>sum+(snapshot.balance??0),0);
  const balance=accounts.length>0&&accounts.every(({snapshot})=>snapshot.balance!==null)?knownBalance:null;
  const items=recurringByBusiness.get(business.id)||[];
  const scheduled=items.flatMap(item=>occurrences(item,range.from,range.to).map((date):CashPlanOccurrence=>({
   date,title:item.title,amount:item.amount,direction:item.direction,frequency:item.frequency,recurringId:item.id,businessId:business.id,
  }))).sort(compareOccurrences);
  const scheduledExpenses=scheduled.filter(item=>item.direction==='out');
  const scheduledIncome=scheduled.filter(item=>item.direction==='in');
  const expenses=scheduledExpenses.reduce((sum,item)=>sum+item.amount,0);
  const income=scheduledIncome.reduce((sum,item)=>sum+item.amount,0);
  const reserve=business.reserve;
  return {
   business,accounts,balance,knownBalance,registeredItemCount:items.length,
   scheduledExpenses,scheduledIncome,expenses,income,
   afterExpenses:balance===null?null:balance-expenses,
   projected:balance===null?null:balance+income-expenses,
   reserve,available:balance===null?null:balance-expenses-reserve,
  };
 });
 return {asOf,horizon,range,businesses};
}

/** A saved calendar plan uses the record balance before its first day. */
export function buildCashPlanForRange(data:Dataset,range:DateRange):CashPlan {
 const period=resolveCashPlanPeriod(range);
 return buildCashPlan(data,period.asOf,period.horizon);
}

/** Keep the saved range, but plan from the current recorded bank balances.
 * A registration has no transaction link, so past due items stay unconfirmed. */
export function buildCurrentCashPlanForRange(data:Dataset,range:DateRange,asOf:string):CashPlan {
 if(!parseFinanceDate(asOf))throw new RangeError('현재 잔액의 조회 기준일을 확인해주세요.');
 const period=resolveCashPlanPeriod(range);
 const plan=buildPlanPeriod(data,asOf,period.horizon,period.range,true);
 return {...plan,businesses:plan.businesses.map(business=>{
  const unconfirmedExpenses=business.scheduledExpenses.filter(item=>item.date<=asOf);
  const scheduledExpenses=business.scheduledExpenses.filter(item=>item.date>asOf);
  const scheduledIncome=business.scheduledIncome.filter(item=>item.date>asOf);
  const expenses=scheduledExpenses.reduce((sum,item)=>sum+item.amount,0);
  const income=scheduledIncome.reduce((sum,item)=>sum+item.amount,0);
  const balance=business.balance;
  const confirmed=balance!==null&&unconfirmedExpenses.length===0;
  return {...business,scheduledExpenses,scheduledIncome,unconfirmedExpenses,expenses,income,
   afterExpenses:confirmed?balance-expenses:null,
   projected:confirmed?balance+income-expenses:null,
   available:confirmed?balance-expenses-business.reserve:null,
  };
 })};
}

/** Registered-only current cash projection, sharing the same remaining items. */
export function buildCurrentCashForecast(plan:CashPlan):Record<string,string|number|null>[] {
 const from=plan.range.from>plan.asOf?plan.range.from:plan.asOf;
 if(from>plan.range.to)return [];
 const states=plan.businesses.map(business=>({business,balance:business.balance,changes:new Map<string,number>()}));
 for(const state of states){
  for(const item of [...state.business.scheduledIncome,...state.business.scheduledExpenses]){
   if(item.date<plan.asOf||(item.date===plan.asOf&&item.sourceType!=='manual'&&item.sourceType!=='estimated')||item.date<from||item.date>plan.range.to)continue;
   state.changes.set(item.date,(state.changes.get(item.date)??0)+(item.direction==='in'?1:-1)*item.amount);
  }
 }
 const points:Record<string,string|number|null>[]=[];
 for(let date=from;;date=addDays(date,1)){
  const point:Record<string,string|number|null>={date};
  for(const state of states){
   if(state.balance!==null)state.balance+=state.changes.get(date)??0;
   const overdueTax=state.business.scheduledExpenses.some(item=>item.paymentKind==='tax'&&item.paymentStatus!=='paid'&&item.date<from);
   point[state.business.business.id]=(state.business.unconfirmedExpenses?.length??0)>0||(state.business.undatedExpenses?.length??0)>0||overdueTax?null:state.balance;
  }
  points.push(point);
  if(date===plan.range.to)break;
 }
 return points;
}
