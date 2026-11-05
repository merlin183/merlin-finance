import {useId,useMemo,useRef,useState} from 'react';
import {ChevronLeft,ChevronRight} from 'lucide-react';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {buildFundingTimeline,type FundingAccountDay} from '@/lib/finance/funding-timeline';
import type {AccountFundingBusiness} from '@/lib/finance/account-funding';
import type {CashCalendarItem,CashCalendarModel} from '@/lib/finance/cash-calendar';
import type {TossCalendarIncome} from '@/lib/finance/toss-funding';
import {formatFinanceDate,parseFinanceDate,type DateRange} from '@/lib/finance/date-range';
import './funding-timeline.css';

type TimelineProps={businesses:AccountFundingBusiness[];accountId:string;range:DateRange;asOf:string;focusDate?:string;cashCalendar?:CashCalendarModel;calendarIncome?:TossCalendarIncome[]};
const digits=(value:number)=>value.toLocaleString('ko-KR');
const expense=(value:number)=>value===0?'0':`-${digits(value)}`;
const amount=(value:number|null)=>value===null?'확인 필요':digits(value);
const weekdays=['일','월','화','수','목','금','토'];
const dayLabel=(date:string)=>`${Number(date.slice(5,7))}월 ${Number(date.slice(8))}일`;
const accountLabel=(row:FundingAccountDay)=>[row.business.name,row.account.name,row.account.bank,row.account.masked_number].filter(Boolean).join(' · ');
type CalendarAmounts={actualExpenses:number;plannedExpenses:number;confirmedExpenses:number};
const hasExpenses=(row:CalendarAmounts)=>row.actualExpenses>0||row.plannedExpenses>0||row.confirmedExpenses>0;
const expenseLabel=(row:CalendarAmounts)=>[row.actualExpenses>0?`실제 출금 ${expense(row.actualExpenses)}원`:'',row.plannedExpenses>0?`예정 ${expense(row.plannedExpenses)}원`:'',row.confirmedExpenses>0?`수동 확인 ${expense(row.confirmedExpenses)}원`:''].filter(Boolean).join(', ')||'지출 0원';
const calendarBusinessRows=(day:CashCalendarModel['days'][number],receipts:TossCalendarIncome[],businesses:AccountFundingBusiness[])=>{
 const rows=[...day.businesses];
 for(const receipt of receipts){
  if(rows.some(row=>row.businessId===receipt.businessId))continue;
  const business=businesses.find(row=>row.business.id===receipt.businessId)?.business;
  if(business)rows.push({business,businessId:business.id,actualExpenses:0,plannedExpenses:0,confirmedExpenses:0});
 }
 return rows.map(row=>({...row,receipts:receipts.filter(receipt=>receipt.businessId===row.businessId)})).filter(row=>hasExpenses(row)||row.receipts.length>0);
};
const incomeAmount=(item:Pick<TossCalendarIncome,'status'|'amount'>)=>`${item.amount>0&&(item.status==='pending'||item.status==='received')?'+':''}${digits(item.amount)}`;
const incomeLabel=(item:TossCalendarIncome)=>`${item.label}${item.status==='pending'||item.status==='received'?'':' · 정산액'} ${incomeAmount(item)}`;
const incomeColor=(item:Pick<TossCalendarIncome,'amount'>)=>item.amount>0?'positive':item.amount<0?'negative':'';

function CalendarIncomeAmounts({items,className=''}:{items:TossCalendarIncome[];className?:string}){
 if(!items.length)return null;
 // Only unambiguous scheduled/received rows share a subtotal. Unresolved rows
 // keep their original amounts and labels; their differences are never cash.
 const rows:TossCalendarIncome[]=[];
 for(const item of items){
  const previous=(item.status==='pending'||item.status==='received')?rows.find(row=>row.status===item.status&&row.label===item.label):undefined;
  if(previous)previous.amount+=item.amount;
  else rows.push({...item});
 }
 return <span className={`funding-timeline-income-amounts ${className}`}>{rows.map(item=><span key={item.key} className={`funding-timeline-income-line ${incomeColor(item)}`} title={`${incomeLabel(item)}원${item.reason?` · ${item.reason}`:''}`}><span>{item.label}{item.status!=='pending'&&item.status!=='received'&&<small>정산액</small>}</span><strong>{incomeAmount(item)}</strong></span>)}</span>;
}

