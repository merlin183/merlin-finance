import {buildCashEstimateBudgetsForRange,cashEstimateSourceKey,cashPlanInternalOrLoan,type CashEstimateOptions,type CashEstimates,type CashEstimateGroup,type CashUndatedBudget} from './cash-estimates';
import {buildCurrentCashPlanForRange,type CashPlan,type CashPlanOccurrence,type CashPlanUndatedExpense} from './cash-plan';
import type {CashPlanEdit,PaymentKind,PaymentStatus} from './cash-plan-edits';
import {cashPlanMemoDisplay} from './cash-plan-memo';
import {cashPlanPaymentConfirmation} from './cash-plan-payment-confirmation';
import {parseFinanceDate,type DateRange} from './date-range';
import {calendarMonthRange} from './transaction-calendar';
import type {Dataset,Transaction} from './types';
import {reconcileCashPlanActuals,type BankPlanCoverageStatus} from './clobe-plan-actuals';
import {cashPlanSeriesActive,cashPlanSeriesKey,isMonthlyFixedCostEdit} from './cash-plan-series';
import {resolveCashPlanSeriesForMonth} from './cash-plan-series-revision';
import {cashEstimateSourceIdentity,readCashPlanCategory} from './cash-plan-category';
import {readFixedCostMemo} from './cash-plan-series-memo';

export type CashPlanEditorItem={
 key:string;businessId:string;source_type:'estimated'|'registered'|'manual';source_key:string;month:string;
 title:string;accountId:string|null;sourceAccountId:string|null;date:string|null;
 categoryId:string|null;categoryName:string|null;sourceCategoryId:string|null;categoryOverrideId:string|null;
 /** Saved amount always means the whole month's budget, not a sticky remainder. */
 amount:number;recordedAmount:number;remainingAmount:number;memo:string;excluded:boolean;inRange:boolean;
 paymentKind?:PaymentKind;paymentStatus?:PaymentStatus;
 confirmedAmount:number|null;confirmedDate:string|null;confirmationComplete:boolean;
 recordedTransactions?:Transaction[];bankTransactionIds?:string[];bankCoverage?:BankPlanCoverageStatus;reconciliationReason?:string|null;recordedKnown?:boolean;recordedAmbiguous?:boolean;
 edit?:CashPlanEdit;globalEdit?:CashPlanEdit;
 seriesId?:string;seriesKind?:'operating'|'installment';
 seriesExcludedFrom?:string|null;
 categoryConflictReason?:string|null;
};
export type EditableCashPlanItem=CashPlanEditorItem;
export type EditableCashPlan={plan:CashPlan;estimates:CashEstimates;items:CashPlanEditorItem[]};

type Source=Omit<CashPlanEditorItem,'key'|'recordedAmount'|'remainingAmount'|'excluded'|'inRange'|'edit'|'globalEdit'|'confirmedAmount'|'confirmedDate'|'confirmationComplete'|'recordedTransactions'|'bankTransactionIds'|'bankCoverage'|'reconciliationReason'|'recordedKnown'|'recordedAmbiguous'|'categoryId'|'categoryName'|'categoryOverrideId'>;
const keyFor=(businessId:string,type:CashPlanEditorItem['source_type'],sourceKey:string,month:string)=>JSON.stringify([businessId,type,sourceKey,month]);
const compareText=(left:string,right:string)=>left<right?-1:left>right?1:0;

function monthsInRange(range:DateRange):string[]{
 const monthIndex=(date:string)=>Number(date.slice(0,4))*12+Number(date.slice(5,7))-1;
 return Array.from({length:monthIndex(range.to)-monthIndex(range.from)+1},(_,index)=>{
  const month=monthIndex(range.from)+index;
  return `${String(Math.floor(month/12)).padStart(4,'0')}-${String(month%12+1).padStart(2,'0')}`;
 });
}

function sourceAccount(sourceKey:string,businessId:string):string|null {
 return cashEstimateSourceIdentity(sourceKey,businessId)?.accountId??null;
}

