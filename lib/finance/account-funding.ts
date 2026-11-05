import type {BalanceSnapshot} from './balances';
import type {CashEstimateBusiness} from './cash-estimates';
import type {CashPlanBusiness} from './cash-plan';
import type {Account,Business} from './types';
import type {PaymentKind,PaymentStatus} from './cash-plan-edits';

export type AccountFundingItem={key:string;date:string|null;title:string;amount:number;from?:string;to?:string;note:string;paymentKind?:PaymentKind;paymentStatus?:PaymentStatus};
/** Verified future provider receivables; never a mutation of the bank balance. */
export type AccountFundingIncome={key:string;businessId:string;accountId:string;date:string;title:string;amount:number};
export type AccountFundingAccount={
 account:Account;
 snapshot:BalanceSnapshot;
 expenses:number|null;
 datedExpenses:number;
 undatedExpenses:number;
 afterExpenses:number|null;
 requiredTopUp:number|null;
 items:AccountFundingItem[];
 calculationStatus:'estimated'|'registered'|'unassigned';
 firstDatedShortfall:string|null;
 scheduledIncome?:AccountFundingIncome[];
 income?:number;
 afterIncome?:number|null;
};
export type AccountFundingBusiness={
 business:Business;
 accounts:AccountFundingAccount[];
 expenses:number;
 requiredTopUp:number|null;
 knownRequiredTopUp:number;
 unknownAccountCount:number;
 unassignedExpenses:number;
 unassignedItems:AccountFundingItem[];
 /** Past registered schedules cannot be matched to a payment or bank account. */
 unconfirmedItems?:AccountFundingItem[];
};

const compareText=(left:string,right:string)=>left<right?-1:left>right?1:0;
const compareItems=(left:AccountFundingItem,right:AccountFundingItem)=>{
 if(left.date===null&&right.date!==null)return 1;
 if(left.date!==null&&right.date===null)return -1;
 return compareText(left.date??left.from??'',right.date??right.from??'')||compareText(left.title,right.title)||compareText(left.key,right.key);
};

function firstShortfall(balance:number|null,items:AccountFundingItem[],undatedExpenses:number,income:AccountFundingIncome[]=[]):string|null {
 // Period budgets have no reliable position on the timeline. Do not present a
 // later dated payment as the first shortfall while such a budget is pending.
 if(balance===null||balance<0||undatedExpenses>0)return null;
 const byDate=new Map<string,number>();
 for(const item of items)if(item.date!==null)byDate.set(item.date,(byDate.get(item.date)??0)+item.amount);
 for(const item of income)byDate.set(item.date,(byDate.get(item.date)??0)-item.amount);
 let remaining=balance;
 for(const [date,amount] of [...byDate].sort(([left],[right])=>compareText(left,right))){
  remaining-=amount;
  if(remaining<0)return date;
 }
 return null;
}

/**
 * A read-only allocation of an existing cash plan to its actual bank accounts.
 * An account's surplus never offsets another account's shortage. Only explicitly
 * supplied provider receipts can fund their own account from the specified date.
 * Ordinary registered income and business reserves remain excluded.
 */