function CalendarIncomeDetails({items,businesses}:{items:TossCalendarIncome[];businesses:AccountFundingBusiness[]}){
 if(!items.length)return null;
 return <section className="funding-timeline-detail-section funding-timeline-income-details" aria-label="토스 정산 입금 상태"><h4>토스 정산 입금</h4><p className="funding-timeline-detail-note">정산 지급일 기준입니다. 입금 확인 필요·차액 확인 금액을 현재 현금이나 추가 필요자금에 더하지 않습니다.</p><ul className="funding-timeline-detail-items">{items.map(item=>{
  const business=businesses.find(row=>row.business.id===item.businessId)?.business;
  const account=businesses.flatMap(row=>row.accounts).find(row=>row.account.id===item.accountId)?.account;
  return <li key={item.key}><div><span className="funding-timeline-detail-business"><i style={{background:business?.color}} aria-hidden="true"/>{business?.name??'사업자 확인 필요'} · {account?[account.name,account.bank,account.masked_number].filter(Boolean).join(' · '):'입금 계좌 확인 필요'}</span><p>{item.title} · {item.label}</p>{item.reason&&<small>{item.reason}</small>}{item.receivedAmount>0&&item.status!=='received'&&<small>통장 확인 입금 {digits(item.receivedAmount)}원 · 정산액과의 차액 {digits(item.differenceAmount)}원{item.differenceAmount<0?' (초과 입금)':''}</small>}</div><strong className={incomeColor(item)}>{item.status!=='pending'&&item.status!=='received'&&<span className="funding-timeline-income-original-label">정산액</span>}{incomeAmount(item)}원</strong></li>;
 })}</ul></section>;
}

function CalendarExpenseAmounts({row,className=''}:{row:CalendarAmounts;className?:string}){
 return <span className={`funding-timeline-amounts ${className}`}>
  {row.actualExpenses>0&&<span className="funding-timeline-expense-line negative"><span>실제</span><strong>{expense(row.actualExpenses)}</strong></span>}
  {row.plannedExpenses>0&&<span className="funding-timeline-expense-line negative"><span className="funding-timeline-planned-badge">예정</span><strong>{expense(row.plannedExpenses)}</strong></span>}
  {row.confirmedExpenses>0&&<span className="funding-timeline-expense-line negative"><span>수동 확인</span><strong>{expense(row.confirmedExpenses)}</strong></span>}
  {!hasExpenses(row)&&<span className="funding-timeline-zero">0</span>}
 </span>;
}

function CalendarExpenseItems({items,businesses,kind}:{items:CashCalendarItem[];businesses:AccountFundingBusiness[];kind:CashCalendarItem['kind']}){
 const rows=items.filter(item=>item.kind===kind);
 if(!rows.length)return null;
 const label=kind==='actual'?'실제 출금':kind==='planned'?'남은 예정 지출':'수동 출금 확인';
 return <section className={`funding-timeline-detail-section ${kind}`} aria-label={label}>
  <h4>{label}<strong className="negative">{expense(rows.reduce((sum,item)=>sum+item.amount,0))}원</strong></h4>
  {kind==='confirmed'&&<p className="funding-timeline-detail-note">사용자가 확인한 금액입니다. 원본 통장 출금과 구분하며 실제 출금 합계에는 더하지 않습니다.</p>}
  <ul className="funding-timeline-detail-items">{rows.map(item=>{
   const business=businesses.find(row=>row.business.id===item.businessId);
   const account=business?.accounts.find(row=>row.account.id===item.accountId)?.account;
   return <li key={item.key} className={item.paymentKind==='tax'?'funding-timeline-tax-item':''}><div><span className="funding-timeline-detail-business"><i style={{background:business?.business.color}} aria-hidden="true"/>{business?.business.name??'사업자 확인 필요'} · {account?[account.name,account.bank,account.masked_number].filter(Boolean).join(' · '):'출금 계좌 미지정'}</span><p>{item.paymentKind==='tax'&&<span className="tax-payment-badge">세금 납부</span>} {item.title}</p>{item.note&&<small>{item.note}</small>}</div><strong className="negative">{kind==='planned'&&<span className="funding-timeline-planned-badge">예정</span>}{expense(item.amount)}원</strong></li>;
  })}</ul>
 </section>;
}

