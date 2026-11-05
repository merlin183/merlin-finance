import type {AccountFundingAccount,AccountFundingBusiness,AccountFundingItem} from './account-funding';
import type {BalanceSnapshot} from './balances';
import {formatFinanceDate,isValidDateRange,parseFinanceDate,type DateRange} from './date-range';
import type {Account,Business} from './types';

export type FundingAccountDay={
 business:Business;
 account:Account;
 snapshot:BalanceSnapshot;
 items:AccountFundingItem[];
 expenses:number;
 cumulativeExpenses:number;
 income?:number;
 cumulativeIncome?:number;
 projectedBalance:number|null;
 additionalTopUp:number|null;
 cumulativeTopUp:number|null;
 undatedExpenses:number;
 calculationStatus:AccountFundingAccount['calculationStatus'];
};
export type FundingBusinessDay={
 business:Business;
 expenses:number;
 income?:number;
 unassignedExpenses:number;
 accounts:FundingAccountDay[];
};
export type FundingDay={
 date:string;
 accounts:FundingAccountDay[];
 businesses:FundingBusinessDay[];
 expenses:number;
 income?:number;
 additionalTopUp:number|null;
 cumulativeTopUp:number|null;
 knownAdditionalTopUp:number;
 knownCumulativeTopUp:number;
 unknownAccountCount:number;
};
export type FundingTimeline={
 range:DateRange;
 days:FundingDay[];
 undatedExpenses:number;
 unassignedExpenses:number;
 unknownAccountCount:number;
 missingAccountBusinessCount:number;
};

const isDatedInRange=(item:AccountFundingItem,range:DateRange)=>item.date!==null&&!!parseFinanceDate(item.date)&&item.date>=range.from&&item.date<=range.to;
const isUndatedInRange=(item:AccountFundingItem,range:DateRange)=>item.date===null&&(!item.from||item.from<=range.to)&&(!item.to||item.to>=range.from);
const sumItems=(items:AccountFundingItem[])=>items.reduce((sum,item)=>sum+item.amount,0);

/**
 * Date-level funding uses the supplied snapshot and remaining dated outflows.
 * With a current balance cutoff, past dates are never presented as funding days.
 * Selecting a day in the UI must not reset that starting balance.
 * Additional funding assumes earlier suggested top-ups were made; the projected
 * balance excludes all top-ups and business reserves. Explicit provider income
 * starts on its own future date; ordinary registered income remains excluded.
 * Undated budgets remain separate instead of being assigned an invented date.
 */
