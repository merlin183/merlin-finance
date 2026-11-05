import {buildAccountFunding,type AccountFundingBusiness,type AccountFundingItem,type AccountFundingIncome} from './account-funding';
import type {BalanceSnapshot} from './balances';
import type {CashEstimateBusiness} from './cash-estimates';
import type {CashPlanBusiness} from './cash-plan';
import {isValidDateRange,parseFinanceDate,type DateRange} from './date-range';
import {buildFundingTimeline,type FundingAccountDay,type FundingTimeline} from './funding-timeline';
import type {Account} from './types';

export type FundingReportRow=FundingAccountDay&{
 date:string;
 initialShortfall:boolean;
 categoryNames:string[];
};
export type FundingReportUndatedAccount={
 account:Account;
 snapshot:BalanceSnapshot;
 expenses:number;
 items:AccountFundingItem[];
 categoryNames:string[];
};
export type FundingReportBusiness={
 funding:AccountFundingBusiness;
 timeline:FundingTimeline;
 balance:number|null;
 knownBalance:number;
 requiredTopUp:number|null;
 knownRequiredTopUp:number;
 datedRequiredTopUp:number|null;
 knownDatedRequiredTopUp:number;
 /** Earliest known positive increment, not a confirmed payment deadline. */
 earliestFundingDate:string|null;
 fundingDateIncomplete:boolean;
 rows:FundingReportRow[];
 undatedAccounts:FundingReportUndatedAccount[];
 unassignedItems:AccountFundingItem[];
};
export type FundingReport={
 range:DateRange;
 basis:'registered'|'estimated';
 businesses:FundingReportBusiness[];
 requiredTopUp:number|null;
 knownRequiredTopUp:number;
 datedRequiredTopUp:number|null;
 knownDatedRequiredTopUp:number;
 earliestFundingDate:string|null;
 unknownAccountCount:number;
 missingAccountBusinessCount:number;
 undatedExpenses:number;
 unassignedExpenses:number;
};

const compareText=(left:string,right:string)=>left<right?-1:left>right?1:0;
const earliest=(dates:(string|null)[])=>dates.filter((date):date is string=>date!==null).sort(compareText)[0]??null;
const completeTotal=(values:(number|null)[])=>values.length===0||values.some(value=>value===null)?null:values.reduce<number>((sum,value)=>sum+value!,0);

/**
 * A read-only report over the existing account and day calculations. The range
 * must be the range used to build the estimates; undated budgets are already
 * apportioned by that builder and must not be apportioned a second time here.
 */
export function buildFundingReport(plans:CashPlanBusiness[],estimates:Map<string,CashEstimateBusiness>,basis:'registered'|'estimated',range:DateRange,asOf?:string,incoming:AccountFundingIncome[]=[]):FundingReport {
 if(!isValidDateRange(range))throw new RangeError('필요자금 확인 기간을 확인해주세요.');
 if(asOf&&!parseFinanceDate(asOf))throw new RangeError('현재 잔액 기준일을 확인해주세요.');
 const inRange=(date:string)=>!!parseFinanceDate(date)&&date>=range.from&&date<=range.to;
 const scopedPlans=plans.map(plan=>({...plan,scheduledExpenses:plan.scheduledExpenses.filter(item=>inRange(item.date))}));
 const scopedEstimates=new Map([...estimates].map(([id,estimate])=>[id,{
  ...estimate,
  dated:estimate.dated.filter(item=>inRange(item.date)),
  undated:estimate.undated.filter(item=>item.from<=range.to&&item.to>=range.from),
 }]));
 const source=buildAccountFunding(scopedPlans,scopedEstimates,basis,incoming.filter(item=>inRange(item.date)&&(!asOf||item.date>asOf)));
 const businesses=source.map((funding):FundingReportBusiness=>{
  const timeline=buildFundingTimeline([funding],range,asOf);
  const estimate=basis==='estimated'?scopedEstimates.get(funding.business.id):undefined;
  const groups=new Map((estimate?.groups??[]).filter(group=>group.businessId===funding.business.id).map(group=>[group.key,group]));
  const categories=(accountId:string,date:string|null)=>{
   const items=date===null?estimate?.undated??[]:(estimate?.dated??[]).filter(item=>item.date===date);
   const names=items.filter(item=>item.businessId===funding.business.id&&item.accountId===accountId).flatMap(item=>{
    const group=groups.get(item.groupKey);
    return group?.accountId===(item.sourceAccountId??item.accountId)?group.categoryNames:[];
   });
   return [...new Set(names)].sort(compareText);
  };
  const rows=timeline.days.flatMap(day=>day.accounts
   .filter(account=>(account.additionalTopUp!==null&&account.additionalTopUp>0)||(account.additionalTopUp===null&&account.expenses>0))
   .map((account):FundingReportRow=>({
    ...account,date:day.date,
    initialShortfall:day.date===timeline.days[0]?.date&&account.snapshot.balance!==null&&account.snapshot.balance<0,
    categoryNames:categories(account.account.id,day.date),
   })))
   .sort((left,right)=>compareText(left.date,right.date)||compareText(left.account.name,right.account.name)||compareText(left.account.id,right.account.id));
  const undatedAccounts=funding.accounts.filter(account=>account.undatedExpenses>0).map(account=>({
   account:account.account,snapshot:account.snapshot,expenses:account.undatedExpenses,
   items:account.items.filter(item=>item.date===null),categoryNames:categories(account.account.id,null),
  }));
  const knownBalance=funding.accounts.reduce((sum,account)=>sum+(account.snapshot.balance??0),0);
  const lastDay=timeline.days.at(-1);
  return {
   funding,timeline,knownBalance,
   balance:funding.accounts.length>0&&funding.accounts.every(account=>account.snapshot.balance!==null)?knownBalance:null,
   requiredTopUp:funding.requiredTopUp,knownRequiredTopUp:funding.knownRequiredTopUp,
   datedRequiredTopUp:lastDay?.cumulativeTopUp??null,knownDatedRequiredTopUp:lastDay?.knownCumulativeTopUp??0,
   earliestFundingDate:earliest(rows.filter(row=>row.additionalTopUp!==null&&row.additionalTopUp>0).map(row=>row.date)),
   fundingDateIncomplete:!lastDay||timeline.unknownAccountCount>0||timeline.missingAccountBusinessCount>0||funding.unassignedItems.length>0||!!funding.unconfirmedItems?.length||timeline.undatedExpenses>0,
   rows,undatedAccounts,unassignedItems:[...funding.unassignedItems],
  };
 });
 return {
  range:{...range},basis,businesses,
  requiredTopUp:completeTotal(businesses.map(business=>business.requiredTopUp)),
  knownRequiredTopUp:businesses.reduce((sum,business)=>sum+business.knownRequiredTopUp,0),
  datedRequiredTopUp:completeTotal(businesses.map(business=>business.datedRequiredTopUp)),
  knownDatedRequiredTopUp:businesses.reduce((sum,business)=>sum+business.knownDatedRequiredTopUp,0),
  earliestFundingDate:earliest(businesses.map(business=>business.earliestFundingDate)),
  unknownAccountCount:businesses.reduce((sum,business)=>sum+business.funding.unknownAccountCount,0),
  missingAccountBusinessCount:businesses.filter(business=>business.funding.accounts.length===0).length,
  undatedExpenses:businesses.reduce((sum,business)=>sum+business.timeline.undatedExpenses,0),
  unassignedExpenses:businesses.reduce((sum,business)=>sum+business.funding.unassignedExpenses,0),
 };
}
