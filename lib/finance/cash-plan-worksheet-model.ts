import {cashEstimateRecordedTransactions,type CashEstimateOptions} from './cash-estimates';
import type {EditableCashPlan,CashPlanEditorItem} from './editable-cash-plan';
import {cashPlanMemoDisplay,cashPlanUserMemo} from './cash-plan-memo';
import {isValidDateRange,parseFinanceDate,type DateRange} from './date-range';
import {calendarMonthRange} from './transaction-calendar';
import type {Dataset} from './types';
import {cashPlanPaymentConfirmation,type CashPlanPaymentConfirmation} from './cash-plan-payment-confirmation';
import type {BankPlanEvidence,BankPlanCoverageStatus} from './clobe-plan-actuals';
import {cashCalendarActualTransactions} from './cash-calendar';
import {sourceCounterparty} from './source-details';

export type CashPlanWorksheetStatus='pending'|'partial'|'spent'|'over-budget'|'confirmation-needed'|'paid'|'confirmed'|'confirmed-partial';
export type CashPlanRecordedPaymentDate={date:string;amount:number;transactionCount:number};
export type CashPlanWorksheetActualOnlyRow={
 key:string;transactionId:string;businessId:string;accountId:string;date:string;title:string;amount:number;
 description:string;categoryId:string|null;categoryName:string;editableTransactionId:string|null;isInternal:boolean;source:'bank-query'|'ledger';
};
export type CashPlanWorksheetRow={
 key:string;businessId:string;title:string;date:string|null;month:string;from:string;to:string;
 /** Source dates anchor review rows without changing the plan's remaining payment schedule. */
 displayDate:string|null;displayDateIsActual:boolean;
 originalAmount:number;recordedAmount:number|null;remainingAmount:number;
 accountId:string|null;sourceAccountId:string|null;sourceType:CashPlanEditorItem['source_type'];
 categoryId:string|null;categoryName:string|null;
 note:string;memo:string;tax:boolean;status:CashPlanWorksheetStatus;statusLabel:string;
 confirmation:CashPlanPaymentConfirmation|null;editorItem:CashPlanEditorItem;
 bankRecordedAmount:number;bankEvidence:BankPlanEvidence;bankCoverage:BankPlanCoverageStatus;reconciliationReason:string|null;
 /** Source withdrawal dates only. These display values never create a schedule or change funding totals. */
 recordedPaymentDates:CashPlanRecordedPaymentDate[];
};
export type CashPlanWorksheetBusiness={
 businessId:string;rows:CashPlanWorksheetRow[];originalTotal:number;
 /** Source withdrawals not represented by a trusted actual-primary plan row. Never part of budget or confirmation aggregates. */
 actualOnlyRows:CashPlanWorksheetActualOnlyRow[];
 /** A numeric total requires bank evidence or explicit user confirmation for every row. */
 recordedTotal:number|null;knownRecordedTotal:number;remainingTotal:number;hasUnknownRecorded:boolean;
};
export type CashPlanWorksheetModel={businesses:CashPlanWorksheetBusiness[]};
export type CashPlanWorksheetInput={
 data:Dataset;editable:EditableCashPlan;basis:'registered'|'estimated';range:DateRange;asOf:string;options?:CashEstimateOptions;
};

const compareText=(left:string,right:string)=>left<right?-1:left>right?1:0;
const recordStatus=(item:CashPlanEditorItem,original:number,recorded:number|null,asOf:string,confirmation:CashPlanPaymentConfirmation|null):{status:CashPlanWorksheetStatus;statusLabel:string}=>{
 if(item.paymentKind==='tax'&&item.paymentStatus==='paid')return {status:'paid',statusLabel:'납부 완료 표시'};
 if(confirmation)return confirmation.complete?{status:'confirmed',statusLabel:'사용자 출금 완료 확인'}:{status:'confirmed-partial',statusLabel:'사용자 출금 확인'};
 if(recorded===null)return {status:'confirmation-needed',statusLabel:'실제 지급 확인 필요'};
 if(recorded>original)return {status:'over-budget',statusLabel:'예산 초과 출금'};
 if(recorded>0&&item.remainingAmount===0)return {status:'spent',statusLabel:'예산 소진'};
 if(recorded>0)return {status:'partial',statusLabel:'일부 출금 반영'};
 return {status:'pending',statusLabel:original===0?'예산 0원':item.date!==null&&item.date<asOf?'출금 실적 미반영 · 지급 확인 필요':'출금 실적 미반영'};
};

/** A period-review worksheet, not a funding calculator. Editor items retain
 * spent budgets and original expected dates which remaining-only projections
 * intentionally omit. Never use these review totals to replace cash funding.
 * Exact bank-source matches or an explicit user confirmation establish an
 * amount. Taxes retain the separate paid marker without fabricating an amount. */
