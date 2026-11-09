import {FinancialValue,FinancialText,useFinancialVisibility} from './financial-visibility';
import {useMemo,useState} from 'react';
import {ClipboardList,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogClose,DialogContent,DialogDescription,DialogHeader,DialogTitle,DialogTrigger} from '@/components/ui/dialog';
import {buildFundingReport,type FundingReportBusiness,type FundingReportRow} from '@/lib/finance/funding-report';
import type {CashPlanBusiness} from '@/lib/finance/cash-plan';
import type {CashEstimateBusiness} from '@/lib/finance/cash-estimates';
import type {DateRange} from '@/lib/finance/date-range';
import type {Account} from '@/lib/finance/types';
import type {AccountFundingItem,AccountFundingIncome} from '@/lib/finance/account-funding';
import './funding-report-dialog.css';

type ReportProps={plans:CashPlanBusiness[];estimates:Map<string,CashEstimateBusiness>;basis:'registered'|'estimated';range:DateRange;asOf:string;incoming?:AccountFundingIncome[]};
const digits=(value:number)=>value.toLocaleString('ko-KR');
const money=(value:number|null)=>value===null?'확인 필요':`${digits(value)}원`;
const dateLabel=(date:string)=>`${Number(date.slice(5,7))}월 ${Number(date.slice(8))}일`;
const accountLabel=(account:Account)=>[account.bank,account.masked_number].filter(Boolean).join(' · ')||'은행·계좌번호 확인 필요';

function ItemReasons({items}:{items:AccountFundingItem[]}){
 const list=<ul className="funding-report-reasons">{items.map(item=><li key={item.key}><span><FinancialText value={item.title}/></span><b><FinancialValue value={digits(item.amount)}/>원</b></li>)}</ul>;
 return items.length>2?<details className="funding-report-reasons-more"><summary><FinancialText value={items.slice(0,2).map(item=>item.title).join(', ')}/> 외 {items.length-2}건</summary>{list}</details>:list;
}

function FundingRows({report}:{report:FundingReportBusiness}){
 const {privateText}=useFinancialVisibility();
 return <div className="funding-report-table-scroll" role="region" tabIndex={0} aria-label={privateText(`${report.funding.business.name} 날짜별 필요자금`)}><table className="funding-report-table">
  <caption className="sr-only">날짜별 추가 보충액과 해당 계좌의 누적 필요액. 누적 금액은 합산하지 않습니다. 금액 단위는 원입니다.</caption>
  <thead><tr><th scope="col">보충 필요일<small>예상 출금 전</small></th><th scope="col">계좌</th><th scope="col">그날 추가 보충액</th><th scope="col">계좌 누적 필요액</th><th scope="col">지급 사유 / 해당일 지출</th></tr></thead>
  <tbody>{report.rows.map(row=><FundingRow key={`${row.account.id}:${row.date}`} row={row}/>)}</tbody>
 </table></div>;
}

function FundingRow({row}:{row:FundingReportRow}){
 return <tr>
  <th scope="row"><time dateTime={row.date}>{dateLabel(row.date)}</time><small>{row.date}</small>{row.initialShortfall&&<span className="funding-report-badge">현재 음수 잔액 포함</span>}</th>
  <td><strong><FinancialText value={row.account.name}/></strong><small><FinancialText value={accountLabel(row.account)}/></small></td>
  <td className={`funding-report-money ${row.additionalTopUp===null?'funding-report-unknown':'negative'}`}><strong><FinancialValue value={money(row.additionalTopUp)}/></strong></td>
  <td className="funding-report-money"><FinancialValue value={money(row.cumulativeTopUp)}/><small>이 계좌 · {dateLabel(row.date)}까지</small></td>
  <td className="funding-report-reason-cell">{row.categoryNames.length>0&&<p className="funding-report-categories">{row.categoryNames.join(' · ')}</p>}{row.items.length>0?<><ItemReasons items={row.items}/><small>해당일 지출 합계 <FinancialValue value={money(row.expenses)}/></small></>:<p>음수 잔액의 보충이 필요합니다.</p>}{row.initialShortfall&&<small>음수 잔액 보충 포함 · 새 지출 아님</small>}</td>
 </tr>;
}

