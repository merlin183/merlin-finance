"use client";
import {useFinancialVisibility,FinancialValue,FinancialText} from './financial-visibility';


import {useMemo,useRef,useState,type MouseEvent} from 'react';
import {CalendarDays,FileChartColumn,Info,Search,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog,DialogClose,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {buildMonthlyReport,monthlyReportMetrics,type MonthlyAmountCell,type MonthlyBusinessReport,type MonthlyMetricId,type MonthlyPlanRow} from '@/lib/finance/monthly-report';
import {monthlyCostComparison,MONTHLY_COST_BENCHMARK_SOURCE} from '@/lib/finance/monthly-cost-benchmarks';
import type {AccountingTransaction} from '@/lib/finance/transaction-accounting';
import type {Dataset} from '@/lib/finance/types';
import {Panel,FinanceLink} from './common';
import type {CashPlanEditState} from './use-cash-plan-edits';
import {IntercompanyRegisterView} from './intercompany-register';
import './monthly-report.css';

type ActualKey=MonthlyMetricId|'otherIncome'|'externalOutflow';
type PlanScope='all'|'dated'|'undated';
type Detail={kind:'actual';key:ActualKey;businessId:string;title:string}|{kind:'plan';scope:PlanScope;businessId:string;title:string}|{kind:'forecast';businessId:string;title:string}|{kind:'check';id:string;title:string};
type PlanDetail=MonthlyPlanRow&{business:MonthlyBusinessReport['business']};
const digits=(value:number)=>value.toLocaleString('ko-KR');
const monthLabel=(month:string)=>`${month.slice(0,4)}년 ${Number(month.slice(5))}월`;
const pageSize=30;

function actualCell(business:MonthlyBusinessReport,key:ActualKey):MonthlyAmountCell{
 return key==='otherIncome'?business.otherIncome:key==='externalOutflow'?business.externalOutflow:business.metrics[key];
}

function Amount({value,label,onClick}:{value:number;label:string;onClick:(event:MouseEvent<HTMLButtonElement>)=>void}){
 const {privateText,privateValue}=useFinancialVisibility();
 return value===0?<span className="monthly-report-zero"><FinancialValue value="0"/></span>:<button type="button" className="monthly-report-amount" aria-label={privateText(String(`${label} ${privateValue(digits(value))}원 근거 보기`))} onClick={onClick}><FinancialValue value={digits(value)}/></button>;
}

function CostComparison({businessName,metric,amount,sales}:{businessName:string;metric:MonthlyMetricId;amount:number;sales:number}){
 const comparison=monthlyCostComparison(businessName,metric,amount,sales);
 if(!comparison)return null;
 const aboveReference=comparison.reference!==null&&comparison.current!==null&&comparison.current>comparison.reference;
 const percent=(value:number|null)=>value===null?'—':`${value.toFixed(1)}%`;
 return <span className="monthly-report-cost-ratio"><span className="sr-only">업종 평균 </span><FinancialValue value={percent(comparison.reference)}/><span aria-hidden="true"> | </span><span className="sr-only"> 현재 비율 </span><strong className={aboveReference?'monthly-report-cost-ratio-exceeded':undefined}><FinancialValue value={percent(comparison.current)}/></strong>{aboveReference&&<span className="sr-only"> 업종 평균 초과</span>}</span>;
}

function TransactionRows({data,rows}:{data:Dataset;rows:AccountingTransaction[]}){
 const businesses=new Map(data.businesses.map(item=>[item.id,item.name]));
 const accounts=new Map(data.accounts.map(item=>[item.id,item]));
 const categories=new Map(data.categories.map(item=>[item.id,item.name]));
 return <div className="monthly-report-detail-scroll" role="region" tabIndex={0} aria-label="월간 보고 근거 거래"><table className="monthly-report-detail-table"><caption className="sr-only">저장된 거래 원장 기준 내역. 이체 수수료 분리 시 비용 성분만 표시합니다.</caption><thead><tr><th scope="col">거래일</th><th scope="col">사업자 · 계좌</th><th scope="col">거래처 · 적요</th><th scope="col">계정과목</th><th scope="col">금액</th></tr></thead><tbody>{rows.map(row=>{
  const account=accounts.get(row.account_id);
  const source=[row.source_details?.basic,row.source_details?.detail,row.source_details?.counterparty,row.source_details?.memo].filter((text,index,all)=>text&&text!==row.description&&all.indexOf(text)===index).join(' · ');
  return <tr key={row.id}><td><time dateTime={row.txn_date}>{row.txn_date}</time>{row.txn_time&&<small>{row.txn_time}</small>}</td><td>{businesses.get(row.business_id)||'사업자 확인 필요'}<small><FinancialText value={String((account?.name||'계좌 확인 필요')||'')}/>{account?.bank?` · ${account.bank}`:''}</small></td><td><strong><FinancialText value={String((row.description||'적요 없음')||'')}/></strong>{source&&<small className="monthly-report-source"><FinancialText value={String((source)||'')}/></small>}{row.accounting_component==='fee'&&<small className="monthly-report-fee">원본 출금 <FinancialValue value={digits(row.accounting_source_amount??0)}/>원 중 이체 수수료</small>}</td><td>{categories.get(row.category_id||'')||'미매핑'}</td><td className={row.direction==='in'?'monthly-report-number monthly-report-income':'monthly-report-number'}><small>{row.direction==='in'?'입금':'출금'}</small><FinancialValue value={digits(row.amount)}/></td></tr>;
 })}</tbody></table></div>;
}

function PlanRows({data,rows}:{data:Dataset;rows:PlanDetail[]}){
 const accounts=new Map(data.accounts.map(item=>[item.id,item]));
 return <div className="monthly-report-detail-scroll" role="region" tabIndex={0} aria-label="월간 보고 남은 지출 계획"><table className="monthly-report-detail-table"><caption className="sr-only">확정 미지급금이 아닌 남은 지출 예산입니다. 이미 반영된 출금을 차감한 금액을 표시합니다.</caption><thead><tr><th scope="col">예정일</th><th scope="col">사업자 · 출금 계좌</th><th scope="col">품목 · 근거</th><th scope="col">남은 예산</th></tr></thead><tbody>{rows.map(row=>{
  const account=accounts.get(row.accountId||'');
  return <tr key={`${row.business.id}:${row.key}`}><td>{row.date?<time dateTime={row.date}>{row.date}</time>:<span className="monthly-report-warning">일자 확인 필요</span>}{!row.date&&row.expectedDate&&<small>원래 예정 {row.expectedDate}</small>}</td><td>{row.business.name}<small><FinancialText value={String((account?.name||'계좌 미지정')||'')}/>{account?.bank?` · ${account.bank}`:''}</small></td><td><strong><FinancialText value={String((row.title)||'')}/></strong><small>{row.sourceType==='manual'?'직접 입력 계획':'반복 출금 추정'} · 월 예산 <FinancialValue value={digits(row.originalAmount)}/>원 · 반영 <FinancialValue value={digits(row.recordedAmount)}/>원</small>{row.memo&&<small className="monthly-report-source"><FinancialText value={String((row.memo)||'')}/></small>}</td><td className="monthly-report-number"><FinancialValue value={digits(row.amount)}/></td></tr>;
 })}</tbody></table></div>;
}

export function MonthlyReportView({data,biz,asOf,editState}:{data:Dataset;biz:string;asOf:string;editState:CashPlanEditState}){
 const {privateText}=useFinancialVisibility();
 const [month,setMonth]=useState(asOf.slice(0,7));
 const [detail,setDetail]=useState<Detail|null>(null);
 const [page,setPage]=useState(0);
 const triggerRef=useRef<HTMLButtonElement|null>(null);
 const report=useMemo(()=>buildMonthlyReport(data,editState.edits??[],month,asOf),[data,editState.edits,month,asOf]);
 const businesses=report.businesses.filter(item=>biz==='all'||item.business.id===biz);
 const checks=report.checks.filter(item=>biz==='all'||item.businessId===biz);
 const plansReady=editState.edits!==null&&!editState.loading&&!editState.error;
 const totals={sales:0,otherIncome:0,externalOutflow:0,remainingDated:0,remainingUndated:0,remainingTotal:0,forecastOutflow:0};
 for(const item of businesses){totals.sales+=item.sales.amount;totals.otherIncome+=item.otherIncome.amount;totals.externalOutflow+=item.externalOutflow.amount;totals.remainingDated+=item.remainingDated;totals.remainingUndated+=item.remainingUndated;totals.remainingTotal+=item.remainingTotal;totals.forecastOutflow+=item.forecastOutflow;}
 const open=(event:MouseEvent<HTMLButtonElement>,selection:Detail)=>{triggerRef.current=event.currentTarget;setPage(0);setDetail(selection);};
 const scopeName=(businessId:string)=>businessId==='all'?'선택 사업자 합계':businesses.find(item=>item.business.id===businessId)?.business.name||'사업자';
 const metricAmount=(key:ActualKey,businessId:string)=>businesses.filter(item=>businessId==='all'||item.business.id===businessId).reduce((sum,item)=>sum+actualCell(item,key).amount,0);
 const actualButton=(key:ActualKey,label:string,businessId='all')=><Amount value={metricAmount(key,businessId)} label={privateText(String(`${scopeName(businessId)} ${label}`))} onClick={event=>open(event,{kind:'actual',key,businessId,title:`${scopeName(businessId)} · ${label}`})}/>;
 const planButton=(scope:PlanScope,label:string,businessId='all')=>{
  if(!plansReady)return <span className="monthly-report-pending"><FinancialText value={String(editState.error?'재조회 필요':'불러오는 중')}/></span>;
  const amount=businesses.filter(item=>businessId==='all'||item.business.id===businessId).reduce((sum,item)=>sum+(scope==='dated'?item.remainingDated:scope==='undated'?item.remainingUndated:item.remainingTotal),0);
  return <Amount value={amount} label={privateText(String(`${scopeName(businessId)} ${label}`))} onClick={event=>open(event,{kind:'plan',scope,businessId,title:`${scopeName(businessId)} · ${label}`})}/>;
 };
 const forecastButton=(businessId='all')=>{
  if(!plansReady)return <span className="monthly-report-pending">—</span>;
  const amount=businesses.filter(item=>businessId==='all'||item.business.id===businessId).reduce((sum,item)=>sum+item.forecastOutflow,0);
  return <Amount value={amount} label={privateText(String(`${scopeName(businessId)} 실적 + 남은 예산`))} onClick={event=>open(event,{kind:'forecast',businessId,title:`${scopeName(businessId)} · 실적 + 남은 예산`})}/>;
 };
 const selectedBusinesses=detail&&'businessId'in detail?businesses.filter(item=>detail.businessId==='all'||item.business.id===detail.businessId):[];
 const detailCheck=detail?.kind==='check'?checks.find(item=>item.id===detail.id):undefined;
 const detailTransactions:AccountingTransaction[]=detail?.kind==='actual'?selectedBusinesses.flatMap(item=>actualCell(item,detail.key).transactions):detail?.kind==='forecast'?selectedBusinesses.flatMap(item=>item.externalOutflow.transactions):detailCheck?.transactions??[];
 const detailPlans:PlanDetail[]=detail?.kind==='plan'||detail?.kind==='forecast'?selectedBusinesses.flatMap(item=>item.remainingPlan.filter(row=>detail.kind!=='plan'||detail.scope==='all'||(detail.scope==='dated'?!!row.date:!row.date)).map(row=>({...row,business:item.business}))):[];
 const sortedTransactions=[...detailTransactions].sort((a,b)=>b.txn_date.localeCompare(a.txn_date)||b.id.localeCompare(a.id));
 const sortedPlans=[...detailPlans].sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999')||a.business.name.localeCompare(b.business.name,'ko')||a.title.localeCompare(b.title,'ko'));
 const detailCount=detail?.kind==='plan'?sortedPlans.length:detail?.kind==='forecast'?0:sortedTransactions.length;
 const pages=Math.max(1,Math.ceil(detailCount/pageSize));
 const currentPage=Math.min(page,pages-1);
 const periodLabel=report.actualRange?`${report.actualRange.from} ~ ${report.actualRange.to}`:'아직 도래하지 않은 월';
 const summaryCards=[{label:'매출 입금',content:actualButton('sales','매출 입금'),note:'저장된 매출 과목만 집계',className:'monthly-report-income'},{label:'실제 외부 출금',content:actualButton('externalOutflow','실제 외부 출금'),note:'이체·대여 원금 제외',className:''},{label:'월말까지 남은 예산',content:planButton('all','남은 지출 예산'),note:'미확정 잔여예산 포함',className:''},{label:'실적 + 남은 예산',content:forecastButton(),note:'원장 실적과 잔여예산 참고 합계',className:'monthly-report-forecast'}];
 return <div className="monthly-report">
  <section className="monthly-report-toolbar panel"><div><h2>{monthLabel(month)} 매출·비용 보고</h2><p>실적 {periodLabel} · 계획 {report.range.from} ~ {report.range.to}</p></div><label className="monthly-report-month"><CalendarDays size={17}/><span>조회 월</span><Input aria-label="월간 보고 조회 월" type="month" value={month} min="2000-01" max="2100-12" onChange={event=>{if(/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)&&event.target.value>='2000-01'&&event.target.value<='2100-12'){setMonth(event.target.value);setDetail(null);setPage(0);}}}/></label></section>
  <div className="monthly-report-kpis">{summaryCards.map(card=><article className={`panel ${card.className}`} key={card.label}><span>{card.label}</span><strong>{card.content}<small>원</small></strong><p><FinancialText value={String((card.note)||'')}/></p></article>)}</div>
  {(!plansReady)&&<div className="monthly-report-load" role={editState.error?'alert':'status'}><p><FinancialText value={String(editState.error?`계획 조회 실패 · 예산 추정 보류. ${editState.error}`:'계획 불러오는 중 · 실적은 조회 가능')}/></p>{editState.error&&<Button size="sm" variant="outline" disabled={editState.loading} onClick={()=>void editState.refresh()}>계획 다시 불러오기</Button>}</div>}
  <Panel title="사업자별 월간 비교" subtitle="단위: 원 · 업종 평균 | 현재 비율 · 평균 초과는 적색" className="monthly-report-comparison">
   <p className="monthly-report-ratio-legend"><span>비율 = 비용 ÷ 매출 입금</span><span>업종 평균 | <strong>현재 비율</strong></span></p>
   <div className="monthly-report-table-scroll" role="region" tabIndex={0} aria-label="사업자별 월간 매출 비용 비교"><table className="monthly-report-table"><caption className="sr-only">사업자별 매출과 비용 과목, 실제 외부 출금, 남은 지출 예산과 실적 + 남은 예산. 현금 입출금 기준이며 순이익이 아닙니다.</caption><thead><tr><th scope="col">구분</th>{businesses.map(item=><th scope="col" key={item.business.id}><span className="monthly-report-business"><i style={{background:item.business.color}}/>{item.business.name}</span><small>마지막 거래 {item.lastTransactionDate||'기록 없음'}</small></th>)}<th scope="col" className="monthly-report-total">합계</th></tr></thead><tbody>
    {monthlyReportMetrics.filter(metric=>!['other','unmapped'].includes(metric.id)||businesses.some(item=>item.metrics[metric.id].amount>0)).map(metric=><tr key={metric.id} className={metric.kind==='income'?'monthly-report-sales-row':''}><th scope="row">{metric.label}<small><FinancialText value={String((metric.description)||'')}/></small></th>{businesses.map(item=><td key={item.business.id}>{actualButton(metric.id,metric.label,item.business.id)}<CostComparison businessName={item.business.name} metric={metric.id} amount={item.metrics[metric.id].amount} sales={item.sales.amount}/></td>)}<td className="monthly-report-total">{actualButton(metric.id,metric.label)}</td></tr>)}
    <tr className="monthly-report-subtotal"><th scope="row">실제 외부 출금 합계<small>위 출금 항목의 합계</small></th>{businesses.map(item=><td key={item.business.id}>{actualButton('externalOutflow','실제 외부 출금',item.business.id)}</td>)}<td className="monthly-report-total">{actualButton('externalOutflow','실제 외부 출금')}</td></tr>
    <tr className="monthly-report-plan-row"><th scope="row">남은 지출 예산<small>현재 잔액에서 앞으로 차감할 예산</small></th>{businesses.map(item=><td key={item.business.id}>{planButton('all','남은 지출 예산',item.business.id)}</td>)}<td className="monthly-report-total">{planButton('all','남은 지출 예산')}</td></tr>
    <tr className="monthly-report-subrow"><th scope="row">날짜 있는 계획</th>{businesses.map(item=><td key={item.business.id}>{planButton('dated','날짜 있는 계획',item.business.id)}</td>)}<td className="monthly-report-total">{planButton('dated','날짜 있는 계획')}</td></tr>
    <tr className="monthly-report-subrow"><th scope="row">일자 확인·잔여예산<small>지난 예정일·일자 미정 포함</small></th>{businesses.map(item=><td key={item.business.id}>{planButton('undated','일자 확인·잔여예산',item.business.id)}</td>)}<td className="monthly-report-total">{planButton('undated','일자 확인·잔여예산')}</td></tr>
    <tr className="monthly-report-forecast-row"><th scope="row">실적 + 남은 예산<small>실제 외부 출금 + 남은 예산</small></th>{businesses.map(item=><td key={item.business.id}>{forecastButton(item.business.id)}</td>)}<td className="monthly-report-total">{forecastButton()}</td></tr>
   </tbody></table></div>
   <p className="monthly-report-table-note monthly-report-benchmark-note">업종 평균(참고): <a href={MONTHLY_COST_BENCHMARK_SOURCE.url} target="_blank" rel="noopener noreferrer"><FinancialText value={String((MONTHLY_COST_BENCHMARK_SOURCE.title)||'')}/></a> · 권장 목표 아님 · 매출이 없으면 —</p>
   <details className="monthly-report-method"><summary>업종 비교·집계 기준</summary><div><p>판관비 급여·임차료·광고선전비 비율이며, 통장 현금과 회계 기준은 다릅니다. 업종 참고치는 설치자가 연결한 사업자에만 표시합니다. 통계의 법인·개인 범위와 사업의 실제 업종을 확인하세요.</p><p>실적 + 남은 예산은 원장에 없는 지급 확인액을 포함하지 않습니다. 마지막 거래일은 저장된 거래 기준이며 은행 수집 완료나 자료의 완전성을 뜻하지 않습니다. 다른 달의 세금·지출은 제외합니다.</p></div></details>
  </Panel>
  {totals.otherIncome>0&&<div className="monthly-report-other-income panel"><div><strong>매출 외 입금</strong><p>수수료·환불 등 · 매출 합계에서 제외</p></div>{actualButton('otherIncome','매출 외 입금')}</div>}
  <IntercompanyRegisterView data={data} biz={biz} month={month} asOf={asOf}/>
  <Panel title={privateText(String(`분류·용도 확인 ${checks.length}건`))} subtitle="근거를 확인하고 거래내역에서 분류를 수정하세요.">
   {checks.length?<div className="monthly-report-checks">{checks.map(check=><article key={check.id}><Info size={17}/><div><strong>{businesses.find(item=>item.business.id===check.businessId)?.business.name} · <FinancialText value={String((check.title)||'')}/></strong><p><FinancialText value={String((check.detail)||'')}/></p></div><Button size="sm" variant="outline" onClick={event=>open(event,{kind:'check',id:check.id,title:check.title})}><Search size={14}/>거래 확인</Button></article>)}</div>:<p className="monthly-report-no-checks">자동 확인 대상 없음 · 분류·누락 검증 완료를 뜻하지 않음</p>}
  </Panel>
  <details className="monthly-report-notes panel"><summary><FileChartColumn size={17}/>보고 기준</summary><div><ul>{report.notes.map(note=><li key={note}><FinancialText value={note}/></li>)}</ul><p>분류 수정: <FinanceLink href={`/transactions?biz=${encodeURIComponent(biz)}`}>거래 내역</FinanceLink> · 예산 수정: <FinanceLink href={`/cash-utilization?biz=${encodeURIComponent(biz)}`}>가용자금 계획</FinanceLink></p></div></details>
  <Dialog open={detail!==null} onOpenChange={open=>{if(!open)setDetail(null);}}><DialogContent className="monthly-report-dialog" showCloseButton={false} onCloseAutoFocus={event=>{event.preventDefault();triggerRef.current?.focus({preventScroll:true});}}><DialogHeader><div className="monthly-report-dialog-heading"><DialogTitle><FinancialText value={String((detail?.title)||'')}/></DialogTitle><DialogClose asChild><Button size="icon" variant="ghost" aria-label="월간 보고 상세 닫기"><X size={19}/></Button></DialogClose></div><DialogDescription>{detail?.kind==='plan'?'남은 예산 · 지급액·환율 차이 포함 가능 · 확정 미지급금 아님':detail?.kind==='forecast'?'실제 출금과 남은 예산 · 직접 출금 확인은 예산에서만 차감':`${periodLabel} · 저장된 계정과목 기준 · ${sortedTransactions.length}건`}</DialogDescription></DialogHeader>
   {detailCheck&&<p className="monthly-report-dialog-check"><FinancialText value={String((detailCheck.detail)||'')}/></p>}
   {detail?.kind==='forecast'?<div className="monthly-report-forecast-detail"><section><h3>실제 외부 출금 <b><FinancialValue value={digits(sortedTransactions.reduce((sum,row)=>sum+row.amount,0))}/>원</b></h3><TransactionRows data={data} rows={sortedTransactions}/></section><section><h3>남은 지출 예산 <b><FinancialValue value={digits(sortedPlans.reduce((sum,row)=>sum+row.amount,0))}/>원</b></h3>{sortedPlans.length?<PlanRows data={data} rows={sortedPlans}/>:<p className="monthly-report-empty">남은 예산이 없습니다.</p>}</section></div>:detail?.kind==='plan'?<><div className="monthly-report-detail-total">남은 예산 <strong><FinancialValue value={digits(sortedPlans.reduce((sum,row)=>sum+row.amount,0))}/>원</strong></div><PlanRows data={data} rows={sortedPlans.slice(currentPage*pageSize,(currentPage+1)*pageSize)}/></>:<><div className="monthly-report-detail-total">합계 <strong><FinancialValue value={digits(sortedTransactions.reduce((sum,row)=>sum+row.amount,0))}/>원</strong></div><TransactionRows data={data} rows={sortedTransactions.slice(currentPage*pageSize,(currentPage+1)*pageSize)}/></>}
   <div className="monthly-report-dialog-footer"><span>{detail?.kind==='forecast'?'실적과 예산을 합산한 지출 추정입니다. 순이익이 아닙니다.':`${currentPage+1} / ${pages} · ${detailCount}건`}</span><div>{pages>1&&<><Button size="sm" variant="outline" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>이전</Button><Button size="sm" variant="outline" disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>다음</Button></>}<DialogClose asChild><Button size="sm" variant="outline">닫기</Button></DialogClose></div></div>
  </DialogContent></Dialog>
 </div>;
}