export function buildCashPlanWorksheetModel({data,editable,basis,range,asOf,options={}}:CashPlanWorksheetInput):CashPlanWorksheetModel{
 if(!isValidDateRange(range)||!parseFinanceDate(asOf))throw new RangeError('지출계획표의 조회 기간과 기준일을 확인해주세요.');
 const protectedKeys=editable.items.filter(item=>item.source_type==='estimated').map(item=>item.source_key);
 const recorded:ReturnType<typeof cashEstimateRecordedTransactions>=basis==='estimated'?cashEstimateRecordedTransactions(data,asOf,options,editable.estimates,protectedKeys):new Map();
 const byBusiness=new Map(editable.plan.businesses.map(plan=>[plan.business.id,[] as CashPlanWorksheetRow[]]));
 const canonicalActuals=cashCalendarActualTransactions(data,asOf),actualById=new Map(canonicalActuals.transactions.map(row=>[row.id,row]));
 const representedIds=new Set<string>();
 const accountNames=new Map(editable.plan.businesses.flatMap(plan=>plan.accounts.map(({account})=>[
  JSON.stringify([plan.business.id,account.id]),[account.name,account.bank].filter(Boolean).join(' · '),
 ] as const)));
 const accountLabel=(businessId:string,accountId:string|null)=>accountNames.get(JSON.stringify([businessId,accountId]))||'계좌 미지정';
 for(const item of editable.items){
  const target=byBusiness.get(item.businessId);
  if(!target||item.excluded||!item.inRange||(item.source_type!==basis&&item.source_type!=='manual'&&!item.seriesId))continue;
  const full=calendarMonthRange(item.month),from=range.from>full.from?range.from:full.from,to=range.to<full.to?range.to:full.to;
  if(from>to||(item.date!==null&&(item.date<range.from||item.date>range.to)))continue;
  const coveredDays=Number(to.slice(-2))-Number(from.slice(-2))+1,monthDays=Number(full.to.slice(-2));
  const originalAmount=item.date===null?Math.round(item.amount*coveredDays/monthDays):item.amount;
  // Dated budgets share the core's whole-month spending basis. Truly undated
  // period budgets use only that exact selected interval, including overspend.
  const recordFrom=item.date===null?from:full.from,recordTo=item.date===null?to:full.to;
  const confirmation=cashPlanPaymentConfirmation(item.edit,asOf);
  const scopedConfirmation=confirmation&&(item.date!==null||(confirmation.date>=from&&confirmation.date<=to))?confirmation:null;
  const actualRows=item.recordedTransactions??(recorded.get(item.source_key)??[]);
  const paymentDates=new Map<string,CashPlanRecordedPaymentDate>();
  const seenPaymentIds=new Set<string>();
  if(!item.recordedAmbiguous)for(const row of actualRows){
   const actual=actualById.get(row.id);
   if(row.direction!=='out'||row.business_id!==item.businessId||!parseFinanceDate(row.txn_date)||row.txn_date>asOf
    ||row.txn_date<recordFrom||row.txn_date>recordTo||!Number.isSafeInteger(row.amount)||row.amount<=0||seenPaymentIds.has(row.id)
    ||!actual||actual.business_id!==row.business_id||actual.account_id!==row.account_id||actual.txn_date!==row.txn_date||actual.amount!==row.amount)continue;
   seenPaymentIds.add(row.id);
   const payment=paymentDates.get(row.txn_date)??{date:row.txn_date,amount:0,transactionCount:0};
   payment.amount+=row.amount;payment.transactionCount++;
   paymentDates.set(row.txn_date,payment);
  }
  const recordedPaymentDates=[...paymentDates.values()].sort((left,right)=>compareText(left.date,right.date));
  const bankIds=new Set(item.bankTransactionIds??[]);
  const bankRecordedAmount=actualRows.reduce((sum,row)=>sum+(bankIds.has(row.id)&&row.txn_date>=recordFrom&&row.txn_date<=recordTo?row.amount:0),0);
  const actualAmount=actualRows.reduce((sum,row)=>sum+(row.txn_date>=recordFrom&&row.txn_date<=recordTo?row.amount:0),0);
  const bankRecorded=item.recordedKnown===true||actualAmount>0||(item.recordedKnown===undefined&&item.source_type==='estimated')?actualAmount:null;
  const recordedAmount=scopedConfirmation?Math.max(bankRecorded??0,scopedConfirmation.amount):bankRecorded;
  const actualDatesAmount=recordedPaymentDates.reduce((sum,payment)=>sum+payment.amount,0);
  const displayDateIsActual=recordedAmount!==null&&recordedAmount>0&&actualDatesAmount===recordedAmount&&recordedPaymentDates.length>0;
  const displayDate=displayDateIsActual?recordedPaymentDates[0].date:item.date;
  if(displayDateIsActual)for(const id of seenPaymentIds)representedIds.add(id);
  const status=recordStatus(item,originalAmount,recordedAmount,asOf,confirmation?.complete?confirmation:scopedConfirmation);
  const reconciliationReason=item.reconciliationReason??null;
  if(!confirmation&&!(item.paymentKind==='tax'&&item.paymentStatus==='paid')){
   if(reconciliationReason&&(item.recordedAmbiguous||item.remainingAmount>0||recordedAmount===null)){status.status='confirmation-needed';status.statusLabel=reconciliationReason;}
   else if(bankRecordedAmount>0)status.statusLabel='은행 조회 출금 반영';
  }
  const bankEvidence:BankPlanEvidence=bankRecordedAmount>0?(actualAmount>bankRecordedAmount?'mixed':'bank-query'):'none';
  const moved=item.source_type==='estimated'&&item.sourceAccountId!==null&&item.sourceAccountId!==item.accountId;
  const sourceLabel=item.source_type==='estimated'?'반복 출금 추정':item.source_type==='manual'?'직접 추가':'등록 예정';
  const spendingScope=item.source_type==='estimated'||bankRecorded!==null?`${item.date===null?'조회기간':'동월'} 실적 ${recordFrom} ~ ${recordTo}`:'통장 실적 자동 연결 없음';
  const note=[sourceLabel,accountLabel(item.businessId,item.accountId),spendingScope,
   moved?`실적 기준 계좌 ${accountLabel(item.businessId,item.sourceAccountId)}`:'',
   cashPlanMemoDisplay(item.memo),
  ].filter(Boolean).join(' · ');
  target.push({key:item.key,businessId:item.businessId,title:item.title,date:item.date,displayDate,displayDateIsActual,month:item.month,from,to,originalAmount,recordedAmount,
   remainingAmount:item.remainingAmount,accountId:item.accountId,sourceAccountId:item.sourceAccountId,sourceType:item.source_type,categoryId:item.categoryId,categoryName:item.categoryName,
   note,memo:cashPlanUserMemo(item.memo),tax:item.paymentKind==='tax',...status,
   confirmation,editorItem:item,bankRecordedAmount,bankEvidence,bankCoverage:item.bankCoverage??'uncollected',reconciliationReason,recordedPaymentDates,
  });
 }
 const categories=new Map(data.categories.map(category=>[category.id,category])),internalIds=new Set(data.links.map(link=>link.out_transaction_id));
 const savedTransactions=new Map(data.transactions.map(row=>[row.id,row]));
 const actualOnlyByBusiness=new Map(editable.plan.businesses.map(plan=>[plan.business.id,[] as CashPlanWorksheetActualOnlyRow[]]));
 for(const actual of canonicalActuals.transactions){
  const target=actualOnlyByBusiness.get(actual.business_id);
  if(!target||representedIds.has(actual.id)||actual.txn_date<range.from||actual.txn_date>range.to)continue;
  const category=categories.get(actual.category_id??'');
  target.push({key:JSON.stringify(['actual-only',actual.id]),transactionId:actual.id,businessId:actual.business_id,accountId:actual.account_id,date:actual.txn_date,
   title:sourceCounterparty(actual)||actual.description||'출금',amount:actual.amount,description:actual.description,categoryId:category?.id??null,categoryName:category?.name??'',editableTransactionId:savedTransactions.has(actual.id)?actual.id:null,
   isInternal:actual.is_internal||!!category?.is_internal||internalIds.has(actual.id),source:canonicalActuals.bankById.has(actual.id)?'bank-query':'ledger'});
 }
 const businesses=editable.plan.businesses.map(plan=>{
  const rows=byBusiness.get(plan.business.id)!;
  rows.sort((left,right)=>compareText(left.displayDate??'9999',right.displayDate??'9999')||compareText(left.from,right.from)||compareText(left.title,right.title)||compareText(left.key,right.key));
  const hasUnknownRecorded=rows.some(row=>row.recordedAmount===null),knownRecordedTotal=rows.reduce((sum,row)=>sum+(row.recordedAmount??0),0);
  const actualOnlyRows=actualOnlyByBusiness.get(plan.business.id)!.sort((left,right)=>compareText(left.date,right.date)||compareText(left.title,right.title)||compareText(left.key,right.key));
  return {businessId:plan.business.id,rows,actualOnlyRows,originalTotal:rows.reduce((sum,row)=>sum+row.originalAmount,0),recordedTotal:hasUnknownRecorded?null:knownRecordedTotal,
   knownRecordedTotal,remainingTotal:rows.reduce((sum,row)=>sum+row.remainingAmount,0),hasUnknownRecorded,
  };
 });
 return {businesses};
}