function UndatedBudget({report}:{report:FundingReportBusiness}){
 const {privateText}=useFinancialVisibility();
 const undatedUnassigned=report.unassignedItems.filter(item=>item.date===null);
 const total=report.undatedAccounts.reduce((sum,account)=>sum+account.expenses,undatedUnassigned.reduce((sum,item)=>sum+item.amount,0));
 if(total===0)return null;
 return <section className="funding-report-pending" aria-label={privateText(`${report.funding.business.name} 날짜 미정 예산`)}>
  <header><h4>지급일을 먼저 확인할 예산</h4><strong><FinancialValue value={digits(total)}/>원</strong></header>
  <p>기간 합계에 포함 · 날짜별 보충액 제외 · 지급일 확인 필요</p>
  {report.undatedAccounts.map(item=><details key={item.account.id}><summary><span><FinancialText value={item.account.name}/><small><FinancialText value={accountLabel(item.account)}/></small></span><strong><FinancialValue value={digits(item.expenses)}/>원 · {item.items.length}건</strong></summary>{item.categoryNames.length>0&&<p className="funding-report-categories">{item.categoryNames.join(' · ')}</p>}<ItemReasons items={item.items}/></details>)}
  {undatedUnassigned.length>0&&<details><summary><span>출금 계좌도 확인 필요</span><strong><FinancialValue value={digits(undatedUnassigned.reduce((sum,item)=>sum+item.amount,0))}/>원</strong></summary><ItemReasons items={undatedUnassigned}/></details>}
 </section>;
}

function BusinessReport({report}:{report:FundingReportBusiness}){
 const {privateText}=useFinancialVisibility();
 const {funding}=report;
 const unknown=funding.accounts.filter(account=>account.requiredTopUp===null);
 const unassignedDated=report.unassignedItems.filter(item=>item.date!==null);
 const unconfirmed=funding.unconfirmedItems??[];
 const alreadyNegative=funding.accounts.some(account=>account.snapshot.balance!==null&&account.snapshot.balance<0);
 return <section className="funding-report-business" aria-label={privateText(`${funding.business.name} 필요자금 보고`)}>
  <header className="funding-report-business-head"><h3><i style={{background:funding.business.color}} aria-hidden="true"/>{funding.business.name}</h3><span>통장 {funding.accounts.length}개</span></header>
  <dl className="funding-report-business-summary">
   <div><dt>기간 전체 추가 필요금액</dt><dd className={report.requiredTopUp===null?'funding-report-unknown':report.requiredTopUp>0?'negative':''}><FinancialValue value={money(report.requiredTopUp)}/></dd>{report.requiredTopUp===null&&<small>확인된 계좌 소계 <FinancialValue value={money(report.knownRequiredTopUp)}/></small>}</div>
   <div><dt>{alreadyNegative?'현재 잔액 부족':'날짜 확인된 첫 보충 필요일'}</dt><dd>{alreadyNegative?'현재 부족분 보충 필요':report.earliestFundingDate?<time dateTime={report.earliestFundingDate}>{dateLabel(report.earliestFundingDate)}</time>:report.fundingDateIncomplete?'확인 필요':'날짜별 추가금 없음'}</dd><small>{alreadyNegative?'현재 음수 잔액의 보충 포함':report.fundingDateIncomplete?'지급 여부·날짜·계좌 미확인 항목 확인':'확인된 출금 예상일 기준'}</small></div>
   <div><dt>날짜별 보충 계획 합계</dt><dd><FinancialValue value={money(report.datedRequiredTopUp)}/></dd>{report.datedRequiredTopUp===null?<small>계산 가능 소계 <FinancialValue value={money(report.knownDatedRequiredTopUp)}/></small>:<small>기간 전체 필요금액에 포함된 금액</small>}</div>
  </dl>
  {funding.accounts.length===0&&<p className="funding-report-warning">계좌 미등록 · 통장별 필요금액 계산 불가</p>}
  {unknown.length>0&&<p className="funding-report-warning"><FinancialText value={unknown.map(item=>`${item.account.name} (${accountLabel(item.account)})`).join(', ')}/> · 잔액·출금 계좌·지난 일정 확인 필요</p>}
  {unconfirmed.length>0&&<section className="funding-report-pending" aria-label={privateText(`${funding.business.name} 지급 여부 미확인 일정`)}><header><h4>지난 등록 일정 지급 확인 필요</h4><strong>{unconfirmed.length}건 · <FinancialValue value={money(unconfirmed.reduce((sum,item)=>sum+item.amount,0))}/></strong></header><p>오늘까지 등록된 일정으로, 지급 여부를 알 수 없어 남은 지출에서 제외했습니다. 확인 전까지 전체 필요금액을 확정하지 않습니다.</p><ul className="funding-report-unassigned">{unconfirmed.map(item=><li key={item.key}><time dateTime={item.date??undefined}>{item.date}</time><span><FinancialText value={item.title}/></span><strong><FinancialValue value={money(item.amount)}/></strong></li>)}</ul></section>}
  {report.rows.length>0?<FundingRows report={report}/>:funding.accounts.length>0&&<p className="funding-report-empty">날짜가 정해진 지출에서는 계산 가능한 추가 보충 내역이 없습니다.{report.fundingDateIncomplete?' 아래 미확인 항목을 먼저 확인하세요.':' 새로운 지출이나 실제 잔액 변동은 별도 확인이 필요합니다.'}</p>}
  <UndatedBudget report={report}/>
  {unassignedDated.length>0&&<section className="funding-report-pending" aria-label={privateText(`${funding.business.name} 계좌 미지정 지출`)}><header><h4>출금 계좌를 확인할 지출</h4><strong><FinancialValue value={digits(unassignedDated.reduce((sum,item)=>sum+item.amount,0))}/>원</strong></header><p>지출일은 있으나 출금 통장이 지정되지 않아 통장별 보충액을 계산하지 않았습니다.</p><ul className="funding-report-unassigned">{unassignedDated.map(item=><li key={item.key}><time dateTime={item.date!}>{item.date}</time><span><FinancialText value={item.title}/></span><strong><FinancialValue value={money(item.amount)}/></strong></li>)}</ul></section>}
 </section>;
}