export function buildAccountFunding(plans:CashPlanBusiness[],estimates:Map<string,CashEstimateBusiness>,basis:'registered'|'estimated',incoming:AccountFundingIncome[]=[]):AccountFundingBusiness[] {
 return plans.map(plan=>{
  const byAccount=new Map(plan.accounts.map(({account})=>[account.id,[] as AccountFundingItem[]]));
  const unassignedItems:AccountFundingItem[]=[];
  const unconfirmedItems:AccountFundingItem[]=basis==='registered'?(plan.unconfirmedExpenses??[]).map(item=>({
   key:JSON.stringify(['unconfirmed',item.recurringId,item.date]),date:item.date,title:item.title,amount:item.amount,note:'지급 여부 확인 필요 · 현재 잔액에서 재차감하지 않음',
  })):[];
  const estimate=estimates.get(plan.business.id);
  const assign=(accountId:string|null|undefined,businessId:string,item:AccountFundingItem)=>{
   const target=businessId===plan.business.id&&accountId?byAccount.get(accountId):undefined;
   if(target)target.push(item);else unassignedItems.push({...item,note:`${item.note} · 출금 계좌 확인 필요`});
  };
  const payment=(item:{paymentKind?:PaymentKind;paymentStatus?:PaymentStatus})=>({paymentKind:item.paymentKind,paymentStatus:item.paymentStatus});
  if(basis==='estimated'){
   for(const [index,item] of (estimate?.dated??[]).entries())assign(item.accountId,item.businessId,{
    key:JSON.stringify(['estimated',item.groupKey,item.date,index]),date:item.date,title:item.title,amount:item.amount,...payment(item),note:`${item.sourceType==='manual'?'직접 추가':'예상일'} · 남은 출금 예산${item.recordedAmount?` · 반영 출금 ${item.recordedAmount.toLocaleString('ko-KR')}원`:''}${item.memo?` · ${item.memo}`:''}`,
   });
   for(const [index,item] of (estimate?.undated??[]).entries())assign(item.accountId,item.businessId,{
    key:JSON.stringify(['budget',item.groupKey,item.month,index]),date:null,title:item.title,amount:item.amount,from:item.from,to:item.to,...payment(item),note:`${item.sourceType==='manual'?'직접 추가 · ':''}${item.status==='date-passed'?`예상일 ${item.expectedDate} 경과 · 지급 확인 필요`:'날짜 미정 · 남은 기간 예산'}${item.recordedAmount?` · 반영 출금 ${item.recordedAmount.toLocaleString('ko-KR')}원`:''}${item.memo?` · ${item.memo}`:''}`,
   });
  }else{
   // Use only an explicitly saved plan account. An unedited registration still
   // has no account, even if its business happens to have a single bank account.
   for(const [index,item] of plan.scheduledExpenses.entries())assign(item.accountId,item.businessId,{
    key:JSON.stringify(['registered',item.recurringId,item.date,index]),date:item.date,title:item.title,amount:item.amount,...payment(item),note:`${item.sourceType==='manual'?'직접 추가':item.frequency==='monthly'?'월 반복':'일회성'}${item.memo?` · ${item.memo}`:''}`,
   });
   for(const item of plan.undatedExpenses??[])assign(item.accountId,item.businessId,{
    key:item.key,date:null,title:item.title,amount:item.amount,from:item.from,to:item.to,...payment(item),
    note:`${item.sourceType==='manual'?'직접 추가':'등록 예정'} · ${item.expectedDate?`${item.expectedDate} 경과 · 지급 확인 필요`:'날짜 미정'}${item.memo?` · ${item.memo}`:''}`,
   });
  }
  unassignedItems.sort(compareItems);
  const registeredUnassigned=basis==='registered'&&(unassignedItems.length>0||unconfirmedItems.length>0);
  const accounts=plan.accounts.map(({account,snapshot}):AccountFundingAccount=>{
   const items=(byAccount.get(account.id)??[]).sort(compareItems);
   const datedExpenses=items.reduce((sum,item)=>sum+(item.date!==null?item.amount:0),0);
   const undatedExpenses=items.reduce((sum,item)=>sum+(item.date===null?item.amount:0),0);
   const expenses=registeredUnassigned?null:datedExpenses+undatedExpenses;
   const afterExpenses=snapshot.balance===null||expenses===null?null:snapshot.balance-expenses;
   const scheduledIncome=incoming.filter(item=>item.businessId===plan.business.id&&item.accountId===account.id&&Number.isSafeInteger(item.amount)&&item.amount>0);
   const income=scheduledIncome.reduce((sum,item)=>sum+item.amount,0);
   // Reserve undated budgets before incoming funds. Later settlements cannot
   // erase an earlier shortfall, even when the period ends with a surplus.
   let requiredTopUp=afterExpenses===null?null:Math.max(0,-afterExpenses);
   if(scheduledIncome.length&&snapshot.balance!==null&&expenses!==null){
    const byDate=new Map<string,number>();
    for(const item of items)if(item.date!==null)byDate.set(item.date,(byDate.get(item.date)??0)-item.amount);
    for(const item of scheduledIncome)byDate.set(item.date,(byDate.get(item.date)??0)+item.amount);
    let balance=snapshot.balance-undatedExpenses,peak=Math.max(0,-balance);
    for(const [,change] of [...byDate].sort(([a],[b])=>compareText(a,b))){balance+=change;peak=Math.max(peak,-balance);}
    requiredTopUp=peak;
   }
   return {
    account,snapshot,expenses,datedExpenses,undatedExpenses,afterExpenses,
    requiredTopUp,items,
    ...(scheduledIncome.length?{scheduledIncome,income,afterIncome:afterExpenses===null?null:afterExpenses+income}:{}),
    calculationStatus:registeredUnassigned?'unassigned':basis,
    firstDatedShortfall:registeredUnassigned?null:firstShortfall(snapshot.balance,items,undatedExpenses,scheduledIncome),
   };
  });
  const unassignedExpenses=unassignedItems.reduce((sum,item)=>sum+item.amount,0);
  const expenses=accounts.reduce((sum,item)=>sum+item.datedExpenses+item.undatedExpenses,unassignedExpenses);
  const unknownAccountCount=accounts.filter(item=>item.requiredTopUp===null).length;
  const knownRequiredTopUp=accounts.reduce((sum,item)=>sum+(item.requiredTopUp??0),0);
  return {
   business:plan.business,accounts,expenses,knownRequiredTopUp,unknownAccountCount,unassignedExpenses,unassignedItems,unconfirmedItems,
   requiredTopUp:accounts.length===0||unknownAccountCount>0||unassignedItems.length>0||unconfirmedItems.length>0?null:knownRequiredTopUp,
  };
 });
}
