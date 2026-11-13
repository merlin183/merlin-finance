"use client";
import {FinancialValue,FinancialText,FinancialChart,FinancialInput,useFinancialVisibility} from './financial-visibility';

import {memo,useCallback,useMemo,useRef,useState,type MouseEvent} from 'react';
import {ChevronDown,Info,TriangleAlert,X} from 'lucide-react';
import {toast} from 'sonner';
import {ResponsiveContainer,LineChart,Line,XAxis,YAxis,CartesianGrid,Tooltip,ReferenceLine} from 'recharts';
import {Input} from '@/components/ui/input';
import {Button} from '@/components/ui/button';
import {Dialog,DialogClose,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {Panel,Picker,NoData,FinanceLink} from './common';
import {CashPlanWorksheet} from './cash-plan-worksheet';
import {CashPlanSeriesSummary} from './cash-plan-series-summary';
import {CashPlanSeriesBreakdownDialog} from './cash-plan-series-breakdown';
import {CashAccountBalances} from './cash-account-balances';
import {ClobeCardBillsPanel} from './clobe-card-bills-panel';
import {ClobeBalanceSyncButton} from './clobe-balance-sync-button';
import {TossSettlementSyncButton,TossSettlementsPanel} from './toss-settlements-panel';
import {useTossSettlements} from './use-toss-settlements';
import {tossCalendarIncome,tossFundingIncome,tossCashForecastPlan} from '@/lib/finance/toss-funding';
import {CashPlanEditorDialog} from './cash-plan-editor';
import {PaymentConfirmationDialog} from './payment-confirmation-dialog';
import {CashPlanActualCategoryDialog,type CashPlanActualCategorySelection} from './cash-plan-actual-category-dialog';
import type {CashPlanEditState,CashPlanEditChange} from './use-cash-plan-edits';
import {AccountFundingPanel} from './account-funding';
import {FundingReportDialog} from './funding-report-dialog';
import {DateRangeControl} from './date-range-control';
import {useCashPlanPeriod} from './use-cash-plan-period';
import {simulate} from '@/lib/finance/aggregate';
import {buildCurrentCashForecast,type CashPlanBusiness,type CashPlanOccurrence} from '@/lib/finance/cash-plan';
import {buildEditableCashPlan} from '@/lib/finance/editable-cash-plan';
import {buildCashPlanSeriesBreakdown,buildCashPlanSeriesMonthly} from '@/lib/finance/cash-plan-series';
import {buildCashPlanFixedSyncChanges} from '@/lib/finance/cash-plan-fixed-sync';
import type {FixedCostForwardRequest} from '@/lib/finance/cash-plan-series-forward';
import {calendarMonthRange} from '@/lib/finance/transaction-calendar';
import {cashPlanEstimateOptions} from '@/lib/finance/cash-plan-policy';
import {buildCashPlanWorksheetModel,type CashPlanWorksheetActualOnlyRow,type CashPlanWorksheetRow} from '@/lib/finance/cash-plan-worksheet-model';
import type {CashEstimateBusiness,CashEstimateGroup} from '@/lib/finance/cash-estimates';
import {cashPlanPeriodError} from '@/lib/finance/cash-plan-period';
import {accountBalanceRecordLabel,buildLatestCashBalances,latestBalanceRecordLabel,type LatestCashBusiness} from '@/lib/finance/latest-cash-balances';
import {won,compact,addDays} from '@/lib/finance/format';
import type {BalanceSnapshot} from '@/lib/finance/balances';
import type {Dataset} from '@/lib/finance/types';
import './cash-plan.css';

const snapshotLabels:Record<BalanceSnapshot['source'],string>={
 statement:'통장 거래 후 잔액',calculated:'입출금 반영 계산 잔액',opening:'설정한 개시잔액',
 unavailable:'잔액 자료 없음',conflict:'원본 잔액 확인 필요',clobe:'Clobe 수집 잔액',
};
const money=(value:number|null)=>value===null?'확인 필요':won(value);
type ExpenseBasis='registered'|'estimated';

function Schedule({items,direction,accounts}:{items:CashPlanOccurrence[];direction:'in'|'out';accounts?:CashPlanBusiness['accounts']}){
 const {privateText}=useFinancialVisibility();
 const days=useMemo(()=>{
  const grouped=new Map<string,{date:string;amount:number;items:CashPlanOccurrence[]}>();
  for(const item of items){
   const day=grouped.get(item.date)||{date:item.date,amount:0,items:[]};
   day.amount+=item.amount;day.items.push(item);grouped.set(item.date,day);
  }
  return [...grouped.values()].sort((a,b)=>a.date.localeCompare(b.date));
 },[items]);
 return <div className="cash-plan-schedule">{days.map(day=><section key={day.date} aria-label={privateText(`${day.date} 예정 ${direction==='out'?'지출':'수입'}`)}>
  <header><time dateTime={day.date}>{day.date}</time><strong className={direction==='out'?'negative':'positive'}><FinancialValue value={won(day.amount)}/></strong></header>
  <ul>{day.items.map(item=><li key={`${item.recurringId}:${item.date}`}><div><span><FinancialText value={item.title}/></span><small><FinancialText value={[item.sourceType==='manual'?'직접 추가':item.frequency==='monthly'?'월 반복':'일회성',direction==='out'?(accounts?.find(row=>row.account.id===item.accountId)?.account.name||'계좌 미지정'):null,item.memo].filter(Boolean).join(' · ')}/></small></div><b><FinancialValue value={won(item.amount)}/></b></li>)}</ul>
 </section>)}</div>;
}

function EstimateEvidence({group,accountName}:{group:CashEstimateGroup;accountName:string}){
 return <details className="cash-estimate-evidence"><summary>산정 근거 보기 · {group.sourceCount}건</summary>
  <p><FinancialText value={accountName}/> · {group.categoryNames.join(', ')||'계정과목 없음'}</p>
  <dl>{group.monthlyAmounts.map(month=><div key={month.month}><dt>{month.month} <small>{month.count}건</small></dt><dd><FinancialValue value={won(month.amount)}/></dd></div>)}</dl>
  <p>3개월 전체 월평균 <FinancialValue value={won(group.monthlyAverage)}/> · {group.expectedDay===null?'일정한 출금일 없음':group.monthEnd?'월말 출금 경향':`매월 ${group.expectedDay}일 전후 출금 경향`}</p>
 </details>;
}

function EstimateAdjustment({item}:{item:{amount:number;originalAmount?:number;recordedAmount?:number}}){
 if(item.originalAmount===undefined)return null;
 return <small>예산 <FinancialValue value={won(item.originalAmount)}/> · 반영 실적 <FinancialValue value={won(item.recordedAmount??0)}/> · 남은 예산 <FinancialValue value={won(item.amount)}/></small>;
}

function EstimatedSchedule({estimate,plan}:{estimate:CashEstimateBusiness;plan:CashPlanBusiness}){
 const {privateText}=useFinancialVisibility();
 const accounts=new Map(plan.accounts.map(({account})=>[account.id,[account.name,account.bank].filter(Boolean).join(' · ')]));
 const groups=new Map(estimate.groups.map(group=>[group.key,group]));
 const dated=estimate.dated;
 const days=useMemo(()=>{
  const byDate=new Map<string,typeof dated>();
  for(const item of dated){const items=byDate.get(item.date)||[];items.push(item);byDate.set(item.date,items);}
  return [...byDate].sort(([a],[b])=>a.localeCompare(b));
 },[dated]);
 return <>
  {days.length>0&&<div className="cash-plan-schedule">{days.map(([date,items])=><section key={date} aria-label={privateText(`${date} 추정 지출`)}>
   <header><time dateTime={date}>{date} <span>예상일</span></time><strong className="negative"><FinancialValue value={won(items.reduce((sum,item)=>sum+item.amount,0))}/></strong></header>
   <ul>{items.map(item=><li key={`${item.groupKey}:${item.date}`}><div><span><FinancialText value={item.title}/></span><small><FinancialText value={[item.sourceType==='manual'?'직접 추가':null,accounts.get(item.accountId)||'계좌 미지정',item.memo].filter(Boolean).join(' · ')}/></small><EstimateAdjustment item={item}/>{groups.has(item.groupKey)&&<EstimateEvidence group={groups.get(item.groupKey)!} accountName={accounts.get(item.accountId)||'통장 확인 필요'}/>}</div><b><FinancialValue value={won(item.amount)}/></b></li>)}</ul>
  </section>)}</div>}
  {estimate.undated.length>0&&<div className="cash-plan-schedule cash-plan-undated"><p>출금일이 일정하지 않거나 예상일이 지난 잔여 예산입니다. 특정 날짜에 배분하지 않았으니 실제 지급일을 확인하세요.</p>{estimate.undated.map(item=><section key={`${item.groupKey}:${item.month}`}>
   <header><span>{item.from} ~ {item.to} · {item.status==='date-passed'?'예상일 경과 · 지급일 확인':'날짜 미정'}</span><strong className="negative"><FinancialValue value={won(item.amount)}/></strong></header>
   <ul><li><div><span><FinancialText value={item.title}/></span><small><FinancialText value={[item.sourceType==='manual'?'직접 추가':null,accounts.get(item.accountId)||'계좌 미지정',item.memo].filter(Boolean).join(' · ')}/></small>{item.status==='date-passed'?<p className="cash-estimate-proration">기존 예상일 {item.expectedDate} · 남은 예산을 유지했습니다.</p>:<p className="cash-estimate-proration">월 예산 <FinancialValue value={won(item.monthlyAmount)}/> × {item.coveredDays}/{item.monthDays}일</p>}<EstimateAdjustment item={item}/>{groups.has(item.groupKey)&&<EstimateEvidence group={groups.get(item.groupKey)!} accountName={accounts.get(item.accountId)||'통장 확인 필요'}/>}</div></li></ul>
  </section>)}</div>}
 </>;
}

const CashBusinessCard=memo(function CashBusinessCard({plan,estimate,latest,basis}:{plan:CashPlanBusiness;estimate:CashEstimateBusiness|undefined;latest:LatestCashBusiness|undefined;basis:ExpenseBasis}){
 const {privateText}=useFinancialVisibility();
 const {business}=plan;
 const missing=plan.accounts.filter(item=>item.snapshot.balance===null).length;
 const estimated=basis==='estimated';
 const unconfirmed=estimated?[]:plan.unconfirmedExpenses??[];
 const incomplete=plan.balance===null||unconfirmed.length>0;
 const expenses=estimated?(estimate?.total??0):plan.expenses;
 const afterExpenses=estimated?(plan.balance===null?null:plan.balance-expenses):plan.afterExpenses;
 const available=estimated?(afterExpenses===null?null:afterExpenses-plan.reserve):plan.available;
 const noExpenses=estimated?(estimate?.dated.length??0)+(estimate?.undated.length??0)===0:plan.scheduledExpenses.length+(plan.undatedExpenses?.length??0)===0;
 return <article className="cash-plan-business" aria-label={privateText(`${business.name} 자금계획`)}>
  <header className="cash-plan-business-heading">
   <h3><i style={{background:business.color}}/>{business.name}</h3>
   <span className={`cash-plan-status ${incomplete?'needs-review':available!<0?'needs-funds':''}`}>
    {incomplete?'계획 산정 자료 확인 필요':available!<0?`${estimated?'추정':'등록'} 지출·유보액 대비 부족`:estimated?'반복 출금 추정 기준':'등록 계획 기준'}
   </span>
  </header>
  <section className="cash-plan-current-balance" aria-label={privateText(`${business.name} 현재 기록 잔액`)}>
   <div><span>현재 기록 잔액{(latest?.accounts.length??0)>1?' · 합계':''}</span><strong className={latest?.balance==null?'cash-plan-unknown':latest.balance<0?'negative':''}><FinancialValue value={money(latest?.balance??null)}/></strong><small>{latestBalanceRecordLabel(latest)}</small><CashAccountBalances business={latest}/>{latest?.balance===null&&latest.accounts.some(item=>item.snapshot.balance!==null)&&<small>확인된 통장 소계 <FinancialValue value={won(latest.knownBalance)}/> · 전체 잔액은 확인 필요</small>}</div>
   <p>현재 기록 잔액에서 남은 지출을 차감합니다.</p>
  </section>
  <div className="cash-plan-equation">
   <div><span>{estimated?'남은 추정 지출':'남은 예정 지출'}</span><strong className="negative"><FinancialValue value={won(expenses)}/></strong><small>{estimated?`남은 예산 ${(estimate?.dated.length??0)+(estimate?.undated.length??0)}건 · 확정 아님`:`남은 지출 ${plan.scheduledExpenses.length+(plan.undatedExpenses?.length??0)}건`}</small></div>
   <div className="cash-plan-after"><span>지출 후 잔액</span><strong className={afterExpenses!==null&&afterExpenses<0?'negative':''}><FinancialValue value={money(afterExpenses)}/></strong><small>예정 수입은 더하지 않은 금액</small></div>
  </div>
  {plan.balance===null&&<p className="cash-plan-warning"><TriangleAlert size={16}/><span>{plan.accounts.length===0?'등록된 통장이 없습니다.':`${plan.accounts.length}개 통장 중 ${missing}개의 현재 잔액 기록을 확인해야 합니다.`} 자료 확인 후 계산할 수 있습니다.</span></p>}
  {unconfirmed.length>0&&<p className="cash-plan-warning"><TriangleAlert size={16}/><span>오늘까지의 등록 일정 {unconfirmed.length}건 · <FinancialValue value={won(unconfirmed.reduce((sum,item)=>sum+item.amount,0))}/>은 지급 확인이 필요합니다. 남은 지출 합계에서 제외했으며, 지출 후 잔액과 가용자금은 확정할 수 없습니다.</span></p>}
  {noExpenses&&<p className="cash-plan-empty">{estimated?(estimate?.groups.length?'반영 실적을 뺀 남은 추정 예산이 없습니다.':'추정할 반복 거래가 없습니다.'):plan.registeredItemCount===0?'등록된 예정 수입·지출이 없습니다.':'앞으로 남은 등록 예정 지출이 없습니다.'} 실제 지출 예정이 없다는 뜻은 아닙니다. <FinanceLink href={`/settings/recurring?biz=${business.id}`}>설정에서 예정 항목 등록</FinanceLink></p>}
  <div className="cash-plan-secondary">
   <dl><div><dt>남겨둘 유보액</dt><dd><FinancialValue value={won(plan.reserve)}/></dd></div><div className="cash-plan-available"><dt>가용자금</dt><dd className={available!==null&&available<0?'negative':''}><FinancialValue value={money(available)}/></dd></div></dl>
   <p>가용자금은 지출 후 잔액에서 유보액을 제외한 금액입니다.</p>
   {!estimated&&<dl className="cash-plan-income"><div><dt>남은 예정 수입</dt><dd className="positive">+ <FinancialValue value={won(plan.income)}/></dd></div><div><dt>수입 반영 후 잔액</dt><dd><FinancialValue value={money(plan.projected)}/></dd></div></dl>}
  </div>
  <div className="cash-plan-breakdowns">
   {unconfirmed.length>0&&<details className="cash-plan-detail"><summary><span>지급 확인이 필요한 지난 등록 일정 <small>{unconfirmed.length}건 · <FinancialValue value={won(unconfirmed.reduce((sum,item)=>sum+item.amount,0))}/></small></span><ChevronDown size={16}/></summary><Schedule items={unconfirmed} direction="out" accounts={plan.accounts}/></details>}
   <details className="cash-plan-detail">
    <summary><span>통장별 현재 기록 잔액 <small>{latest?.accounts.length??0}개</small></span><ChevronDown size={16}/></summary>
    {latest&&latest.accounts.length>0?<ul className="cash-plan-accounts">{latest.accounts.map(({account,snapshot})=><li key={account.id}>
     <div><strong><FinancialText value={account.name}/></strong><span><FinancialText value={[account.bank,account.masked_number].filter(Boolean).join(' · ')}/></span><small>{accountBalanceRecordLabel(snapshot)} · {snapshotLabels[snapshot.source]}</small><p><FinancialText value={snapshot.message}/></p></div>
     <b className={snapshot.balance===null?'cash-plan-unknown':snapshot.balance<0?'negative':''}><FinancialValue value={money(snapshot.balance)}/></b>
    </li>)}</ul>:<p className="cash-plan-empty">등록된 통장이 없습니다.</p>}
   </details>
   {estimated&&estimate&&(estimate.dated.length>0||estimate.undated.length>0)&&<details className="cash-plan-detail">
    <summary><span>추정 지출 날짜·거래처·산정 근거 <small>예상일 {estimate.dated.length}건 · 날짜 미정 예산 {estimate.undated.length}건</small></span><ChevronDown size={16}/></summary>
    <EstimatedSchedule estimate={estimate} plan={plan}/>
   </details>}
   {estimated&&estimate&&estimate.exclusions.length>0&&<details className="cash-plan-detail">
    <summary><span>추정에서 제외한 항목 <small>{estimate.exclusions.length}개</small></span><ChevronDown size={16}/></summary>
    <ul className="cash-plan-exclusions">{estimate.exclusions.map(item=><li key={item.groupKey}><strong><FinancialText value={item.label}/></strong><span><FinancialText value={plan.accounts.find(({account})=>account.id===item.accountId)?.account.name??''}/> · {item.sourceCount}건</span><p><FinancialText value={item.reason}/></p></li>)}</ul>
   </details>}
   {!estimated&&plan.scheduledExpenses.length>0&&<details className="cash-plan-detail">
    <summary><span>날짜별 예정 지출 <small>{plan.scheduledExpenses.length}건 · <FinancialValue value={won(plan.expenses)}/></small></span><ChevronDown size={16}/></summary>
    <Schedule items={plan.scheduledExpenses} direction="out" accounts={plan.accounts}/>
   </details>}
   {!estimated&&(plan.undatedExpenses?.length??0)>0&&<details className="cash-plan-detail"><summary><span>날짜 미정 예산 <small>{plan.undatedExpenses!.length}건 · <FinancialValue value={won(plan.undatedExpenses!.reduce((sum,item)=>sum+item.amount,0))}/></small></span><ChevronDown size={16}/></summary><div className="cash-plan-schedule cash-plan-undated"><p>지급일을 알 수 없어 기간 합계에만 포함합니다. 계획 편집에서 날짜와 출금 계좌를 지정할 수 있습니다.</p><ul>{plan.undatedExpenses!.map(item=><li key={item.key}><div><span><FinancialText value={item.title}/></span><small><FinancialText value={[`${item.from} ~ ${item.to}`,item.expectedDate?`기존 예상일 ${item.expectedDate}`:'날짜 미정',plan.accounts.find(row=>row.account.id===item.accountId)?.account.name||'계좌 미지정',item.memo].filter(Boolean).join(' · ')}/></small></div><b><FinancialValue value={won(item.amount)}/></b></li>)}</ul></div></details>}
   {!estimated&&plan.scheduledIncome.length>0&&<details className="cash-plan-detail">
    <summary><span>날짜별 예정 수입 <small>{plan.scheduledIncome.length}건 · <FinancialValue value={won(plan.income)}/></small></span><ChevronDown size={16}/></summary>
    <Schedule items={plan.scheduledIncome} direction="in"/>
   </details>}
  </div>
 </article>;
});

export function CashView({data,asOf,biz,editState,focusDate='',refresh,onSaveFixedCosts}:{data:Dataset;asOf:string;biz:string;editState:CashPlanEditState;focusDate?:string;refresh:()=>Promise<void>;onSaveFixedCosts:(request:FixedCostForwardRequest)=>Promise<unknown>}){
 const {privateText}=useFinancialVisibility();
 const {range,applyRange,saveError}=useCashPlanPeriod();
 const toss=useTossSettlements({data,asOf,refresh});
 const settlementIncome=useMemo(()=>tossFundingIncome(toss.groups,range,asOf),[toss.groups,range,asOf]);
 const calendarIncome=useMemo(()=>tossCalendarIncome(toss.groups,range,asOf).filter(item=>biz==='all'||item.businessId===biz),[toss.groups,range,asOf,biz]);
 const settlementIncomeByBusiness=useMemo(()=>{const result=new Map<string,number>();for(const item of settlementIncome)result.set(item.businessId,(result.get(item.businessId)??0)+item.amount);return result;},[settlementIncome]);
 const [from,setFrom]=useState('');const [to,setTo]=useState('');
 const [amount,setAmount]=useState('');const [when,setWhen]=useState(asOf);
 const [selectedBasis,setSelectedBasis]=useState<ExpenseBasis|null>(null);
 const [planView,setPlanView]=useState<'worksheet'|'summary'>('worksheet');
 const [selectedSeriesMonth,setSelectedSeriesMonth]=useState<string|null>(null);
 const [syncingFixed,setSyncingFixed]=useState(false),[fixedSyncError,setFixedSyncError]=useState('');
 const fixedSyncBusy=useRef(false);
 const fixedSyncAttempt=useRef<{data:Dataset;edits:CashPlanEditState['edits'];month:string;businessId:string;basis:ExpenseBasis;changes:CashPlanEditChange[]}|null>(null);
 const [seriesBreakdownSelection,setSeriesBreakdownSelection]=useState<{businessId:string;month:string}|null>(null);
 const seriesBreakdownTriggerRef=useRef<HTMLButtonElement|null>(null);
 const openSeriesBreakdown=useCallback((businessId:string,month:string,event:MouseEvent<HTMLButtonElement>)=>{seriesBreakdownTriggerRef.current=event.currentTarget;setSeriesBreakdownSelection({businessId,month});},[]);
 const [selectedBusiness,setSelectedBusiness]=useState('');
 const [editingBusiness,setEditingBusiness]=useState('');
 const [confirmingKey,setConfirmingKey]=useState('');
 const [actualCategorySelection,setActualCategorySelection]=useState<CashPlanActualCategorySelection|null>(null);
 const actualCategoryTriggerRef=useRef<HTMLButtonElement|null>(null);
 const openActualCategory=useCallback((row:CashPlanWorksheetActualOnlyRow,event:MouseEvent<HTMLButtonElement>)=>{
  const transaction=row.editableTransactionId?data.transactions.find(item=>item.id===row.editableTransactionId):undefined;
  if(!transaction)return;
  actualCategoryTriggerRef.current=event.currentTarget;setActualCategorySelection({row,transaction});
 },[data.transactions]);
 const confirmationTriggerRef=useRef<HTMLButtonElement|null>(null);
 const openPaymentConfirmation=useCallback((row:CashPlanWorksheetRow,event:MouseEvent<HTMLButtonElement>)=>{confirmationTriggerRef.current=event.currentTarget;setConfirmingKey(row.key);},[]);
 const editTriggerRef=useRef<HTMLButtonElement|null>(null);
 const openEditor=useCallback((businessId:string,event:MouseEvent<HTMLButtonElement>)=>{editTriggerRef.current=event.currentTarget;setEditingBusiness(businessId);},[]);
 const detailTriggerRef=useRef<HTMLButtonElement|null>(null);
 const openBusinessDetail=useCallback((businessId:string,event:MouseEvent<HTMLButtonElement>)=>{detailTriggerRef.current=event.currentTarget;setSelectedBusiness(businessId);},[]);
 const basis:ExpenseBasis=selectedBasis||(data.recurring.some(item=>item.direction==='out'&&(biz==='all'||item.business_id===biz))?'registered':'estimated');
 const latestBalances=useMemo(()=>new Map(buildLatestCashBalances(data,asOf).businesses.map(item=>[item.business.id,item])),[data,asOf]);
 const estimateOptions=useMemo(()=>cashPlanEstimateOptions(data),[data]);
 const editable=useMemo(()=>buildEditableCashPlan(data,range,asOf,editState.edits??[],estimateOptions),[data,range,asOf,editState.edits,estimateOptions]);
 const firstSeriesMonth=useMemo(()=>(data.cash_plan_series??[]).filter(item=>biz==='all'||item.business_id===biz).reduce<string|null>((first,item)=>first===null||item.start_month<first?item.start_month:first,null),[data.cash_plan_series,biz]);
 const seriesDefaultMonth=firstSeriesMonth&&firstSeriesMonth>range.from.slice(0,7)?firstSeriesMonth:range.from.slice(0,7);
 const seriesFromMonth=selectedSeriesMonth??(seriesDefaultMonth>'9999-07'?'9999-07':seriesDefaultMonth);
 const seriesMonths=useMemo(()=>buildCashPlanSeriesMonthly(data,editState.edits??[],seriesFromMonth,6).filter(item=>biz==='all'||item.businessId===biz),[data,editState.edits,seriesFromMonth,biz]);
 async function syncFixedFromWorksheet(){
  if(fixedSyncBusy.current||editState.saving||editState.loading)return;
  if(editState.edits===null||editState.error){setFixedSyncError('최신 공동 계획을 먼저 불러와주세요.');return;}
  fixedSyncBusy.current=true;setSyncingFixed(true);setFixedSyncError('');
  try{
   let attempt=fixedSyncAttempt.current;
   if(!attempt||attempt.data!==data||attempt.edits!==editState.edits||attempt.month!==seriesFromMonth||attempt.businessId!==biz||attempt.basis!==basis){
    const result=buildCashPlanFixedSyncChanges({data,edits:editState.edits,month:seriesFromMonth,asOf,businessId:biz,basis});
    if(!result.changes.length){toast.info(<FinancialText value={String(`${seriesFromMonth} 지출계획표가 이미 반영되어 있습니다.`)}/>);fixedSyncAttempt.current=null;return;}
    attempt={data,edits:editState.edits,month:seriesFromMonth,businessId:biz,basis,changes:result.changes};fixedSyncAttempt.current=attempt;
   }
   await editState.save(attempt.changes);
   fixedSyncAttempt.current=null;
   toast.success(<FinancialText value={String(`${seriesFromMonth} 지출계획 ${attempt.changes.length}건을 이 달 고정비에 반영했습니다.`)}/>);
  }catch(cause){setFixedSyncError(cause instanceof Error?cause.message:'지출계획표를 반영하지 못했습니다. 최신 계획을 확인하고 다시 시도해주세요.');}
  finally{fixedSyncBusy.current=false;setSyncingFixed(false);}
 }
 const selectSeriesMonth=useCallback((month:string)=>applyRange(calendarMonthRange(month)),[applyRange]);
 const refreshPlanEdits=editState.refresh;
 const reloadSeriesBreakdown=useCallback(async()=>{await Promise.all([refreshPlanEdits(),refresh()]);},[refreshPlanEdits,refresh]);
 const seriesBreakdown=useMemo(()=>seriesBreakdownSelection&&editState.edits!==null?buildCashPlanSeriesBreakdown(data,editState.edits,seriesBreakdownSelection.businessId,seriesBreakdownSelection.month):undefined,[data,editState.edits,seriesBreakdownSelection]);
 const {plan,estimates}=editable;
 const worksheetBusinesses=useMemo(()=>new Map(buildCashPlanWorksheetModel({data,editable,basis,range,asOf,options:estimateOptions}).businesses.map(item=>[item.businessId,item])),[data,editable,basis,range,asOf,estimateOptions]);
 const confirmationRow=useMemo(()=>[...worksheetBusinesses.values()].flatMap(item=>item.rows).find(item=>item.key===confirmingKey&&!item.tax),[worksheetBusinesses,confirmingKey]);
 const previewEdit=useCallback((change:Extract<CashPlanEditChange,{action:'save'}>)=>{
  const existing=editState.edits?.find(item=>item.id===change.id||(item.business_id===change.business_id&&item.source_type===change.source_type&&item.source_key===change.source_key&&item.month===change.month));
  const next={...existing,...change,updated_at:''};
  const edits=[...(editState.edits??[]).filter(item=>item.id!==change.id&&!(item.business_id===change.business_id&&item.source_type===change.source_type&&item.source_key===change.source_key&&item.month===change.month)),next];
  return buildEditableCashPlan(data,range,asOf,edits,estimateOptions).items.find(item=>item.businessId===change.business_id&&item.source_type===change.source_type&&item.source_key===change.source_key&&item.month===change.month);
 },[data,range,asOf,editState.edits,estimateOptions]);
 const estimatesByBusiness=useMemo(()=>new Map(estimates.businesses.map(item=>[item.business.id,item])),[estimates]);
 const visible=useMemo(()=>plan.businesses.filter(item=>biz==='all'||item.business.id===biz),[plan,biz]);
 const selectedPlan=visible.find(item=>item.business.id===selectedBusiness);
 // The provider forecast is a separate scenario. Registered manual income may
 // describe the same deposits, so never add both income sources together.
 const providerForecast=toss.response?.configured===true&&toss.response.lastSyncedAt!==null;
 const forecastPlan=useMemo(()=>providerForecast?tossCashForecastPlan(plan,settlementIncome):plan,[plan,providerForecast,settlementIncome]);
 const projection=useMemo(()=>buildCurrentCashForecast(forecastPlan),[forecastPlan]);
 const unconfirmed=visible.flatMap(item=>item.unconfirmedExpenses??[]);
 const {simulation,error}=useMemo(()=>{
  if(!from||!to||!amount)return {simulation:undefined,error:''};
  try{return {simulation:simulate(data,asOf,from,to,Number(amount),when),error:''};}
  catch(e){return {simulation:undefined,error:e instanceof Error?e.message:'입력을 확인하세요.'};}
 },[data,asOf,from,to,amount,when]);
 return <>
  {editState.edits!==null&&!editState.error?<>
  <Panel title={privateText(planView==='worksheet'?'사업자별 지출 계획표':'사업자별 자금 한눈에 보기')} subtitle={`${plan.range.from} ~ ${plan.range.to} · 단위 원`} className="cash-plan-panel cash-plan-overview" action={<div className="cash-plan-controls"><div className="cash-plan-view-switch" role="group" aria-label="자금계획 표시 방식"><button type="button" aria-pressed={planView==='worksheet'} onClick={()=>setPlanView('worksheet')}>지출 계획표</button><button type="button" aria-pressed={planView==='summary'} onClick={()=>setPlanView('summary')}>자금 요약</button></div><Picker label="지출 산정 기준" value={basis} onChange={value=>setSelectedBasis(value as ExpenseBasis)} options={[{value:'estimated',label:'반복 출금 추정'},{value:'registered',label:'등록된 예정 지출'}]}/><DateRangeControl label="계획" value={range} onChange={applyRange} compact showPresets={false} validateRange={cashPlanPeriodError}/><FundingReportDialog plans={visible} estimates={estimatesByBusiness} basis={basis} range={plan.range} asOf={asOf} incoming={settlementIncome}/></div>}>
   <div className="cash-plan-tools"><div className="cash-plan-sync-actions" role="group" aria-label="자금 자료 동기화"><span className="cash-plan-tool-label">자료 동기화</span><ClobeBalanceSyncButton refresh={refresh} accounts={data.accounts}/><TossSettlementSyncButton state={toss}/><ClobeCardBillsPanel data={data} asOf={asOf} biz={biz} state={editState} range={range}/></div><p className="cash-plan-overview-note">현재 잔액 − 남은 지출{basis==='estimated'?' · 추정 예산':' · 등록 일정'}</p></div>
   {saveError&&<p className="cash-plan-period-error" role="alert"><FinancialText value={saveError}/></p>}
   {basis==='registered'&&unconfirmed.length>0&&<p className="cash-plan-warning" role="status"><TriangleAlert size={16}/><span>지급 확인 필요 {unconfirmed.length}건 · <FinancialValue value={won(unconfirmed.reduce((sum,item)=>sum+item.amount,0))}/><small>지난 일정은 남은 지출에서 제외 · 확인 전 필요자금 미확정</small></span></p>}
   {visible.length?planView==='worksheet'?<CashPlanWorksheet plans={visible} estimates={estimatesByBusiness} worksheetBusinesses={worksheetBusinesses} latestBalances={latestBalances} basis={basis} selectedBusiness={selectedPlan?.business.id||''} onOpenDetail={openBusinessDetail} onEditBusiness={openEditor} onConfirmPayment={openPaymentConfirmation} onEditActualCategory={openActualCategory} confirmingKey={confirmingKey} saving={editState.saving} settlementIncome={settlementIncomeByBusiness}/>:<div className="cash-plan-overview-scroll" tabIndex={0} role="region" aria-label="사업자별 자금 요약표"><table className="cash-plan-overview-table">
    <caption className="sr-only">{basis==='estimated'?'반복 출금을 추정한':'등록된 예정 지출 기준'} 사업자별 잔액과 가용자금. 모든 금액은 원 단위입니다.</caption>
    <thead><tr><th scope="col">사업자</th><th scope="col">현재 기록 잔액<small>최신 거래·Clobe 수집 기준</small></th><th scope="col">{basis==='estimated'?'추정 지출':'예정 지출'}<small>{basis==='estimated'?'확정 청구액 아님':'등록 항목만 반영'}</small></th><th scope="col">지출 후 잔액</th><th scope="col">가용자금<small>유보액 제외</small></th><th scope="col"><span className="sr-only">상세</span></th></tr></thead>
    <tbody>{visible.map(item=>{
     const estimate=estimatesByBusiness.get(item.business.id);
     const latest=latestBalances.get(item.business.id);
     const expenses=basis==='estimated'?(estimate?.total??0):item.expenses;
     const after=basis==='estimated'?(item.balance===null?null:item.balance-expenses):item.afterExpenses;
     const available=basis==='estimated'?(after===null?null:after-item.reserve):item.available;
     const noExpense=basis==='estimated'?(estimate?.dated.length??0)+(estimate?.undated.length??0)===0:item.scheduledExpenses.length+(item.undatedExpenses?.length??0)===0;
     const noExpenseLabel=basis==='estimated'?(estimate?.groups.length?'남은 추정 예산 없음':'반복 거래 없음'):item.registeredItemCount===0?'예정 항목 미등록':'남은 등록 지출 없음';
     return <tr key={item.business.id}>
      <th scope="row"><button type="button" className="cash-plan-overview-company" aria-label={privateText(`${item.business.name} 잔액·지출 상세보기`)} aria-haspopup="dialog" aria-expanded={selectedPlan?.business.id===item.business.id} onClick={event=>openBusinessDetail(item.business.id,event)}><i style={{background:item.business.color}} aria-hidden="true"/>{item.business.name}</button><small>통장 {item.accounts.length}개{item.balance===null?' · 잔액 확인 필요':''}</small></th>
      <td className={latest?.balance==null?'cash-plan-unknown':latest.balance<0?'negative':''}>{(latest?.accounts.length??0)>1?'합계 ':''}<FinancialValue value={money(latest?.balance??null)}/><small>{latestBalanceRecordLabel(latest)}</small><CashAccountBalances business={latest}/>{latest?.balance===null&&latest.accounts.some(account=>account.snapshot.balance!==null)&&<small>확인된 소계 <FinancialValue value={won(latest.knownBalance)}/></small>}</td>
      <td><span className="negative"><FinancialValue value={won(expenses)}/></span>{noExpense&&<small className="cash-plan-overview-missing" aria-label={privateText(`${noExpenseLabel}. 실제 지출이 없다는 뜻은 아닙니다.`)} title="실제 지출이 없다는 뜻은 아닙니다.">{noExpenseLabel}</small>}</td>
      <td className={after===null?'cash-plan-unknown':after<0?'negative':''}><FinancialValue value={money(after)}/></td>
      <td className={`cash-plan-overview-available ${available===null?'cash-plan-unknown':available<0?'negative':''}`}><FinancialValue value={money(available)}/>{(settlementIncomeByBusiness.get(item.business.id)??0)>0&&<small className="positive">토스 예정 +<FinancialValue value={money(settlementIncomeByBusiness.get(item.business.id)!)}/><br/>정산 반영 <FinancialValue value={money(available===null?null:available+settlementIncomeByBusiness.get(item.business.id)!)}/></small>}</td>
      <td><Button type="button" variant="outline" size="sm" aria-label={privateText(`${item.business.name} 계획 편집`)} aria-haspopup="dialog" onClick={event=>openEditor(item.business.id,event)}>계획 편집</Button><Button type="button" variant="ghost" size="sm" className="cash-plan-overview-detail" aria-label={privateText(`${item.business.name} 자금 상세보기`)} aria-haspopup="dialog" aria-expanded={selectedPlan?.business.id===item.business.id} onClick={event=>openBusinessDetail(item.business.id,event)}>상세보기</Button></td>
     </tr>;
    })}</tbody>
   </table></div>:<NoData title="표시할 사업자가 없습니다" text="사업자를 등록하거나 전체 사업자를 선택해주세요." href=""/>}
   <details className="cash-plan-method cash-plan-overview-method"><summary>산정 기준과 확인 사항</summary>
    <p>현재 기록 잔액은 오늘({asOf})까지의 최신 거래 또는 동기화한 Clobe 수집 잔액을 사용합니다. 은행 실시간 잔액은 아니며 각 통장의 잔액 근거일과 수집 시각을 확인하세요.</p>
    <p>현재 기록 잔액에서 선택 기간의 남은 지출을 차감합니다. 등록 일정은 내일부터 반영하며, 오늘까지의 일정은 지급 여부를 알 수 없어 별도 확인 항목으로 남깁니다. 미확인 일정이 있는 사업자는 가용자금과 전체 필요금액을 확정하지 않습니다.</p>
    <p><FinancialText value="가용자금은 지출 후 잔액에서 유보액을 뺀 금액입니다. 예정 항목이나 추정 근거가 없어 표시된 0원은 실제 지출이 없다는 뜻이 아닙니다."/></p>
    {basis==='estimated'&&<><p>{estimates.basis.from} ~ {estimates.basis.to} 중 2개월 이상 반복된 출금을 3개월 월평균으로 추정합니다. 등록된 예정 지출을 중복해서 더하지 않습니다.</p><p>확정 청구액이 아닌 반복 출금 기반 예산입니다. 신규 계약·일회성 지출과 앞으로 들어올 수입은 포함하지 않습니다.</p><p><FinancialText value={estimates.basis.groupingBasis}/></p><ul>{estimates.reminders.map((reminder,index)=><li key={index}><FinancialText value={reminder}/></li>)}</ul><p>설치자가 지정한 추정 제외 항목과 저장된 계획의 제외 설정을 반영합니다. 실제 출금 내역은 유지합니다.</p></>}
   </details>
  </Panel>
  <TossSettlementsPanel state={toss} data={data} biz={biz} range={range}/>
  <Dialog open={!!selectedPlan} onOpenChange={open=>{if(!open)setSelectedBusiness('');}}>
   <DialogContent className="cash-plan-dialog" showCloseButton={false} onCloseAutoFocus={event=>{event.preventDefault();detailTriggerRef.current?.focus({preventScroll:true});}}>
    <DialogClose asChild><Button type="button" variant="ghost" size="icon-xs" className="cash-plan-dialog-close" aria-label="닫기"><X size={16}/></Button></DialogClose>
    <DialogHeader><DialogTitle>{selectedPlan?.business.name} 자금 상세</DialogTitle><DialogDescription>{basis==='estimated'?'반복 출금 추정':'등록된 예정 지출'} · {plan.range.from} ~ {plan.range.to}</DialogDescription></DialogHeader>
    <div className="cash-plan-dialog-body">{selectedPlan&&<CashBusinessCard plan={selectedPlan} estimate={estimatesByBusiness.get(selectedPlan.business.id)} latest={latestBalances.get(selectedPlan.business.id)} basis={basis}/>}</div>
   </DialogContent>
  </Dialog>
  <AccountFundingPanel key={focusDate} plans={visible} estimates={estimatesByBusiness} latestBalances={latestBalances} basis={basis} range={plan.range} asOf={asOf} focusDate={focusDate} incoming={settlementIncome} calendarIncome={calendarIncome} data={data} planItems={editable.items}/>
  <CashPlanSeriesSummary rows={seriesMonths} fromMonth={seriesFromMonth} selectedMonth={range.from.slice(0,7)} onMonthChange={setSelectedSeriesMonth} onSelectMonth={selectSeriesMonth} onOpenBreakdown={openSeriesBreakdown} openedBreakdown={seriesBreakdownSelection} onSync={()=>void syncFixedFromWorksheet()} syncing={syncingFixed} syncDisabled={editState.loading||editState.saving||editState.edits===null||!!editState.error||!!editingBusiness||!!confirmingKey||!!seriesBreakdownSelection} syncError={fixedSyncError}/>
  <div className={basis==='registered'?'analysis-grid':'cash-plan-simulator-only'}>
   {basis==='registered'&&<Panel title={privateText(providerForecast?'토스 정산·예정 지출 반영 잔액 추이':'예정 수입·지출을 반영한 잔액 추이')} subtitle={`${plan.range.from} ~ ${plan.range.to} · ${providerForecast?'수입은 토스 입금 예정만 반영 · 직접 등록 수입 별도':'현재 잔액에 남은 등록 일정 반영'} · 유보액 차감 전`}>
    {visible.some(item=>item.projected!==null&&!item.undatedExpenses?.length)&&projection.length>0?<>
     <FinancialChart><div className="chart-box"><ResponsiveContainer width="100%" height="100%"><LineChart data={projection} margin={{top:20,right:20,bottom:5,left:10}}><CartesianGrid vertical={false} strokeDasharray="3 4"/><XAxis dataKey="date" tickFormatter={d=>d.slice(5)} fontSize={12} minTickGap={45}/><YAxis tickFormatter={compact} fontSize={12}/><Tooltip formatter={v=>won(Number(v))}/><ReferenceLine y={0} stroke="#bd5b54"/>{visible.map(({business})=><Line key={business.id} dataKey={business.id} name={business.name} stroke={business.color} dot={false} strokeWidth={2.5} connectNulls={false}/>)}</LineChart></ResponsiveContainer></div></FinancialChart>
     <div className="forecast-notes">{forecastPlan.businesses.filter(item=>biz==='all'||item.business.id===biz).map(({business,reserve,projected,undatedExpenses})=>{
      if(projected===null||undatedExpenses?.length)return <p key={business.id}>{business.name} · 현재 잔액, 지급일과 지난 일정의 지급 여부 확인 후 표시됩니다.</p>;
      const first=projection.find(point=>point[business.id]!==null&&Number(point[business.id])<reserve);
      return first?<p key={business.id} className="negative"><TriangleAlert size={15}/>{business.name} · {String(first.date)}부터 유보액 미만 예상</p>:null;
     })}</div>
    </>:<NoData title={privateText(range.to<=asOf?'선택 기간이 지났습니다':'예측에 필요한 내역을 확인해주세요')} text={range.to<=asOf?'향후 기간을 선택하면 현재 잔액에서 남은 등록 일정을 반영한 추이를 볼 수 있습니다.':'현재 잔액, 날짜 미정 예산의 지급일과 오늘까지 등록된 일정의 지급 여부를 확인해주세요.'} href=""/>}
   </Panel>}
   <Panel title="자금이동 시뮬레이터" subtitle={`${asOf} 기록 잔액 · 등록 일정 기준 · 계획용 계산`}>
    <div className="simulation-form">
     <label>보내는 사업자</label><Picker label="보내는 사업자" value={from} onChange={setFrom} options={data.businesses.map(b=>({value:b.id,label:b.name}))}/>
     <label>받는 사업자</label><Picker label="받는 사업자" value={to} onChange={setTo} options={data.businesses.map(b=>({value:b.id,label:b.name}))}/>
     <label htmlFor="simulation-amount">금액 (원)</label><FinancialInput id="simulation-amount" type="number" min="1" step="1" value={amount} onChange={event=>setAmount(event.target.value)} placeholder="0"/>
     <label htmlFor="simulation-date">예정일</label><Input id="simulation-date" type="date" min={asOf} max={addDays(asOf,90)} value={when} onChange={event=>setWhen(event.target.value)}/>
     <details className="cash-plan-simulation-note"><summary>시뮬레이션 기준</summary><p>이체일의 등록 수입·지출을 반영합니다. 가용자금은 이체 후 잔액에서 이후 30일의 등록 지출과 유보액을 뺀 금액입니다. 실제 이체는 실행하지 않습니다.</p></details>
     {error&&<p role="alert" className="negative"><FinancialText value={error}/></p>}
     {simulation&&<div className="simulation-result">{[simulation.sender,simulation.receiver].map(b=><div key={b.id}><strong>{b.name}</strong><span>{when} 이체 후 잔액 <b><FinancialValue value={won(b.balance)}/></b></span><span className={b.available<0?'negative':''}>이체 후 30일 가용자금 <b><FinancialValue value={won(b.available)}/></b></span>{b.available<0&&<small className="negative">유보액·등록된 예정 지출을 충당하기 어렵습니다.</small>}</div>)}</div>}
    </div>
   </Panel>
  </div>
  <div className="tax-banner"><Info size={18}/><div><strong>사업자 간 이체 전 계약·이자·증빙을 확인하세요.</strong></div></div>
  </>:<Panel title="공동 지출 계획 설정" subtitle="저장된 수정·제외 설정을 확인한 뒤 자금계획을 계산합니다." action={<ClobeBalanceSyncButton refresh={refresh} accounts={data.accounts}/>}><div className="cash-plan-empty" role={editState.error?'alert':'status'}><p><FinancialText value={editState.error||'공동 계획 설정을 불러오고 있습니다…'}/></p>{editState.error&&<Button type="button" variant="outline" disabled={editState.loading} onClick={()=>void editState.refresh()}>{editState.loading?'다시 불러오는 중…':'설정 다시 불러오기'}</Button>}</div></Panel>}
  <CashPlanSeriesBreakdownDialog open={!!seriesBreakdownSelection} breakdown={seriesBreakdown} data={data} edits={editState.edits} saving={editState.saving} loadError={editState.error} onReload={reloadSeriesBreakdown} onSave={editState.save} onSaveFixedCosts={onSaveFixedCosts} onClose={()=>setSeriesBreakdownSelection(null)} returnFocusRef={seriesBreakdownTriggerRef}/>
  <CashPlanEditorDialog business={data.businesses.find(item=>item.id===editingBusiness)} accounts={data.accounts} categories={data.categories} aliases={data.aliases} items={editable.items} edits={editState.edits??[]} range={range} basis={basis} saving={editState.saving} loadError={editState.error} onReload={editState.refresh} onSave={editState.save} onPreview={previewEdit} onClose={()=>setEditingBusiness('')} returnFocusRef={editTriggerRef}/>
  <CashPlanActualCategoryDialog selection={actualCategorySelection} currentTransaction={data.transactions.find(item=>item.id===actualCategorySelection?.transaction.id)} categories={data.categories} aliases={data.aliases} accountName={data.accounts.find(item=>item.id===actualCategorySelection?.transaction.account_id)?.name||'계좌 미지정'} businessName={data.businesses.find(item=>item.id===actualCategorySelection?.transaction.business_id)?.name||''} refresh={refresh} onClose={()=>setActualCategorySelection(null)} returnFocusRef={actualCategoryTriggerRef}/>
  <PaymentConfirmationDialog row={confirmationRow} business={data.businesses.find(item=>item.id===confirmationRow?.businessId)} accountName={data.accounts.find(item=>item.id===confirmationRow?.accountId)?.name||''} categories={data.categories} aliases={data.aliases} asOf={asOf} saving={editState.saving} loadError={editState.error} onReload={editState.refresh} onSave={editState.save} onClose={()=>setConfirmingKey('')} returnFocusRef={confirmationTriggerRef}/>
 </>;
}