function FundingReportBody({plans,estimates,basis,range,asOf,incoming}:ReportProps){
 const report=useMemo(()=>buildFundingReport(plans,estimates,basis,range,asOf,incoming),[plans,estimates,basis,range,asOf,incoming]);
 return <>
  <div className="funding-report-total"><div><span>기간 전체 추가 필요자금</span><strong className={report.requiredTopUp===null?'funding-report-unknown':report.requiredTopUp>0?'negative':''}><FinancialValue value={money(report.requiredTopUp)}/></strong>{report.requiredTopUp===null&&<small>계산 가능한 계좌 소계 <FinancialValue value={money(report.knownRequiredTopUp)}/></small>}</div><p>사업자 {report.businesses.length}개<br/>날짜 미정 예산 <b><FinancialValue value={money(report.undatedExpenses)}/></b> 포함</p></div>
  <p className="funding-report-method">앞선 부족액을 채웠다면 <strong>그날 추가 보충액</strong>, 아직 입금하지 않았다면 <strong>계좌 누적 필요액</strong>을 확인하세요. 누적액은 날짜별 합산하지 않습니다.{incoming?.length?' 토스 예정액은 지급일부터 반영합니다.':''}</p>
  {report.businesses.length>0&&<div className="funding-report-table-scroll funding-report-overview-scroll" role="region" tabIndex={0} aria-label="사업자별 필요자금 요약"><table className="funding-report-overview">
   <caption className="sr-only">선택한 모든 사업자의 기간 전체 필요금액, 첫 보충 예상일과 날짜 미정 예산</caption>
   <thead><tr><th scope="col">사업자</th><th scope="col">기간 전체 추가 필요금액</th><th scope="col">날짜 확인된 첫 보충일</th><th scope="col">날짜 미정 예산</th></tr></thead>
   <tbody>{report.businesses.map(business=>{const alreadyNegative=business.funding.accounts.some(account=>account.snapshot.balance!==null&&account.snapshot.balance<0);return <tr key={business.funding.business.id}>
    <th scope="row"><i style={{background:business.funding.business.color}} aria-hidden="true"/>{business.funding.business.name}</th>
    <td className={business.requiredTopUp===null?'funding-report-unknown':business.requiredTopUp>0?'negative':''}><strong><FinancialValue value={money(business.requiredTopUp)}/></strong>{business.requiredTopUp===null&&<small>계산 가능 소계 <FinancialValue value={money(business.knownRequiredTopUp)}/></small>}</td>
    <td>{alreadyNegative?'현재 잔액 부족':business.earliestFundingDate?<time dateTime={business.earliestFundingDate}>{dateLabel(business.earliestFundingDate)}</time>:business.fundingDateIncomplete?'확인 필요':'날짜별 추가금 없음'}{business.fundingDateIncomplete&&<small>지급 여부·날짜·계좌 미확인 항목 별도</small>}</td>
    <td><FinancialValue value={money(business.timeline.undatedExpenses)}/></td>
   </tr>;})}</tbody>
  </table></div>}
  {report.businesses.length>0?report.businesses.map(business=><BusinessReport key={business.funding.business.id} report={business}/>):<p className="funding-report-empty">선택한 사업자가 없어 필요자금을 계산할 수 없습니다.</p>}
  <details className="funding-report-method funding-report-footer"><summary>금액과 날짜의 계산 기준</summary><p>오늘({asOf})까지 동기화된 현재 기록 잔액에서 남은 지출을 차감합니다. {incoming?.length?'토스 입금 예정액은 계좌·지급일에 맞춰 반영했습니다. 그 밖의 예정 수입·다른 통장 여유금·유보액은 제외합니다.':'다른 통장의 여유금, 예정 수입과 사업자 유보액은 반영하지 않았습니다.'} 은행 실시간 잔액은 아니므로 최신 통장 기록과 청구 금액을 확인하세요.</p><p>{basis==='estimated'?'과거 반복 출금 예산에서 같은 거래처의 반영 실적을 뺀 잔여 예산이며 확정 지급 의무나 청구 금액이 아닙니다. 예상일이 지났어도 남은 예산은 날짜 미정으로 유지합니다.':'내일부터의 등록 일정을 반영합니다. 오늘까지의 일정은 지급 여부를 알 수 없어 별도로 표시하며, 확인 전까지 전체 필요금액을 확정하지 않습니다.'} 보충 필요일은 출금이 예상되는 날짜를 표시한 것이며, 실제 자동이체 시각이나 휴일을 반영한 입금 마감일은 아닙니다. 실제 출금 전에 자금을 준비하세요.</p><p>날짜 미정 예산은 기간 전체 필요액에 포함하지만 날짜별 계산에서는 제외합니다. 출금 계좌 미지정 지출과 잔액 미확인은 계산 가능한 소계와 구분합니다. 현재 음수 잔액 보충은 표시되는 첫날에 포함하며 새 출금으로 간주하지 않습니다.</p></details>
 </>;
}

export function FundingReportDialog(props:ReportProps){
 const [open,setOpen]=useState(false);
 return <Dialog open={open} onOpenChange={setOpen}>
  <DialogTrigger asChild><Button type="button" className="funding-report-trigger"><ClipboardList size={16} aria-hidden="true"/>필요자금확인</Button></DialogTrigger>
  <DialogContent className="funding-report-dialog" showCloseButton={false}>
   <DialogHeader className="funding-report-header"><div><DialogTitle>사업자별 필요자금 확인</DialogTitle><DialogDescription>{props.range.from} ~ {props.range.to} · {props.plans.length===1?props.plans[0].business.name:`선택 사업자 ${props.plans.length}개`} · {props.basis==='estimated'?'남은 반복 출금 추정':'남은 등록 예정 지출'}<br/>현재 기록 잔액 기준 · 금액 단위: 원</DialogDescription></div><DialogClose asChild><Button type="button" variant="ghost" size="icon" aria-label="필요자금 확인 닫기"><X size={19}/></Button></DialogClose></DialogHeader>
   <div className="funding-report-body">{open&&<FundingReportBody {...props}/>}</div>
  </DialogContent>
 </Dialog>;
}