function FundingDateInput({value,range,onChange}:{value:string;range:DateRange;onChange:(value:string)=>void}){
 const id=useId();
 const input=useRef<HTMLInputElement>(null);
 const [error,setError]=useState('');
 const commit=()=>{
  // A partially edited native date can have value="" without firing change.
  // Read the current field at commit time instead of relying on React state.
  const draft=input.current?.value??'';
  const nextError=!parseFinanceDate(draft)?'날짜를 모두 입력해주세요.':draft<range.from||draft>range.to?`${range.from} ~ ${range.to} 안의 날짜를 선택해주세요.`:'';
  setError(nextError);
  if(!nextError)onChange(draft);
 };
 return <form className="funding-timeline-date-field" noValidate onSubmit={event=>{event.preventDefault();commit();}}>
  <label htmlFor={id}>날짜 선택</label><div><input ref={input} id={id} aria-label="실제·예정 지출 조회 날짜" type="date" min={range.from} max={range.to} defaultValue={value} onInput={()=>setError('')} onBlur={commit} aria-invalid={!!error} aria-describedby={`${id}-status`}/><button type="submit">조회</button></div>
  <p id={`${id}-status`} role="status" aria-live="polite" className={error?'error':''}>{error?`${error} 이전 선택일을 유지합니다.`:''}</p>
 </form>;
}

function FundingDayItems({rows}:{rows:FundingAccountDay[]}){
 const withItems=rows.filter(row=>row.items.length>0);
 if(!withItems.length)return <p className="funding-timeline-empty">이 날짜에 계좌가 확인된 예정 지출은 없습니다.</p>;
 return <div className="funding-timeline-item-groups">{withItems.map(row=><details key={row.account.id} className="funding-timeline-item-group" open={withItems.length===1}>
  <summary><span><i style={{background:row.business.color}} aria-hidden="true"/>{accountLabel(row)}</span><strong className="negative">예정 {expense(row.expenses)}원 · {row.items.length}건</strong></summary>
  <ul>{row.items.map(item=><li key={item.key} className={item.paymentKind==='tax'?'funding-timeline-tax-item':''}><span>{item.paymentKind==='tax'&&<span className="tax-payment-badge">세금 납부</span>} {item.title}<small>{item.date} · {item.note}</small></span><strong className="negative">예정 {expense(item.amount)}원</strong></li>)}</ul>
 </details>)}</div>;
}

