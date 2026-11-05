import {memo,useMemo,type MouseEvent} from 'react';
import {Button} from '@/components/ui/button';
import {CashAccountBalances} from './cash-account-balances';
import type {CashPlanBusiness} from '@/lib/finance/cash-plan';
import type {CashEstimateBusiness} from '@/lib/finance/cash-estimates';
import type {CashPlanWorksheetActualOnlyRow,CashPlanWorksheetBusiness,CashPlanWorksheetRow} from '@/lib/finance/cash-plan-worksheet-model';
import {latestBalanceRecordLabel,type LatestCashBusiness} from '@/lib/finance/latest-cash-balances';

type WorksheetProps={
 plans:CashPlanBusiness[];
 estimates:Map<string,CashEstimateBusiness>;
 worksheetBusinesses:Map<string,CashPlanWorksheetBusiness>;
 latestBalances:Map<string,LatestCashBusiness>;
 basis:'registered'|'estimated';
 selectedBusiness:string;
 onOpenDetail:(businessId:string,event:MouseEvent<HTMLButtonElement>)=>void;
 onEditBusiness:(businessId:string,event:MouseEvent<HTMLButtonElement>)=>void;
 onConfirmPayment?:(row:CashPlanWorksheetRow,event:MouseEvent<HTMLButtonElement>)=>void;
 confirmingKey?:string;
 saving?:boolean;
 settlementIncome?:Map<string,number>;
};
const digits=(value:number)=>value.toLocaleString('ko-KR');
const balanceText=(value:number|null)=>value===null?'확인 필요':digits(value);
const paymentDateText=(date:string)=>`${Number(date.slice(5,7))}/${Number(date.slice(8))}`;

function RecordedPaymentDates({row}:{row:CashPlanWorksheetRow}){
 const dates=row.recordedPaymentDates;
 // When a manual amount exceeds source actuals, those actuals have separate
 // dated read-only rows instead of repeating them under the confirmation.
 if(!row.displayDateIsActual||dates.length<2)return null;
 return <details className="cash-worksheet-payment-dates"><summary>실제 지급 {dates.length}일</summary><ul>{dates.map(payment=><li key={payment.date}><time dateTime={payment.date}>{paymentDateText(payment.date)}</time><span>{digits(payment.amount)}원</span></li>)}</ul></details>;
}

function WorksheetItemTitle({row,plannedAccount}:{row:CashPlanWorksheetRow;plannedAccount:string}){
 const actualDate=row.displayDateIsActual;
 const moved=actualDate&&row.sourceAccountId!==null&&row.sourceAccountId!==row.accountId;
 return <>
  {row.tax&&<span className="cash-worksheet-tax-badge">세금 · 납부기한</span>}
  {row.displayDate?<><time dateTime={row.displayDate}>{Number(row.displayDate.slice(5,7))}월 {Number(row.displayDate.slice(8))}일</time>{actualDate&&row.recordedPaymentDates.length>1&&<span className="cash-worksheet-other-payment-dates"> 외 {row.recordedPaymentDates.length-1}일</span>}</>:<span className="cash-worksheet-undated">{row.from.slice(5).replace('-','/')} ~ {row.to.slice(5).replace('-','/')}</span>}
  {' '}<span>{row.title}</span>
  {actualDate&&<><span className="cash-worksheet-actual-date-badge">실제 출금</span>{row.remainingAmount>0&&<span className="cash-worksheet-remaining-month-budget" title={row.date?`남은 계획 지급일 ${row.date}`:`${row.from} ~ ${row.to} · 남은 월 예산의 지급일은 미정입니다.`}>{row.date?<>남은 예정 {row.date!==row.displayDate&&<><time dateTime={row.date}>{paymentDateText(row.date)}</time>{' '}</>}{digits(row.remainingAmount)}</>:<>남은 월예산 {digits(row.remainingAmount)} <span>· 일자 미정</span></>}{moved&&<small>예정 계좌 {plannedAccount}</small>}</span>}</>}
  <RecordedPaymentDates row={row}/>
 </>;
}

function ActualOnlyWorksheetRow({row,account}:{row:CashPlanWorksheetActualOnlyRow;account:string}){
 return <tr className="cash-worksheet-actual-only-row">
  <th scope="row"><time dateTime={row.date}>{Number(row.date.slice(5,7))}월 {Number(row.date.slice(8))}일</time>{' '}<span title={row.description}>{row.title}</span><span className="cash-worksheet-actual-date-badge">실제 출금</span>{row.isInternal&&<span className="cash-worksheet-internal-tag">내부 자금 이동</span>}</th>
  <td className="cash-worksheet-amount">{digits(row.amount)}</td>
  <td className="cash-worksheet-note"><span className="cash-worksheet-source">{account}</span><span className="cash-worksheet-actual-only-source">{row.source==='bank-query'?'은행 조회':'통장 거래'}</span>{row.categoryName&&<span className="cash-worksheet-actual-only-category">{row.categoryName}</span>}</td>
 </tr>;
}