function groupSource(group:CashEstimateGroup,month:string):Source {
 const monthEnd=calendarMonthRange(month).to;
 return {businessId:group.businessId,source_type:'estimated',source_key:group.key,month,title:group.label,
  accountId:group.accountId,sourceAccountId:group.accountId,sourceCategoryId:group.categoryId,
  date:group.expectedDay===null?null:`${month}-${String(Math.min(group.expectedDay,Number(monthEnd.slice(-2)))).padStart(2,'0')}`,
  amount:group.monthlyAverage,memo:'',
 };
}

/** One pure shared model for tables, account funding, reports and forecasts.
 * Edits never mutate transactions. Actual spending always keeps its original
 * business/account/source identity even when the planned payment bank changes. */
export function buildEditableCashPlan(data:Dataset,range:DateRange,asOf:string,edits:readonly CashPlanEdit[],options:CashEstimateOptions={}):EditableCashPlan {
 const plan=buildCurrentCashPlanForRange(data,range,asOf);
 const original=buildCashEstimateBudgetsForRange(data,range,asOf,options);
 const categoryById=new Map(data.categories.map(category=>[category.id,category]));
 const sourceCategory=(key:string,memo=''):string|null=>{
  const identity=cashEstimateSourceIdentity(key);if(!identity)return null;
  if(identity.categoryId)return categoryById.has(identity.categoryId)?identity.categoryId:null;
  const candidates=new Set(original.businesses.flatMap(business=>business.groups).filter(group=>cashEstimateSourceIdentity(group.key)?.legacyKey===identity.legacyKey).map(group=>group.categoryId));
  if(candidates.size===1)return [...candidates][0];
  if(candidates.size===0){
   const history=new Set(data.transactions.filter(row=>row.direction==='out'&&row.txn_date>=original.basis.from&&row.txn_date<=original.basis.to&&cashEstimateSourceKey(row)===identity.legacyKey&&!cashPlanInternalOrLoan(row,categoryById.get(row.category_id??''))).map(row=>categoryById.has(row.category_id??'')?row.category_id:null));
   if(history.size===1)return [...history][0];
  }
  const fixed=readFixedCostMemo(memo),category=fixed?data.categories.filter(value=>value.name===fixed.groupLabel):[];
  return category.length===1?category[0].id:null;
 };
 const categoryFields=(source:Source,memo:string)=>{
  const override=readCashPlanCategory(memo,data.categories),categoryId=override?.categoryId??source.sourceCategoryId;
  return {categoryId,categoryName:categoryId?categoryById.get(categoryId)?.name??null:null,categoryOverrideId:override?.categoryId??null};
 };
 const months=monthsInRange(range),monthSet=new Set(months);
 const businesses=new Set(data.businesses.map(business=>business.id));
 const accountOwners=new Map(data.accounts.map(account=>[account.id,account.business_id]));
 const validAccount=(accountId:string|null,businessId:string)=>accountId&&accountOwners.get(accountId)===businessId?accountId:null;
 const sources=new Map<string,Source>();
 const monthly=new Map<string,CashPlanEdit>(),global=new Map<string,CashPlanEdit>();
 const putSource=(source:Source)=>sources.set(keyFor(source.businessId,source.source_type,source.source_key,source.month),source);
 for(const business of original.businesses)for(const group of business.groups)for(const month of months)putSource(groupSource(group,month));
 for(const recurring of data.recurring){
  if(recurring.direction!=='out'||!businesses.has(recurring.business_id))continue;
  for(const month of months){
   const last=calendarMonthRange(month).to;
   const date=recurring.frequency==='once'?recurring.start_date:`${month}-${String(Math.min(recurring.day,Number(last.slice(-2)))).padStart(2,'0')}`;
   if(!parseFinanceDate(date)||!date.startsWith(`${month}-`)||date<recurring.start_date||(recurring.end_date&&date>recurring.end_date))continue;
   putSource({businessId:recurring.business_id,source_type:'registered',source_key:recurring.id,month,title:recurring.title,accountId:null,sourceAccountId:null,sourceCategoryId:null,date,amount:recurring.amount,memo:''});
  }
 }
 const seriesByKey=new Map((data.cash_plan_series??[]).map(series=>[cashPlanSeriesKey(series),series]));
 for(const series of seriesByKey.values()){
  if(!businesses.has(series.business_id))continue;
  for(const month of months){
   if(series.end_month&&month>series.end_month){
    const identity=cashEstimateSourceIdentity(series.source_key);
    for(const [key,source] of sources)if(source.businessId===series.business_id&&source.month===month&&source.source_type===series.source_type
     &&(source.source_key===series.source_key||identity&&!identity.categoryId&&cashEstimateSourceIdentity(source.source_key)?.legacyKey===identity.legacyKey))sources.delete(key);
    continue;
   }
   if(!cashPlanSeriesActive(series,month))continue;
   const profile=resolveCashPlanSeriesForMonth(series,month,data.cash_plan_series_revisions)!;
   const identity=keyFor(series.business_id,series.source_type,series.source_key,month),previous=sources.get(identity);
   putSource({businessId:series.business_id,source_type:series.source_type,source_key:series.source_key,month,title:profile.title,
    accountId:validAccount(profile.accountId,series.business_id),sourceAccountId:previous?.sourceAccountId??(series.source_type==='estimated'?sourceAccount(series.source_key,series.business_id):null),
    sourceCategoryId:previous?.sourceCategoryId??sourceCategory(series.source_key,profile.memo),
    date:profile.date,amount:profile.amount,memo:profile.memo,seriesId:series.id,seriesKind:series.kind,seriesExcludedFrom:profile.revisionExcludedFrom});
  }
 }
 for(const edit of edits){
  if(!businesses.has(edit.business_id)||!['estimated','registered','manual'].includes(edit.source_type))continue;
  if(edit.month==='*'){
   if(edit.source_type==='manual'||!edit.excluded)continue;
   global.set(keyFor(edit.business_id,edit.source_type,edit.source_key,'*'),edit);
   continue;
  }
  if(!monthSet.has(edit.month)||!Number.isSafeInteger(edit.amount)||edit.amount<0
   ||(edit.plan_date!==null&&(!parseFinanceDate(edit.plan_date)||!edit.plan_date.startsWith(`${edit.month}-`))))continue;
  const series=seriesByKey.get(cashPlanSeriesKey(edit));
  if(series&&!cashPlanSeriesActive(series,edit.month)&&edit.month>=series.start_month)continue;
  const key=keyFor(edit.business_id,edit.source_type,edit.source_key,edit.month);
  const previous=monthly.get(key);
  if(previous&&previous.version>edit.version)continue;
  monthly.set(key,edit);
  // Persist a saved plan even when rolling source history no longer produces it.
  if(!sources.has(key))putSource({businessId:edit.business_id,source_type:edit.source_type,source_key:edit.source_key,month:edit.month,
   title:edit.title,accountId:edit.account_id,sourceAccountId:edit.source_type==='estimated'?sourceAccount(edit.source_key,edit.business_id):null,
   sourceCategoryId:edit.source_type==='estimated'?sourceCategory(edit.source_key,edit.memo):null,
   date:edit.plan_date,amount:edit.amount,memo:edit.memo,...(isMonthlyFixedCostEdit(edit)?{seriesKind:'operating' as const}:{}),
  });
 }
 // Keep all-month exclusions recoverable even after their source leaves the
 // rolling window; they are not turned into actual or active payment records.
 for(const edit of global.values())for(const month of months){
  const key=keyFor(edit.business_id,edit.source_type,edit.source_key,month);
  if(!sources.has(key))putSource({businessId:edit.business_id,source_type:edit.source_type,source_key:edit.source_key,month,
   title:edit.title,accountId:edit.account_id,sourceAccountId:edit.source_type==='estimated'?sourceAccount(edit.source_key,edit.business_id):null,
   sourceCategoryId:edit.source_type==='estimated'?sourceCategory(edit.source_key,edit.memo):null,
   date:null,amount:0,memo:edit.memo,
  });
 }
 // Saved identities remain authoritative across category partition changes.
 // Never copy one historic amount/confirmation into every category descendant.
 const savedScopes=[...sources].filter(([key,source])=>source.source_type==='estimated'&&(monthly.has(key)||source.seriesId||global.has(keyFor(source.businessId,source.source_type,source.source_key,'*'))));
 for(const [key,source] of [...sources]){
  if(source.source_type!=='estimated')continue;
  const identity=cashEstimateSourceIdentity(source.source_key);if(!identity)continue;
  const ownSaved=monthly.has(key)||!!source.seriesId;
  const overlap=savedScopes.some(([savedKey,saved])=>{
   if(savedKey===key||saved.month!==source.month||saved.businessId!==source.businessId)return false;
   const originalIdentity=cashEstimateSourceIdentity(saved.source_key);
   if(originalIdentity?.legacyKey!==identity.legacyKey)return false;
   if(!originalIdentity.categoryId&&identity.categoryId){
    if(!ownSaved)return true;
    const savedCategory=categoryFields(saved,monthly.get(savedKey)?.memo??saved.memo).categoryId;
    const ownCategory=categoryFields(source,monthly.get(key)?.memo??source.memo).categoryId;
    return !!global.get(keyFor(saved.businessId,saved.source_type,saved.source_key,'*'))?.excluded||!savedCategory||!ownCategory||savedCategory===ownCategory;
   }
   return !ownSaved&&!identity.categoryId&&saved.sourceCategoryId===source.sourceCategoryId;
  });
  if(overlap){
   if(ownSaved)source.categoryConflictReason='같은 원본의 기존 예산과 겹쳐 합계에서 보류했습니다. 기존 예산의 계정과목을 구분해주세요.';
   else sources.delete(key);
  }
 }
 const globalFor=(source:Source)=>global.get(keyFor(source.businessId,source.source_type,source.source_key,'*'))
  ??(source.source_type==='estimated'?global.get(keyFor(source.businessId,source.source_type,cashEstimateSourceIdentity(source.source_key)?.legacyKey??source.source_key,'*')):undefined);
 const actualTargets=[...sources].map(([key,source])=>{
  const edit=monthly.get(key),globalEdit=globalFor(source),date=edit?edit.plan_date:source.date;
  const active=!globalEdit?.excluded&&!source.seriesExcludedFrom&&!edit?.excluded&&!source.categoryConflictReason&&(date===null||(date>=range.from&&date<=range.to));
  return {...source,...categoryFields(source,edit?.memo??source.memo),key,active,...(edit?{title:edit.title,accountId:validAccount(edit.account_id,source.businessId)}:{}),paymentKind:edit?.payment_kind??'general' as const};
 });
 const actualMatches=reconcileCashPlanActuals(data,asOf,actualTargets,original,options);
 const estimates:CashEstimates={...original,businesses:original.businesses.map(business=>({...business,total:0,dated:[],undated:[]}))};
 const estimateByBusiness=new Map(estimates.businesses.map(business=>[business.business.id,business]));
 const scheduled=new Map<string,CashPlanOccurrence[]>(),unconfirmed=new Map<string,CashPlanOccurrence[]>(),undated=new Map<string,CashPlanUndatedExpense[]>();
 const items:CashPlanEditorItem[]=[];
 for(const [key,source] of sources){
  const edit=monthly.get(key),globalEdit=globalFor(source);
  const full=calendarMonthRange(source.month),from=range.from>full.from?range.from:full.from,to=range.to<full.to?range.to:full.to;
  const monthDays=Number(full.to.slice(-2)),coveredDays=Number(to.slice(-2))-Number(from.slice(-2))+1;
  const effective={...source,...categoryFields(source,edit?.memo??source.memo),...(edit?{title:edit.title,accountId:edit.account_id,date:edit.plan_date,amount:edit.amount,memo:edit.memo}:{}),paymentKind:edit?.payment_kind??'general',paymentStatus:edit?.payment_status??'pending'};
  effective.accountId=validAccount(effective.accountId,source.businessId);
  const excluded=!!(globalEdit?.excluded||source.seriesExcludedFrom||edit?.excluded||source.categoryConflictReason);
  const inRange=effective.date===null||(effective.date>=range.from&&effective.date<=range.to);
  const actualMatch=actualMatches.get(key)!;
  const sumRecorded=(start:string,end:string)=>actualMatch.transactions.reduce((sum,row)=>sum+(row.txn_date>=start&&row.txn_date<=end?row.amount:0),0);
  const wholeRecorded=sumRecorded(full.from,full.to);
  const scopedRecorded=sumRecorded(effective.date===null?from:full.from,effective.date===null?to:full.to);
  const confirmation=cashPlanPaymentConfirmation(edit,asOf);
  const scopedConfirmed=confirmation&&(effective.date!==null||(confirmation.date>=from&&confirmation.date<=to))?confirmation.amount:0;
  // A return belongs to its own date, independently of the date of the last
  // cumulative payment. Keep gross evidence intact for actual rows/calendars.
  const returnedInScope=confirmation?.returnedDate!==undefined&&confirmation.returnedDate>=(effective.date===null?from:full.from)&&confirmation.returnedDate<=(effective.date===null?to:full.to);
  const effectiveRecorded=Math.max(0,Math.max(scopedRecorded,scopedConfirmed)-(returnedInScope?confirmation?.returnedAmount??0:0));
  const originalAmount=effective.date===null?Math.round(effective.amount*coveredDays/monthDays):effective.amount;
  const paid=(effective.paymentKind==='tax'&&effective.paymentStatus==='paid')||confirmation?.complete;
  const remainingAmount=!excluded&&inRange&&!paid?Math.max(0,originalAmount-effectiveRecorded):0;
  const editor:CashPlanEditorItem={...effective,key,recordedAmount:Math.max(wholeRecorded,confirmation?.amount??0),remainingAmount,excluded,inRange,
   confirmedAmount:confirmation?.amount??null,confirmedDate:confirmation?.date??null,confirmationComplete:confirmation?.complete??false,
   recordedTransactions:actualMatch.transactions,bankTransactionIds:[...actualMatch.bankTransactionIds],bankCoverage:actualMatch.coverage,reconciliationReason:source.categoryConflictReason??actualMatch.reason,recordedKnown:actualMatch.known,recordedAmbiguous:actualMatch.ambiguous,
   ...(edit?{edit}:{}),...(globalEdit?{globalEdit}:{})};
  items.push(editor);
  if(excluded||!inRange||remainingAmount===0)continue;
  const overdue=effective.date!==null&&effective.date<asOf;
  const displayMemo=cashPlanMemoDisplay(effective.memo);
  if(source.source_type==='estimated'||source.source_type==='manual'){
   const business=estimateByBusiness.get(source.businessId)!;
   const common={groupKey:source.source_key,businessId:source.businessId,accountId:effective.accountId??'',title:effective.title,paymentKind:effective.paymentKind,paymentStatus:effective.paymentStatus,
    amount:remainingAmount,originalAmount,recordedAmount:effectiveRecorded,memo:displayMemo,sourceType:source.source_type,sourceAccountId:source.sourceAccountId??undefined,
   };
   if(effective.date===null||(overdue&&effective.paymentKind!=='tax')){
    const item:CashUndatedBudget={...common,month:source.month,from,to,coveredDays,monthDays,monthlyAmount:effective.amount,kind:'period-budget',
     ...(overdue?{expectedDate:effective.date!,status:'date-passed' as const}:{}),
    };
    business.undated.push(item);
   }else business.dated.push({...common,date:effective.date});
   business.total+=remainingAmount;
  }
  if(source.source_type==='registered'||source.source_type==='manual'||source.seriesId){
   if(effective.date===null||((source.source_type==='manual'||source.seriesId||(source.source_type==='registered'&&(confirmation||wholeRecorded>0)))&&overdue&&effective.paymentKind!=='tax')){
    const list=undated.get(source.businessId)??[];
    list.push({key,businessId:source.businessId,accountId:effective.accountId,title:effective.title,amount:remainingAmount,month:source.month,from,to,memo:displayMemo,sourceType:source.source_type,paymentKind:effective.paymentKind,paymentStatus:effective.paymentStatus,...(overdue?{expectedDate:effective.date!}:{})});
    undated.set(source.businessId,list);
   }else{
    const target=source.source_type==='registered'&&effective.date<=asOf&&!confirmation&&wholeRecorded===0?unconfirmed:scheduled;
    const list=target.get(source.businessId)??[];
    list.push({date:effective.date,title:effective.title,amount:remainingAmount,direction:'out',frequency:source.source_type==='manual'?'once':data.recurring.find(item=>item.id===source.source_key)?.frequency??'once',recurringId:source.source_key,businessId:source.businessId,accountId:effective.accountId,memo:displayMemo,sourceType:source.source_type,paymentKind:effective.paymentKind,paymentStatus:effective.paymentStatus});
    target.set(source.businessId,list);
   }
  }
 }
 for(const business of estimates.businesses){
  business.dated.sort((left,right)=>compareText(left.date,right.date)||compareText(left.title,right.title)||compareText(left.groupKey,right.groupKey));
  business.undated.sort((left,right)=>compareText(left.month,right.month)||compareText(left.title,right.title)||compareText(left.groupKey,right.groupKey));
 }
 plan.businesses=plan.businesses.map(business=>{
  const scheduledExpenses=(scheduled.get(business.business.id)??[]).sort((left,right)=>compareText(left.date,right.date)||compareText(left.title,right.title));
  const unconfirmedExpenses=unconfirmed.get(business.business.id)??[],undatedExpenses=undated.get(business.business.id)??[];
  const expenses=[...scheduledExpenses,...undatedExpenses].reduce((sum,item)=>sum+item.amount,0);
  const confirmed=business.balance!==null&&unconfirmedExpenses.length===0;
  return {...business,scheduledExpenses,unconfirmedExpenses,undatedExpenses,expenses,
   afterExpenses:confirmed?business.balance!-expenses:null,
   projected:confirmed?business.balance!+business.income-expenses:null,
   available:confirmed?business.balance!-expenses-business.reserve:null,
  };
 });
 estimates.reminders=[
  '금액 수정은 해당 월의 전체 지출 예산에 적용하며 같은 원본 사업자·계좌·거래처의 반영 출금을 차감해 남은 예산을 계산합니다.',
  '계획에서 출금 계좌를 바꾸어도 이미 반영된 실적의 원본 계좌는 바뀌지 않습니다. 원본 거래내역을 수정하거나 다른 계좌의 출금을 추측해 연결하지 않습니다.',
  '은행 조회 출금은 같은 사업자·원본 계좌·원본 거래처에 연결해 남은 예산을 갱신합니다. 직접 추가·등록 항목도 정확한 거래처가 한 항목에만 일치하면 연결하며, 중복 후보는 직접 확인합니다.',
  '사용자 출금 확인은 통장 거래와 현재 잔액을 바꾸지 않습니다. 자동 실적과 확인 출금액 중 큰 금액에서 직접 확인한 반환 입금만 빼서 남은 예산을 계산하며, 완료 확인은 남은 계획을 0원으로 표시합니다.',
  '날짜 미정 예산은 조회기간의 월별 일수로 안분합니다. 날짜가 지난 잔여 예산은 날짜 미정으로 남으며 특정 추가 입금일을 확정하지 않습니다.',
  '반복 추정과 등록 예정은 서로 다른 조회 기준이며 직접 추가 항목은 각 기준에서 한 번만 반영됩니다. 원본 거래와 현재 기록 잔액은 변경하지 않습니다.',
 ];
 items.sort((left,right)=>compareText(left.businessId,right.businessId)||compareText(left.month,right.month)||compareText(left.date??'9999',right.date??'9999')||compareText(left.title,right.title)||compareText(left.key,right.key));
 return {plan,estimates,items};
}