export function FundingTimeline({businesses,accountId,range,asOf,focusDate='',cashCalendar,calendarIncome}:TimelineProps){
 const scopedBusinesses=useMemo(()=>accountId==='all'?businesses:businesses.filter(item=>item.accounts.some(account=>account.account.id===accountId)).map(item=>({...item,accounts:item.accounts.filter(account=>account.account.id===accountId)})),[businesses,accountId]);
 const timeline=useMemo(()=>buildFundingTimeline(scopedBusinesses,range,asOf),[scopedBusinesses,range,asOf]);
 const calendarReceipts=useMemo(()=>(calendarIncome??scopedBusinesses.flatMap(row=>row.accounts.flatMap(account=>(account.scheduledIncome??[]).map((receipt):TossCalendarIncome=>({key:receipt.key,businessId:receipt.businessId,accountId:receipt.accountId,date:receipt.date,title:receipt.title,amount:receipt.amount,status:'pending',label:'입금 예정',receivedAmount:0,pendingAmount:receipt.amount,differenceAmount:receipt.amount,reason:null,merchantIds:[],matchedTransactionIds:[],noCash:true}))))).filter(item=>item.date>=range.from&&item.date<=range.to&&scopedBusinesses.some(row=>row.business.id===item.businessId)&&(accountId==='all'||item.accountId===accountId)),[calendarIncome,scopedBusinesses,range.from,range.to,accountId]);
 const receiptsByDate=useMemo(()=>{const result=new Map<string,TossCalendarIncome[]>();for(const item of calendarReceipts)result.set(item.date,[...(result.get(item.date)??[]),item]);return result;},[calendarReceipts]);
 const calendarDays=useMemo(()=>{
  if(cashCalendar)return cashCalendar.days;
  const byDate=new Map(timeline.days.map(day=>[day.date,{
  date:day.date,actualExpenses:0,plannedExpenses:day.expenses,confirmedExpenses:0,
  businesses:day.businesses.map(row=>({business:row.business,businessId:row.business.id,actualExpenses:0,plannedExpenses:row.expenses,confirmedExpenses:0})),
  items:scopedBusinesses.flatMap(row=>[...row.accounts.flatMap(account=>account.items.filter(item=>item.date===day.date).map(item=>({...item,kind:'planned' as const,source:'plan' as const,businessId:row.business.id,accountId:account.account.id,planLink:item.key}))),...row.unassignedItems.filter(item=>item.date===day.date).map(item=>({...item,kind:'planned' as const,source:'plan' as const,businessId:row.business.id,accountId:null,planLink:item.key}))]),
  }]));
  // A display date must survive the current-balance cutoff, even when only a
  // past settlement remains on it. Funding projections keep their own dates.
  const days:CashCalendarModel['days']=[],cursor=parseFinanceDate(range.from);
  if(!cursor)return days;
  for(let value=range.from;value<=range.to;cursor.setDate(cursor.getDate()+1),value=formatFinanceDate(cursor)){
   days.push(byDate.get(value)??{date:value,actualExpenses:0,plannedExpenses:0,confirmedExpenses:0,businesses:[],items:[]});
   if(value===range.to)break;
  }
  return days;
 },[cashCalendar,timeline,scopedBusinesses,range.from,range.to]);
 const hasSettlementIncome=scopedBusinesses.some(item=>item.accounts.some(account=>(account.scheduledIncome?.length??0)>0));
 const [chosenDate,setChosenDate]=useState(focusDate);
 const [detailDate,setDetailDate]=useState(focusDate);
 const taxItems=useMemo(()=>scopedBusinesses.flatMap(row=>[...row.accounts.flatMap(account=>account.items.map(item=>({business:row.business,account:account.account,...item}))),...(accountId==='all'?row.unassignedItems:[]).map(item=>({business:row.business,account:undefined,...item}))]).filter(item=>item.paymentKind==='tax'),[scopedBusinesses,accountId]);
 const taxItemsByDate=useMemo(()=>{const result=new Map<string,typeof taxItems>();for(const item of taxItems)if(item.date!==null)result.set(item.date,[...(result.get(item.date)??[]),item]);return result;},[taxItems]);
 const detailTaxes=taxItemsByDate.get(detailDate)??[];
 const firstUsefulDate=calendarDays.find(day=>hasExpenses(day)||(receiptsByDate.get(day.date)?.length??0)>0)?.date??calendarDays[0]?.date??range.from;
 const date=calendarDays.some(day=>day.date===chosenDate)?chosenDate:firstUsefulDate;
 const selectedCalendar=calendarDays.find(day=>day.date===date);
 const detailDay=calendarDays.find(day=>day.date===detailDate);
 const selected=timeline.days.find(day=>day.date===date);
 const parsed=parseFinanceDate(date);
 if(!selectedCalendar||!parsed)return <section className="funding-timeline" aria-label="날짜별 실제·예정 지출"><p className="funding-timeline-empty">선택한 기간에 표시할 날짜가 없습니다. 조회 기간을 확인해주세요.</p>{timeline.undatedExpenses>0&&<p className="funding-timeline-notice">날짜 미정 예정 {expense(timeline.undatedExpenses)}원은 날짜별로 배분하지 않았습니다.</p>}</section>;
 const activeRange={from:calendarDays[0].date,to:range.to};
 const year=parsed.getFullYear(),month=parsed.getMonth();
 const first=new Date(year,month,1),last=new Date(year,month+1,0);
 const daysByDate=new Map(calendarDays.map(day=>[day.date,day]));
 const grid=Array.from({length:Math.ceil((first.getDay()+last.getDate())/7)*7},(_,index)=>{
  const value=new Date(year,month,index-first.getDay()+1);
  return {date:formatFinanceDate(value),day:value.getDate(),inMonth:value.getMonth()===month};
 });
 const monthStart=formatFinanceDate(first),monthEnd=formatFinanceDate(last);
 const monthDays=calendarDays.filter(day=>day.date>=monthStart&&day.date<=monthEnd);
 const hasEarlier=activeRange.from<monthStart,hasLater=activeRange.to>monthEnd;
 const moveMonth=(offset:number)=>{
  const start=formatFinanceDate(new Date(year,month+offset,1));
  setChosenDate(start<activeRange.from?activeRange.from:start>activeRange.to?activeRange.to:start);
 };
 const selectedUnassigned=accountId==='all'?scopedBusinesses.flatMap(business=>business.unassignedItems.filter(item=>item.date===date).map(item=>({business:business.business,...item}))):[];
 const knownCount=selected?.accounts.filter(row=>row.cumulativeTopUp!==null).length??0;
 const initialShortage=selected?.accounts.reduce((sum,row)=>sum+(row.snapshot.balance!==null&&row.snapshot.balance<0?-row.snapshot.balance:0),0)??0;
 const datesWithExpenses=monthDays.filter(day=>hasExpenses(day)||(receiptsByDate.get(day.date)?.length??0)>0);
 const selectedIncome=receiptsByDate.get(date)??[];
 const detailIncome=receiptsByDate.get(detailDate)??[];
 const undatedPlanned=cashCalendar?.undatedPlannedExpenses??timeline.undatedExpenses;
 const undatedConfirmed=cashCalendar?.undatedItems.filter(item=>item.kind==='confirmed').reduce((sum,item)=>sum+item.amount,0)??0;
 const showDay=(value:string)=>{setChosenDate(value);setDetailDate(value);};
 return <section className="funding-timeline" aria-label="날짜별 실제·예정 지출">
  <Dialog open={!!detailDate&&!!detailDay} onOpenChange={open=>{if(!open)setDetailDate('');}}>
   <DialogContent className="funding-timeline-tax-dialog funding-timeline-detail-dialog">
    <DialogHeader><DialogTitle>{dayLabel(detailDate)} 지출·입금 상세</DialogTitle><DialogDescription>실제 출금은 통장 거래일, 예정 지출과 정산 입금은 지급일 기준입니다. 단위: 원.</DialogDescription></DialogHeader>
    {detailDay&&<><CalendarExpenseAmounts row={detailDay} className="funding-timeline-detail-totals"/><CalendarExpenseItems items={detailDay.items} businesses={businesses} kind="actual"/><CalendarExpenseItems items={detailDay.items} businesses={businesses} kind="planned"/><CalendarExpenseItems items={detailDay.items} businesses={businesses} kind="confirmed"/>{!hasExpenses(detailDay)&&<p className="funding-timeline-empty">이 날짜에 표시할 지출이 없습니다.</p>}</>}
    <CalendarIncomeDetails items={detailIncome} businesses={businesses}/>
    {detailTaxes.length>0&&<section className="funding-timeline-detail-section" aria-label="세금 납부 기한"><h4>세금 납부 기한</h4>
    <p className="funding-timeline-tax-dialog-total">납부할 세금 합계 <strong>{digits(detailTaxes.reduce((sum,item)=>sum+item.amount,0))}원</strong></p>
    <ul className="funding-timeline-tax-dialog-list">{detailTaxes.map(item=><li key={`${item.business.id}:${item.key}`}><div><strong>{item.business.name}</strong><p>{item.title}</p><small>{item.account?[item.account.name,item.account.bank,item.account.masked_number].filter(Boolean).join(' · '):'출금 계좌 미지정'}</small></div><b>{digits(item.amount)}원</b></li>)}</ul>
    <p className="funding-timeline-tax-dialog-note">실제 납부 후 화면 상단 ‘납부 일정 확인’에서 납부 완료로 표시해 주세요. 통장 거래·잔액은 변경하지 않습니다.</p>
    </section>}
   </DialogContent>
  </Dialog>
  <header className="funding-timeline-heading"><div><h3>지출 달력</h3><p>실제 출금 · 남은 예정액 · 날짜를 누르면 상세보기 · 단위 원</p></div><FundingDateInput key={`${date}:${activeRange.from}:${activeRange.to}`} value={date} range={activeRange} onChange={setChosenDate}/></header>
  <div className="funding-timeline-calendar-layout">
   <div className="funding-timeline-calendar-wrap">
    <div className="funding-timeline-month"><h4>{year}년 {month+1}월</h4><div><button type="button" aria-label="지출 계획 이전 달" disabled={!hasEarlier} onClick={()=>moveMonth(-1)}><ChevronLeft size={16}/></button><button type="button" aria-label="지출 계획 다음 달" disabled={!hasLater} onClick={()=>moveMonth(1)}><ChevronRight size={16}/></button></div><span>{calendarReceipts.length>0?'실제 · 예정 지출 · 토스 정산 입금':'실제 · 예정 지출'} · 단위: 원</span></div>
    <div className="funding-timeline-calendar-scroll" role="region" tabIndex={0} aria-label="사업자별 실제·예정 지출 달력, 좁은 화면에서 좌우로 이동"><div className="funding-timeline-calendar" role="group" aria-label={`${year}년 ${month+1}월 실제·예정 지출 달력`}>
     {weekdays.map((day,index)=><span className={`funding-timeline-weekday ${index===0?'sunday':''}`} key={day}>{day}</span>)}
     {grid.map(cell=>{
      const day=cell.inMonth?daysByDate.get(cell.date):undefined;
      const receipts=receiptsByDate.get(cell.date)??[];
      const activeBusinesses=day?calendarBusinessRows(day,receipts,scopedBusinesses):[];
      const taxes=day?taxItemsByDate.get(cell.date)??[]:[];
      return <button key={cell.date} type="button" disabled={!day} className={`funding-timeline-day ${cell.date===date?'selected':''} ${day&&hasExpenses(day)?'has-expenses':''}`} data-tax-due={taxes.length>0||undefined} aria-pressed={!!day&&cell.date===date} aria-label={`${cell.date}${day?` ${expenseLabel(day)}${receipts.map(item=>`, 토스 ${incomeLabel(item)}원`).join('')}${activeBusinesses.map(row=>`, ${row.business.name} ${expenseLabel(row)}${row.receipts.map(item=>`, ${incomeLabel(item)}원`).join('')}`).join('')}, 상세보기`:' 조회 기간 밖'}`} onClick={()=>showDay(cell.date)}>
       <span className="funding-timeline-day-number">{cell.day}</span>{taxes.length>0&&<span className="tax-payment-badge">세금 납부 {taxes.length}건</span>}
       {day&&<><CalendarExpenseAmounts row={day} className="funding-timeline-day-total"/><CalendarIncomeAmounts items={receipts} className="toss-calendar-income"/><span className="funding-timeline-day-businesses">{activeBusinesses.map(row=><span key={row.businessId} className="funding-timeline-day-business"><span className="funding-timeline-business-name"><i style={{background:row.business.color}} aria-hidden="true"/>{row.business.name}</span><CalendarExpenseAmounts row={row} className="funding-timeline-business-amount"/><CalendarIncomeAmounts items={row.receipts} className="toss-calendar-business"/></span>)}</span></>}
      </button>;
     })}
    </div></div>
    <div className="funding-timeline-shortcuts"><span>바로 보기</span>{[10,15].map(day=>{const value=formatFinanceDate(new Date(year,month,day));return <button type="button" key={day} disabled={!daysByDate.has(value)} aria-pressed={date===value} onClick={()=>setChosenDate(value)}>{month+1}월 {day}일</button>;})}</div>
   </div>
   <details className="funding-timeline-dates"><summary>{month+1}월 지출·입금일 목록 <span>{datesWithExpenses.length}일</span></summary><div className="funding-timeline-dates-scroll" role="region" tabIndex={0} aria-label="날짜별 실제·예정 지출 및 토스 정산 입금 목록"><table><caption className="sr-only">선택한 달의 날짜별 실제 출금, 남은 예정 지출, 토스 정산 입금 상태와 사업자별 소계. 금액 단위 원.</caption><thead><tr><th scope="col">날짜</th><th scope="col">지출·토스 정산 입금</th><th scope="col">사업자별 지출·입금</th></tr></thead><tbody>{datesWithExpenses.map(day=>{const receipts=receiptsByDate.get(day.date)??[];return <tr key={day.date} className={day.date===date?'selected':''}><th scope="row"><button type="button" aria-pressed={day.date===date} aria-label={`${dayLabel(day.date)} 지출·입금 상세보기`} onClick={()=>showDay(day.date)}>{dayLabel(day.date)}</button></th><td className="funding-timeline-date-total"><CalendarExpenseAmounts row={day}/><CalendarIncomeAmounts items={receipts}/></td><td><div className="funding-timeline-date-businesses">{calendarBusinessRows(day,receipts,scopedBusinesses).map(row=><span key={row.businessId}><span className="funding-timeline-business-name"><i style={{background:row.business.color}} aria-hidden="true"/>{row.business.name}</span><CalendarExpenseAmounts row={row}/><CalendarIncomeAmounts items={row.receipts}/></span>)}</div></td></tr>;})}</tbody></table>{!datesWithExpenses.length&&<p className="funding-timeline-empty">이 달에 날짜가 정해진 지출·입금이 없습니다.</p>}</div></details>
  </div>
  {undatedPlanned>0&&<p className="funding-timeline-notice"><strong>날짜 미정 · <span className="negative">예정 {expense(undatedPlanned)}원</span></strong> · 날짜 칸 제외, ‘기간 전체’ 남은 지출에 포함</p>}
  {undatedConfirmed>0&&<p className="funding-timeline-notice"><strong>날짜 미정 · 수동 확인 {expense(undatedConfirmed)}원</strong> · 통장 실제 출금 합계와 구분</p>}
  {accountId==='all'&&timeline.unassignedExpenses>0&&<p className="funding-timeline-notice"><strong>계좌 미지정 · <span className="negative">예정 {expense(timeline.unassignedExpenses)}원</span></strong> · 예정 합계에 포함, 추가 입금 합계 미확정</p>}
  {timeline.missingAccountBusinessCount>0&&<p className="funding-timeline-notice">계좌 미등록 사업자 {timeline.missingAccountBusinessCount}개 · 전체 필요금액 미확정</p>}
  {selectedIncome.length>0&&<div className="funding-timeline-selected-income"><h4>{dayLabel(date)} 토스 정산 입금 상태</h4><CalendarIncomeAmounts items={selectedIncome}/><button type="button" onClick={()=>setDetailDate(date)}>사업자·계좌·확인 근거 보기</button></div>}
  <div className="funding-timeline-evidence"><header><h4>{dayLabel(date)} 실제·예정 지출 상세</h4><button type="button" onClick={()=>setDetailDate(date)}>상세보기</button></header><p className="funding-timeline-detail-note">실제 출금은 현재 잔액에 이미 반영된 금액입니다. 추가 필요자금에는 남은 예정 지출만 사용합니다.</p>{selected&&<details className="funding-timeline-funding-evidence"><summary>남은 예정 지출 근거 · 필요자금 계산용</summary><FundingDayItems rows={selected.accounts}/>{selectedUnassigned.length>0&&<details className="funding-timeline-item-group unassigned"><summary>출금 계좌 미지정 · {selectedUnassigned.length}건</summary><ul>{selectedUnassigned.map(item=><li key={`${item.business.id}:${item.key}`}><span>{item.business.name} · {item.paymentKind==='tax'&&<span className="tax-payment-badge">세금 납부</span>} {item.title}<small>{item.date} · {item.note}</small></span><strong className="negative">예정 {expense(item.amount)}원</strong></li>)}</ul></details>}</details>}</div>
  <section className="funding-timeline-funding" aria-label="잔액 기준 추가 입금 부족액">
   <header><h4>추가로 준비할 자금</h4></header>
   {selected?<><div className="funding-timeline-kpis" aria-live="polite">
    <div className="funding-timeline-kpi"><span>{dayLabel(date)} 추가 입금 부족액</span><strong className={selected.additionalTopUp===null?'account-funding-unknown':selected.additionalTopUp>0?'negative':''}>{amount(selected.additionalTopUp)}{selected.additionalTopUp===null?'':'원'}</strong>{selected.additionalTopUp===null&&<small>확인된 {knownCount}개 계좌 소계 {digits(selected.knownAdditionalTopUp)}원</small>}<p>앞선 날짜의 필요액을 이미 넣었다면 그날 추가로 필요한 금액</p></div>
    <div className="funding-timeline-kpi"><span>{dayLabel(date)}까지 누적 필요액</span><strong className={selected.cumulativeTopUp===null?'account-funding-unknown':selected.cumulativeTopUp>0?'negative':''}>{amount(selected.cumulativeTopUp)}{selected.cumulativeTopUp===null?'':'원'}</strong>{selected.cumulativeTopUp===null&&<small>확인된 {knownCount}개 계좌 소계 {digits(selected.knownCumulativeTopUp)}원</small>}<p>아직 추가 입금하지 않았다면 준비할 총액</p></div>
   </div>
   <details className="funding-timeline-calculation-note"><summary>추가 입금과 누적 필요액의 차이</summary><p>추가 입금 부족액은 앞선 부족액을 채운 뒤 새로 필요한 금액입니다. 누적 필요액은 아직 입금하지 않았을 때 준비할 총액으로 날짜별 합산하지 않습니다. {hasSettlementIncome?'토스 입금 예정액은 지급일부터 반영하며 입금 전 부족액은 유지합니다. 그 밖의 예상 수입과 다른 통장 여유금은 제외합니다.':'예상 수입과 다른 통장의 여유금은 제외합니다.'}</p>{initialShortage>0&&<p>현재 음수 잔액 보충은 {dayLabel(timeline.days[0]?.date??asOf)}부터 포함하며 새 지출과 구분합니다.</p>}</details>
   </>:<p className="funding-timeline-detail-note">현재 잔액 기준일({asOf}) 이전 날짜입니다. 이 날짜의 출금을 현재 잔액에서 다시 차감하거나 과거 필요자금으로 계산하지 않습니다.</p>}
  </section>
 </section>;
}