const BusinessWorksheet=memo(function BusinessWorksheet({plan,estimate,worksheet,latest,basis,selectedBusiness,onOpenDetail,onEditBusiness,onConfirmPayment,confirmingKey,saving,settlementIncome=0}:{
 plan:CashPlanBusiness;estimate:CashEstimateBusiness|undefined;
 worksheet:CashPlanWorksheetBusiness|undefined;
 latest:LatestCashBusiness|undefined;
 basis:WorksheetProps['basis'];selectedBusiness:string;onOpenDetail:WorksheetProps['onOpenDetail'];
 onEditBusiness:WorksheetProps['onEditBusiness'];
 onConfirmPayment:WorksheetProps['onConfirmPayment'];confirmingKey:WorksheetProps['confirmingKey'];saving:WorksheetProps['saving'];
 settlementIncome?:number;
}){
 const estimated=basis==='estimated';
 const rows=worksheet?.rows??[];
 const actualOnlyRows=worksheet?.actualOnlyRows??[];
 const reviewRows=[...rows.map(row=>({kind:'plan' as const,row,key:row.key,date:row.displayDate,title:row.title})),...actualOnlyRows.map(row=>({kind:'actual' as const,row,key:row.key,date:row.date,title:row.title}))]
  .sort((left,right)=>(left.date??'9999').localeCompare(right.date??'9999')||left.title.localeCompare(right.title)||left.key.localeCompare(right.key));
 const accounts=useMemo(()=>new Map(plan.accounts.map(({account})=>[account.id,account.name])),[plan.accounts]);
 const total=estimated?(estimate?.total??0):plan.expenses;
 const after=estimated?(plan.balance===null?null:plan.balance-total):plan.afterExpenses;
 const available=estimated?(after===null?null:after-plan.reserve):plan.available;
 const unconfirmed=estimated?[]:plan.unconfirmedExpenses??[];
 const name=plan.business.name;
 return <section className="cash-worksheet-business" aria-label={`${name} 지출 계획표`}>
  <header className="cash-worksheet-heading">
   <h3><i style={{background:plan.business.color}} aria-hidden="true"/>{name}</h3>
   <div className="cash-worksheet-heading-actions"><Button type="button" variant="outline" size="sm" aria-label={`${name} 계획 편집`} aria-haspopup="dialog" onClick={event=>onEditBusiness(plan.business.id,event)}>계획 편집</Button><Button type="button" variant="ghost" size="sm" className="cash-plan-overview-detail" aria-label={`${name} 자금 상세보기`} aria-haspopup="dialog" aria-expanded={selectedBusiness===plan.business.id} onClick={event=>onOpenDetail(plan.business.id,event)}>상세보기</Button></div>
  </header>
  <div className="cash-worksheet-count"><span>기간 전체 계획 · {rows.length}건{actualOnlyRows.length>0&&<> · 별도 실제 {actualOnlyRows.length}건</>}</span> <span>단위: 원</span></div>
  <div className="cash-worksheet-rows" role="region" aria-label={`${name} 지출 항목. 항목이 많으면 위아래로 이동할 수 있습니다.`} tabIndex={0}>
   <table className="cash-worksheet-table">
    <caption className="sr-only">{name} {estimated?'추정':'등록'} 지출 계획. 추정액과 반영 출금이 다르면 추정액에 취소선을 긋고 반영 출금을 표시합니다. 지난 날짜도 유지하며 잔액에서는 남은 예산만 차감합니다.</caption>
    <colgroup><col className="cash-worksheet-item-col"/><col className="cash-worksheet-money-col"/><col className="cash-worksheet-note-col"/></colgroup>
    <thead><tr><th scope="col">품목</th><th scope="col">금액</th><th scope="col">비고</th></tr></thead>
    <tbody>{reviewRows.length?reviewRows.map(entry=>{
     if(entry.kind==='actual')return <ActualOnlyWorksheetRow key={entry.key} row={entry.row} account={accounts.get(entry.row.accountId)||'계좌 미지정'}/>;
     const row=entry.row;
     return <tr key={entry.key} className={row.tax?'cash-worksheet-tax-row':''}>
     <th scope="row"><WorksheetItemTitle row={row} plannedAccount={accounts.get(row.accountId??'')||'계좌 미지정'}/></th>
     <td className="cash-worksheet-amount">{row.recordedAmount!==null&&row.recordedAmount>0&&row.recordedAmount!==row.originalAmount?<><del className="cash-worksheet-estimate-changed"><span className="sr-only">추정 금액 </span>{digits(row.originalAmount)}</del><span className="cash-worksheet-actual"><span className="sr-only">반영 출금 </span>{digits(row.recordedAmount)}</span></>:digits(row.originalAmount)}</td>
     <td className="cash-worksheet-note">
      <span className={`cash-worksheet-payment-status cash-worksheet-payment-${row.status}`} title={row.status==='confirmed'||row.status==='confirmed-partial'?row.statusLabel:row.reconciliationReason||row.statusLabel}>{row.tax&&row.status==='paid'?'납부 완료':row.status==='confirmed'?'확인 완료':row.status==='confirmed-partial'?'일부 확인':row.status==='confirmation-needed'||row.recordedAmount===null?'확인 필요':row.recordedAmount>0?'출금 반영':'미반영'}</span>
      <span className="cash-worksheet-source">{accounts.get((row.displayDateIsActual?(row.sourceAccountId??row.accountId):row.accountId)??'')||'계좌 미지정'}</span>
      {!row.tax&&onConfirmPayment&&<Button type="button" variant="outline" size="sm" className="cash-worksheet-confirm-button" aria-label={`${name} ${row.title} 출금 확인${row.confirmation?' 수정':''}`} aria-haspopup="dialog" disabled={saving} onClick={event=>onConfirmPayment(row,event)}>{saving&&confirmingKey===row.key?'저장 중…':row.confirmation?'수정':'확인'}</Button>}
     </td>
    </tr>;}):<tr><td colSpan={3} className="cash-worksheet-empty">선택 기간에 표시할 계획이 없습니다.<small>제외한 항목은 계획 편집에서 확인할 수 있습니다.</small></td></tr>}</tbody>
   </table>
  </div>
  <div className="cash-worksheet-total"><strong>남은 지출 합계</strong><b>{digits(total)}</b></div>
  {unconfirmed.length>0&&<p className="cash-worksheet-pending" title="지난 일정은 남은 지출 합계에서 제외했습니다. 상세보기에서 지급 여부를 확인하세요.">지난 일정 확인 {unconfirmed.length}건 · {digits(unconfirmed.reduce((sum,item)=>sum+item.amount,0))}원</p>}
  <dl className="cash-worksheet-balances">
   <div className="cash-worksheet-current"><dt>현재 기록 잔액{(latest?.accounts.length??0)>1?' · 합계':''}<small>{latestBalanceRecordLabel(latest)}</small></dt><dd className={latest?.balance==null?'cash-plan-unknown':latest.balance<0?'negative':''}>{balanceText(latest?.balance??null)}{latest?.balance===null&&latest.accounts.some(item=>item.snapshot.balance!==null)&&<small>확인된 소계 {digits(latest.knownBalance)}</small>}</dd></div>
   {(latest?.accounts.length??0)>0&&<div className="cash-worksheet-account-breakdown"><dt className="sr-only">계좌별 잔액</dt><dd><CashAccountBalances business={latest}/></dd></div>}
   <div><dt>지출 후 잔액</dt><dd className={after===null?'cash-plan-unknown':after<0?'negative':''}>{balanceText(after)}</dd></div>
   <div><dt>가용자금 <small>유보액 제외</small></dt><dd className={available===null?'cash-plan-unknown':available<0?'negative':''}>{balanceText(available)}</dd></div>
   {settlementIncome>0&&<><div className="cash-worksheet-toss-income"><dt>토스 입금 예정</dt><dd>+{digits(settlementIncome)}</dd></div><div className="cash-worksheet-toss-projection"><dt>정산 반영 가용자금</dt><dd className={available===null?'cash-plan-unknown':available+settlementIncome<0?'negative':''}>{balanceText(available===null?null:available+settlementIncome)}</dd></div></>}
  </dl>
  {latest?.accounts.some(({snapshot})=>snapshot.source==='clobe'&&snapshot.ledgerBalance!==undefined&&snapshot.ledgerBalance!==snapshot.balance)&&<details className="cash-worksheet-pending"><summary>잔액·거래 대조 필요</summary><p>Clobe 수집 잔액과 저장된 거래 잔액이 다릅니다. 출금 확인과 거래 업로드 적용 상태를 확인하세요.</p></details>}
 </section>;
});

