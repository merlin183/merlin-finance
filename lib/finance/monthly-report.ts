import type {CashPlanEdit} from './cash-plan-edits';
import {cashPlanEstimateOptions} from './cash-plan-policy';
import type {CashEstimateOptions} from './cash-estimates';
import {needsCategoryReview} from './category-status';
import {parseFinanceDate,type DateRange} from './date-range';
import {buildEditableCashPlan} from './editable-cash-plan';
import {accountingTransactions,type AccountingTransaction} from './transaction-accounting';
import {calendarMonthRange} from './transaction-calendar';
import type {Business,Dataset,Transaction} from './types';

/** Cash paid/received during the selected month, using the saved categories. */
export const monthlyReportMetrics=[
 {id:'sales',label:'매출 입금',description:'입금 중 저장된 계정과목이 매출인 거래',kind:'income'},
 {id:'payroll',label:'인건비',description:'급여·상여금의 실제 출금',kind:'expense'},
 {id:'rent',label:'임차료·관리비',description:'임차료·임대료·관리비의 실제 출금',kind:'expense'},
 {id:'advertising',label:'광고비',description:'광고선전비의 실제 출금',kind:'expense'},
 {id:'insurance',label:'보험료',description:'보험료와 출금으로 기록된 보험금',kind:'expense'},
 {id:'telecom',label:'통신비',description:'통신비의 실제 출금',kind:'expense'},
 {id:'fees',label:'지급수수료',description:'서비스·외주·은행 수수료 등 지급수수료 출금',kind:'expense'},
 {id:'taxes',label:'세금·공과금',description:'세금과공과 출금. 사회보험 등도 포함될 수 있음',kind:'expense'},
 {id:'retirement',label:'퇴직금',description:'퇴직금·퇴직급여의 실제 출금',kind:'expense'},
 {id:'cards',label:'카드대금',description:'통장에서 지급된 카드대금. 카드 사용내역을 다시 더하지 않음',kind:'expense'},
 {id:'refundUnknown',label:'환불·현금·잡비용',description:'현금환불·현금출금·잡비용의 실제 출금',kind:'expense'},
 {id:'other',label:'기타 분류 지출',description:'위 항목 이외의 저장된 과목 출금. 자산 취득·재무 성격 포함 가능',kind:'expense'},
 {id:'unmapped',label:'미분류 지출',description:'과목 미설정·미매핑 등 확인이 필요한 출금',kind:'expense'},
] as const;
export type MonthlyMetricId=typeof monthlyReportMetrics[number]['id'];
export type MonthlyAmountCell={amount:number;transactions:AccountingTransaction[]};
export type MonthlyPlanRow={
 key:string;title:string;date:string|null;expectedDate:string|null;accountId:string|null;
 amount:number;originalAmount:number;recordedAmount:number;memo:string;
 status:'dated'|'undated'|'date-passed';sourceType:'estimated'|'manual';transactions:Transaction[];
};
export type MonthlyReviewCheck={id:string;businessId:string;title:string;detail:string;transactions:AccountingTransaction[]};
export type MonthlyBusinessTotals={sales:number;otherIncome:number;externalOutflow:number;remainingDated:number;remainingUndated:number;remainingTotal:number;forecastOutflow:number};
export type MonthlyBusinessReport={
 business:Business;metrics:Record<MonthlyMetricId,MonthlyAmountCell>;
 sales:MonthlyAmountCell;otherIncome:MonthlyAmountCell;externalOutflow:MonthlyAmountCell;
 remainingPlan:MonthlyPlanRow[];remainingDated:number;remainingUndated:number;remainingTotal:number;forecastOutflow:number;
 /** Latest saved transaction in this actual period; not a bank sync timestamp. */
 lastTransactionDate:string|null;checks:MonthlyReviewCheck[];
};
export type MonthlyReport={
 month:string;range:DateRange;actualRange:DateRange|null;asOf:string;
 businesses:MonthlyBusinessReport[];totals:MonthlyBusinessTotals;checks:MonthlyReviewCheck[];notes:string[];
};

const categoryKey=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'').trim();
const expenseCategoryGroups:Partial<Record<MonthlyMetricId,readonly string[]>>={
 payroll:['급여','상여금'],rent:['임차료','임대료','관리비'],advertising:['광고선전비'],insurance:['보험료','보험금'],
 telecom:['통신비'],fees:['지급수수료'],taxes:['세금과공과'],retirement:['퇴직금','퇴직급여'],
 cards:['카드대금결제','카드대금'],refundUnknown:['현금환불','현금출금','잡비용'],
};
const expenseMetricByCategory=new Map(Object.entries(expenseCategoryGroups).flatMap(([id,names])=>names.map(name=>[name,id as MonthlyMetricId] as const)));
const emptyCell=():MonthlyAmountCell=>({amount:0,transactions:[]});
const addRow=(cell:MonthlyAmountCell,row:AccountingTransaction)=>{cell.amount+=row.amount;cell.transactions.push(row);};
const compareText=(left:string,right:string)=>left<right?-1:left>right?1:0;
const byTransaction=(left:Transaction,right:Transaction)=>compareText(left.txn_date,right.txn_date)||compareText(left.txn_time??'',right.txn_time??'')||compareText(left.id,right.id);