export function buildFundingTimeline(businesses:AccountFundingBusiness[],range:DateRange,asOf?:string):FundingTimeline {
 if(!isValidDateRange(range))throw new RangeError('추가 입금 계획의 기간을 확인해주세요.');
 if(asOf&&!parseFinanceDate(asOf))throw new RangeError('현재 잔액 기준일을 확인해주세요.');
 const firstDate=asOf&&asOf>range.from?asOf:range.from;
 const states=businesses.flatMap(({business,accounts})=>accounts.map(source=>{
  const byDate=new Map<string,AccountFundingItem[]>();
  for(const item of source.items)if(isDatedInRange(item,range)){
   const date=item.date!;
   byDate.set(date,[...(byDate.get(date)??[]),item]);
  }
  // A confirmed unpaid tax keeps its original deadline. Do not silently drop
  // an overdue amount or pretend a new payment date was provided.
  const overdueTax=source.items.some(item=>item.paymentKind==='tax'&&item.paymentStatus!=='paid'&&item.date!==null&&item.date<firstDate);
  const available=source.snapshot.balance!==null&&Number.isFinite(source.snapshot.balance)&&source.calculationStatus!=='unassigned'&&source.expenses!==null&&!overdueTax;
  const incomeByDate=new Map<string,number>();
  for(const item of source.scheduledIncome??[])if(item.date>=firstDate&&item.date<=range.to&&(!asOf||item.date>asOf)&&Number.isSafeInteger(item.amount)&&item.amount>0)incomeByDate.set(item.date,(incomeByDate.get(item.date)??0)+item.amount);
  return {business,source,byDate,incomeByDate,available,cumulativeExpenses:0,cumulativeIncome:0,previousTopUp:0,undatedExpenses:sumItems(source.items.filter(item=>isUndatedInRange(item,range)))};
 }));
 const unassigned=businesses.flatMap(business=>business.unassignedItems).filter(item=>isDatedInRange(item,range)||isUndatedInRange(item,range));
 const unassignedByDate=new Map<string,number>();
 for(const item of unassigned)if(item.date!==null)unassignedByDate.set(item.date,(unassignedByDate.get(item.date)??0)+item.amount);
 const businessUnassignedByDate=businesses.map(({unassignedItems})=>{
  const byDate=new Map<string,number>();
  for(const item of unassignedItems)if(isDatedInRange(item,range))byDate.set(item.date!,(byDate.get(item.date!)??0)+item.amount);
  return byDate;
 });
 const unknownAccountCount=states.filter(state=>!state.available).length;
 const missingAccountBusinessCount=businesses.filter(business=>business.accounts.length===0).length;
 const incomplete=states.length===0||unknownAccountCount>0||missingAccountBusinessCount>0||unassigned.length>0||businesses.some(business=>business.unconfirmedItems?.length);
 const days:FundingDay[]=[];
 const cursor=parseFinanceDate(firstDate)!;
 for(let date=firstDate;date<=range.to;cursor.setDate(cursor.getDate()+1),date=formatFinanceDate(cursor)){
  const accounts=states.map((state):FundingAccountDay=>{
   const {source,business,byDate,available,undatedExpenses}=state;
   const items=byDate.get(date)??[];
   const expenses=sumItems(items);
   state.cumulativeExpenses+=expenses;
   const income=state.incomeByDate.get(date)??0;
   state.cumulativeIncome+=income;
   const projectedBalance=available?source.snapshot.balance!+state.cumulativeIncome-state.cumulativeExpenses:null;
   const cumulativeTopUp=projectedBalance===null?null:Math.max(state.previousTopUp,-projectedBalance,0);
   const additionalTopUp=cumulativeTopUp===null?null:Math.max(0,cumulativeTopUp-state.previousTopUp);
   state.previousTopUp=cumulativeTopUp??0;
   return {business,account:source.account,snapshot:source.snapshot,items:[...items],expenses,cumulativeExpenses:state.cumulativeExpenses,projectedBalance,additionalTopUp,cumulativeTopUp,undatedExpenses,calculationStatus:source.calculationStatus,...(source.scheduledIncome?.length?{income,cumulativeIncome:state.cumulativeIncome}:{})};
  });
  const knownAdditionalTopUp=accounts.reduce((sum,account)=>sum+(account.additionalTopUp??0),0);
  const knownCumulativeTopUp=accounts.reduce((sum,account)=>sum+(account.cumulativeTopUp??0),0);
  const dailyBusinesses=businesses.map(({business},index):FundingBusinessDay=>{
   const businessAccounts=accounts.filter(account=>account.business.id===business.id);
   const unassignedExpenses=businessUnassignedByDate[index].get(date)??0;
   const income=businessAccounts.reduce((sum,account)=>sum+(account.income??0),0);
   return {business,accounts:businessAccounts,expenses:businessAccounts.reduce((sum,account)=>sum+account.expenses,unassignedExpenses),unassignedExpenses,...(income?{income}:{})};
  });
  const income=accounts.reduce((sum,account)=>sum+(account.income??0),0);
  days.push({date,accounts,businesses:dailyBusinesses,expenses:accounts.reduce((sum,account)=>sum+account.expenses,unassignedByDate.get(date)??0),additionalTopUp:incomplete?null:knownAdditionalTopUp,cumulativeTopUp:incomplete?null:knownCumulativeTopUp,knownAdditionalTopUp,knownCumulativeTopUp,unknownAccountCount,...(income?{income}:{})});
  if(date===range.to)break;
 }
 return {range:{...range},days,undatedExpenses:states.reduce((sum,state)=>sum+state.undatedExpenses,sumItems(unassigned.filter(item=>item.date===null))),unassignedExpenses:sumItems(unassigned),unknownAccountCount,missingAccountBusinessCount};
}