export function CashPlanWorksheet({plans,estimates,worksheetBusinesses,latestBalances,basis,selectedBusiness,onOpenDetail,onEditBusiness,onConfirmPayment,confirmingKey,saving,settlementIncome}:WorksheetProps){
 return <div className="cash-worksheet-scroll" role="region" aria-label="사업자별 지출 계획표. 좁은 화면에서는 좌우로 이동할 수 있습니다." tabIndex={0}>
  <details className="cash-worksheet-legend"><summary>표 읽는 법</summary><p>실제 출금이 다르면 <del>추정액</del> 아래에 실제액을 표시합니다. 잔액은 남은 예산만 차감합니다.</p><p>동기화한 은행 출금도 계획에 반영합니다. 비고의 ‘확인’으로 지급 여부를 직접 반영할 수 있습니다.</p></details>
  <div className="cash-worksheet-grid" style={{gridTemplateColumns:`repeat(${Math.min(plans.length,4)},minmax(216px,1fr))`}}>
   {plans.map(plan=><BusinessWorksheet key={plan.business.id} plan={plan} estimate={estimates.get(plan.business.id)} worksheet={worksheetBusinesses.get(plan.business.id)} latest={latestBalances.get(plan.business.id)} basis={basis} selectedBusiness={selectedBusiness} onOpenDetail={onOpenDetail} onEditBusiness={onEditBusiness} onConfirmPayment={onConfirmPayment} confirmingKey={confirmingKey} saving={saving} settlementIncome={settlementIncome?.get(plan.business.id)??0}/>)}
  </div>
 </div>;
}