/** An original category is evidence only when explicitly labelled by the source. */
function sourceCategory(row:Transaction):string {
 const clobe=/Clobe 원본 분류\s*\(표시용\)\s*:\s*([^\n·]+)/i.exec(row.source_details?.note??'');
 return categoryKey(clobe?.[1]??row.raw_gwamok??'');
}

/**
 * Read-only management draft. Actuals come only from the saved ledger; plan
 * confirmations/bank-query evidence only reduce remaining budgets. The report
 * owns its calendar month and never changes the saved cash-plan period.
 */
export function buildMonthlyReport(data:Dataset,edits:readonly CashPlanEdit[],month:string,asOf:string,estimateOptions:CashEstimateOptions=cashPlanEstimateOptions(data)):MonthlyReport {
 const range=calendarMonthRange(month);
 if(!parseFinanceDate(asOf))throw new RangeError('월간 보고의 기준일을 확인해주세요.');
 const actualRange=asOf<range.from?null:{from:range.from,to:asOf<range.to?asOf:range.to};
 const categories=new Map(data.categories.map(category=>[category.id,category]));
 const reports:MonthlyBusinessReport[]=data.businesses.map(business=>{
  const metrics=Object.fromEntries(monthlyReportMetrics.map(metric=>[metric.id,emptyCell()])) as Record<MonthlyMetricId,MonthlyAmountCell>;
  return {business,metrics,sales:metrics.sales,otherIncome:emptyCell(),externalOutflow:emptyCell(),remainingPlan:[],remainingDated:0,remainingUndated:0,remainingTotal:0,forecastOutflow:0,lastTransactionDate:null,checks:[]};
 });
 const byBusiness=new Map(reports.map(report=>[report.business.id,report]));
 const actualRaw=data.transactions.filter(row=>actualRange&&parseFinanceDate(row.txn_date)&&row.txn_date>=actualRange.from&&row.txn_date<=actualRange.to&&Number.isSafeInteger(row.amount)&&row.amount>=0&&byBusiness.has(row.business_id));
 for(const row of actualRaw){
  const report=byBusiness.get(row.business_id)!;
  if(!report.lastTransactionDate||report.lastTransactionDate<row.txn_date)report.lastTransactionDate=row.txn_date;
 }
 for(const row of accountingTransactions(data,actualRaw,true).sort(byTransaction)){
  const report=byBusiness.get(row.business_id)!,category=categories.get(row.category_id??''),name=categoryKey(category?.name??'');
  if(row.direction==='in')addRow(name==='매출'?report.sales:report.otherIncome,row);
  else{
   const metric=needsCategoryReview(category?.name)||name==='미분류'||name==='미설정'?'unmapped':expenseMetricByCategory.get(name)??'other';
   addRow(report.metrics[metric],row);addRow(report.externalOutflow,row);
  }
 }

 // Same repeated-withdrawal basis as the cash-utilization plan table, including
 // saved manual rows/exclusions and direct confirmations, for this exact month.
 const editable=buildEditableCashPlan(data,range,asOf,edits,estimateOptions);
 const editors=new Map(editable.items.map(item=>[item.key,item]));
 for(const estimate of editable.estimates.businesses){
  const report=byBusiness.get(estimate.business.id)!;
  for(const item of [...estimate.dated,...estimate.undated]){
   const sourceType=item.sourceType??'estimated',key=JSON.stringify([item.businessId,sourceType,item.groupKey,month]),editor=editors.get(key);
   const date='date' in item?item.date:null,expectedDate='expectedDate' in item?item.expectedDate??null:null;
   report.remainingPlan.push({key,title:item.title,date,expectedDate,accountId:item.accountId||null,amount:item.amount,
    originalAmount:item.originalAmount??editor?.amount??item.amount,recordedAmount:item.recordedAmount??0,memo:item.memo??'',
    status:date?'dated':expectedDate?'date-passed':'undated',sourceType,
    transactions:[...(editor?.recordedTransactions??[])].sort(byTransaction),
   });
  }
  report.remainingPlan.sort((left,right)=>compareText(left.date??'9999',right.date??'9999')||compareText(left.expectedDate??'9999',right.expectedDate??'9999')||compareText(left.title,right.title)||compareText(left.key,right.key));
  report.remainingDated=report.remainingPlan.reduce((sum,item)=>sum+(item.status==='dated'?item.amount:0),0);
  report.remainingUndated=report.remainingPlan.reduce((sum,item)=>sum+(item.status!=='dated'?item.amount:0),0);
  report.remainingTotal=report.remainingDated+report.remainingUndated;
 }

 const checks:MonthlyReviewCheck[]=[];
 for(const report of reports){
  report.forecastOutflow=report.externalOutflow.amount+report.remainingTotal;
  const putCheck=(id:string,title:string,detail:string,transactions:AccountingTransaction[])=>{
   if(!transactions.length)return;
   const check={id:`${report.business.id}:${id}`,businessId:report.business.id,title,detail,transactions};
   report.checks.push(check);checks.push(check);
  };
  const feeIncome=report.otherIncome.transactions.filter(row=>categoryKey(categories.get(row.category_id??'')?.name??'')==='지급수수료');
  const sourceSales=feeIncome.filter(row=>sourceCategory(row)==='매출'),salesIds=new Set(sourceSales.map(row=>row.id));
  putCheck('sales-category','매출 분류 확인','원본 분류는 매출이지만 현재 저장된 과목은 지급수수료인 입금입니다. 공식 매출 합계에는 포함하지 않았습니다.',sourceSales);
  putCheck('fee-income','수수료 과목 입금 확인','지급수수료로 분류된 입금입니다. 환불·결제 취소·기타 입금인지 원본을 확인하세요. 매출로 임의 합산하지 않았습니다.',feeIncome.filter(row=>!salesIds.has(row.id)));
  putCheck('payroll-source','인건비 원본 분류 확인','현재 급여·상여금이지만 원본 과목에는 대여·차입·대출 또는 상환 표시가 있습니다. 현재 분류를 유지했으므로 실제 용도를 확인하세요.',report.metrics.payroll.transactions.filter(row=>/대여|차입|대출|상환/.test(sourceCategory(row))));
  putCheck('rent-source','임차료 원본 분류 확인','현재 지급수수료이지만 원본은 임차료·임대료·관리비로 표시되어 있습니다. 사용자가 저장한 과목을 유지했습니다.',report.metrics.fees.transactions.filter(row=>['임차료','임대료','관리비'].includes(sourceCategory(row))));
  putCheck('advertising-purpose','광고비 용도 확인','저장된 광고선전비를 그대로 집계했습니다. 매체비·대행비와 별도 용도 출금이 섞였는지 거래처·원본으로 확인하세요.',report.metrics.advertising.transactions);
  putCheck('unmapped','미분류 출금 확인','과목이 확정되지 않은 출금도 총지출에 포함했습니다. 분류 변경은 거래 내역·미분류 정리에서 진행하세요.',report.metrics.unmapped.transactions);
 }
 const totals=reports.reduce<MonthlyBusinessTotals>((sum,report)=>({
  sales:sum.sales+report.sales.amount,otherIncome:sum.otherIncome+report.otherIncome.amount,externalOutflow:sum.externalOutflow+report.externalOutflow.amount,
  remainingDated:sum.remainingDated+report.remainingDated,remainingUndated:sum.remainingUndated+report.remainingUndated,remainingTotal:sum.remainingTotal+report.remainingTotal,forecastOutflow:sum.forecastOutflow+report.forecastOutflow,
 }),{sales:0,otherIncome:0,externalOutflow:0,remainingDated:0,remainingUndated:0,remainingTotal:0,forecastOutflow:0});
 return {month,range,actualRange,asOf,businesses:reports,totals,checks,notes:[
  '실적은 선택한 월에 통장으로 입출금된 금액입니다. 급여의 귀속월·세무상 매출과 다른 현금 기준 초안이며 오늘 이후 거래는 포함하지 않습니다.',
  '매출 0원은 저장된 매출 과목 입금이 없다는 뜻입니다. 미분류·다른 과목 입금은 기타 입금으로 별도 확인합니다.',
  '고정비 여부는 과목만으로 확정하지 않습니다. 지급수수료에는 서비스·외주·은행 수수료, 세금과공과에는 사회보험 등이 섞일 수 있습니다.',
  '사업자 간 대여·상환과 내부이동은 실적에서 제외합니다. 원본 출금에 분리 저장된 이체 수수료는 외부 비용으로 한 번 집계합니다.',
  '카드대금은 통장에서 출금된 결제액입니다. 카드 승인 사용처 금액을 다시 더하지 않아 중복 집계를 피합니다.',
  '남은 계획은 가용자금 계획의 반복 출금 추정·직접 추가 및 저장된 수정·제외·출금 확인을 반영한 잔여 예산입니다. 확정 미지급금이 아니며 날짜 미정·지난 날짜 잔여도 포함됩니다.',
  '실적에 남은 예산을 더한 합계는 지출 전망입니다. 사용자 출금 확인이나 은행 조회만 있는 금액을 원장 실적에 추가하지 않습니다.',
  '선택한 월의 1일부터 말일까지 별도로 조회합니다. 다음 달 초 세금 등은 이 월 합계에 넣지 않으며 기존 지출계획표의 저장된 기간을 변경하지 않습니다.',
 ]};
}
