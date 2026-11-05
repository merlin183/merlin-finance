"use client";

import {useMemo,useRef,useState} from 'react';
import {ChevronLeft,ChevronRight,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog,DialogClose,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {formatFinanceDate,parseFinanceDate,type DateRange} from '@/lib/finance/date-range';
import {today,won} from '@/lib/finance/format';
import {getSourceDetailEntries,sourceCounterparty} from '@/lib/finance/source-details';
import {buildTransactionCalendar,calendarMonthRange,shiftCalendarMonth} from '@/lib/finance/transaction-calendar';
import type {Dataset,Transaction} from '@/lib/finance/types';
import './transaction-calendar.css';
import {TransferFeeBreakdown} from './transaction-transfer-fee-display';
import './transaction-transfer-fee.css';

const weekdays=['일','월','화','수','목','금','토'];
const amountFormat=new Intl.NumberFormat('ko-KR',{maximumFractionDigits:0});
const dateLabel=(date:string)=>`${Number(date.slice(0,4))}년 ${Number(date.slice(5,7))}월 ${Number(date.slice(8,10))}일`;
const transactionTitle=(transaction:Transaction)=>sourceCounterparty(transaction)||transaction.description||'적요 없음';
type BusinessInfo={name:string;color:string;order:number};
type BusinessTransactions={id:string;name:string;color:string;order:number;transactions:Transaction[];income:number;expense:number};
function groupBusinessTransactions(rows:readonly Transaction[],businesses:ReadonlyMap<string,BusinessInfo>):BusinessTransactions[]{
 const grouped=new Map<string,BusinessTransactions>();
 for(const transaction of rows){
  let group=grouped.get(transaction.business_id);
  if(!group){
   const business=businesses.get(transaction.business_id);
   group={id:transaction.business_id,name:business?.name||'사업자 미설정',color:business?.color||'#8592a7',order:business?.order??Number.MAX_SAFE_INTEGER,transactions:[],income:0,expense:0};
   grouped.set(transaction.business_id,group);
  }
  group.transactions.push(transaction);
  if(transaction.direction==='out')group.expense+=transaction.amount;
  else group.income+=transaction.amount;
 }
 return Array.from(grouped.values()).sort((left,right)=>left.order-right.order||left.name.localeCompare(right.name,'ko'));
}

export function TransactionCalendar({data,rows,range,onRangeChange}:{
 data:Dataset;
 rows:Transaction[];
 range:DateRange;
 onRangeChange:(range:DateRange)=>void;
}){
 const month=(parseFinanceDate(range.to)?range.to:today()).slice(0,7);
 const monthRange=calendarMonthRange(month);
 const calendar=useMemo(()=>{
  const result=buildTransactionCalendar(rows,month);
  const firstDate=parseFinanceDate(`${month}-01`)!;
  const leading=firstDate.getDay();
  const paddedDates=result.days.map((day,index)=>day?.date||formatFinanceDate(new Date(firstDate.getFullYear(),firstDate.getMonth(),index-leading+1)));
  return {...result,paddedDates};
 },[rows,month]);
 const [selectedDate,setSelectedDate]=useState('');
 const triggerRef=useRef<HTMLButtonElement|null>(null);
 const selected=calendar.days.find(day=>day?.date===selectedDate&&day.date>=range.from&&day.date<=range.to);
 const businesses=useMemo(()=>new Map(data.businesses.map((business,order)=>[business.id,{name:business.name,color:business.color,order}])),[data.businesses]);
 const dailyBusinesses=useMemo(()=>new Map(calendar.days.flatMap(day=>day?[[day.date,groupBusinessTransactions(day.transactions,businesses)] as const]:[])),[calendar.days,businesses]);
 const monthlyBusinesses=useMemo(()=>groupBusinessTransactions(calendar.transactions,businesses),[calendar.transactions,businesses]);
 const selectedBusinesses=selected?dailyBusinesses.get(selected.date)||[]:[];
 const amountCharacters=[...dailyBusinesses.values()].reduce((maximum,groups)=>groups.reduce((length,group)=>Math.max(length,amountFormat.format(group.expense).length,amountFormat.format(group.income).length),maximum),1);
 const calendarMinWidth=Math.max(700,(amountCharacters*8+24)*7);
 const accounts=useMemo(()=>new Map(data.accounts.map(account=>[account.id,account.name])),[data.accounts]);
 const categories=useMemo(()=>new Map(data.categories.map(category=>[category.id,category.name])),[data.categories]);
 const partialMonth=range.from>monthRange.from||range.to<monthRange.to;
 const currentToday=today();
 const monthLabel=`${Number(month.slice(0,4))}년 ${Number(month.slice(5,7))}월`;

 function changeMonth(next:string){
  if(!parseFinanceDate(`${next}-01`))return;
  setSelectedDate('');
  onRangeChange(calendarMonthRange(next));
 }

 return <section className="transaction-calendar" aria-label="거래 달력">
  <div className="transaction-calendar-heading">
   <div className="transaction-calendar-month-heading">
    <h2>{monthLabel}</h2>
    <div className="transaction-calendar-navigation">
     <Button type="button" variant="ghost" size="icon-xs" aria-label="달력 이전 달" disabled={month==='1900-01'} onClick={()=>changeMonth(shiftCalendarMonth(month,-1))}><ChevronLeft size={14}/></Button>
     <Button type="button" variant="ghost" size="icon-xs" aria-label="달력 다음 달" disabled={month==='9999-12'} onClick={()=>changeMonth(shiftCalendarMonth(month,1))}><ChevronRight size={14}/></Button>
    </div>
   </div>
   <Input type="month" aria-label="달력 표시 월" min="1900-01" max="9999-12" value={month} onChange={event=>changeMonth(event.target.value)}/>
  </div>
  <div className="transaction-calendar-scope">
   <p>조회기간 {range.from} ~ {range.to} 중 {monthLabel} · 현재 필터 기준</p>
   {partialMonth&&<Button type="button" size="xs" variant="ghost" onClick={()=>changeMonth(month)}>한 달 전체 보기</Button>}
  </div>
  <dl className="transaction-calendar-totals" aria-label={`${monthLabel} 합계`}>
   <div><dt>{Number(month.slice(5,7))}월 출금 합계</dt><dd className="transaction-calendar-expense">{won(calendar.expense)}</dd></div>
   <div><dt>{Number(month.slice(5,7))}월 입금 합계</dt><dd className="transaction-calendar-income">{won(calendar.income)}</dd></div>
   <div><dt>거래 건수</dt><dd>{calendar.transactions.length.toLocaleString()}건</dd></div>
  </dl>
  <div className="transaction-calendar-legend">
   <div><span><i className="transaction-calendar-expense-dot"/>출금</span><span><i className="transaction-calendar-income-dot"/>입금</span><span className="transaction-calendar-muted-legend"><i/>조회기간 밖</span></div>
   <span>단위: 원</span>
  </div>
  {monthlyBusinesses.length>0&&<div className="transaction-calendar-business-legend" aria-label="사업자 구분">{monthlyBusinesses.map(business=><span key={business.id}><i aria-hidden="true" style={{background:business.color}}/>{business.name}</span>)}</div>}
  <div className="transaction-calendar-scroll" tabIndex={0} role="region" aria-label="일별 거래 달력. 좁은 화면에서는 좌우로 이동할 수 있습니다.">
  <div className="transaction-calendar-scroll-content" style={{minWidth:calendarMinWidth}}>
  <div className="transaction-calendar-weekdays" aria-hidden="true">{weekdays.map(weekday=><div key={weekday}>{weekday}</div>)}</div>
  <div className="transaction-calendar-grid">
   {calendar.days.map((day,index)=>{
    if(!day){
     const adjacentDate=calendar.paddedDates[index];
     return <div key={`adjacent-${index}`} className={`transaction-calendar-adjacent${index%7===0||index%7===6?' is-weekend':''}`} aria-hidden="true"><time dateTime={adjacentDate}>{Number(adjacentDate.slice(-2))}</time></div>;
    }
    const inRange=day.date>=range.from&&day.date<=range.to;
    const dayBusinesses=dailyBusinesses.get(day.date)||[];
    const visibleBusinesses=dayBusinesses.slice(0,2);
    return <button type="button" key={day.date} className={`transaction-calendar-day${day.date===currentToday?' is-today':''}${!inRange?' is-outside':''}${index%7===0||index%7===6?' is-weekend':''}`}
     disabled={!inRange} aria-haspopup="dialog" aria-expanded={selected?.date===day.date}
     aria-label={`${day.date} · ${inRange?`${day.transactions.length}건 · 출금 ${won(day.expense)} · 입금 ${won(day.income)}${dayBusinesses.map(business=>` · ${business.name} 출금 ${won(business.expense)}, 입금 ${won(business.income)}`).join('')} · 상세보기`:'조회기간 밖'}`}
     onClick={event=>{triggerRef.current=event.currentTarget;setSelectedDate(day.date);}}>
     <span className="transaction-calendar-day-heading"><time dateTime={day.date}>{Number(day.date.slice(8,10))}</time>{day.date===currentToday&&<span>오늘</span>}</span>
     {inRange?<>
      {dayBusinesses.length?<span className="transaction-calendar-day-businesses" aria-hidden="true">{visibleBusinesses.map(business=><span key={business.id} className="transaction-calendar-day-business" title={`${business.name} · 출금 ${won(business.expense)} · 입금 ${won(business.income)}`}>
       <span className="transaction-calendar-business-label"><i style={{background:business.color}}/>{business.name}</span>
       <span className="transaction-calendar-day-totals">
        <span className="transaction-calendar-expense"><span className="transaction-calendar-exact-amount">{amountFormat.format(business.expense)}</span></span>
        <span className="transaction-calendar-income"><span className="transaction-calendar-exact-amount">{amountFormat.format(business.income)}</span></span>
       </span>
      </span>)}</span>:<span className="transaction-calendar-day-totals" aria-hidden="true">
       <span className="transaction-calendar-expense" title={`출금 ${won(day.expense)}`}><span className="transaction-calendar-exact-amount">{amountFormat.format(day.expense)}</span></span>
       <span className="transaction-calendar-income" title={`입금 ${won(day.income)}`}><span className="transaction-calendar-exact-amount">{amountFormat.format(day.income)}</span></span>
      </span>}
      {dayBusinesses.length>visibleBusinesses.length&&<span className="transaction-calendar-business-more">+{dayBusinesses.length-visibleBusinesses.length}개 사업자</span>}
      {day.transactions.length>0&&<span className="transaction-calendar-detail-link">상세보기<span> · {day.transactions.length.toLocaleString()}건</span></span>}
     </>:<span className="transaction-calendar-outside-label">조회기간 밖</span>}
    </button>;
   })}
  </div>
  </div>
  </div>
  <p className="transaction-calendar-help">현재 필터에 포함된 사업자별 출금·입금 합계입니다. 금액은 원 단위 숫자로 표시합니다. 날짜 또는 상세보기를 누르면 거래가 사업자별로 열립니다. 좁은 화면에서는 달력을 좌우로 움직여 확인하세요. 월 이동 시 조회기간은 해당 월 전체로 바뀝니다.</p>
  <Dialog open={!!selected} onOpenChange={open=>{if(!open)setSelectedDate('');}}>
   <DialogContent className="transaction-calendar-dialog" showCloseButton={false} onCloseAutoFocus={event=>{event.preventDefault();triggerRef.current?.focus({preventScroll:true});}}>
    <DialogClose asChild><Button type="button" variant="ghost" size="icon-xs" className="transaction-calendar-dialog-close" aria-label="닫기"><X size={16}/></Button></DialogClose>
    <DialogHeader>
     <DialogTitle>{selected?`${dateLabel(selected.date)} 거래내역`:'날짜별 거래내역'}</DialogTitle>
     <DialogDescription>{selected?`${selected.transactions.length.toLocaleString()}건 · 출금 ${won(selected.expense)} · 입금 ${won(selected.income)}`:'선택한 날짜의 거래내역입니다.'}</DialogDescription>
    </DialogHeader>
    <div className="transaction-calendar-dialog-body">
     {selectedBusinesses.length?selectedBusinesses.map(business=><section key={business.id} className="transaction-calendar-business-group" aria-label={`${business.name} 거래내역`}>
      <header className="transaction-calendar-business-group-heading"><h3><i aria-hidden="true" style={{background:business.color}}/>{business.name}<small>{business.transactions.length.toLocaleString()}건</small></h3><p><span className="transaction-calendar-expense">출금 {won(business.expense)}</span><span className="transaction-calendar-income">입금 {won(business.income)}</span></p></header>
      <ul className="transaction-calendar-transactions">{business.transactions.map(transaction=><CalendarTransaction key={transaction.id} data={data} transaction={transaction} business={business.name} account={accounts.get(transaction.account_id)||'계좌 미설정'} category={categories.get(transaction.category_id||'')||'미매핑'}/>)}</ul>
     </section>):<p className="transaction-calendar-empty">선택한 날짜에 조건에 맞는 거래가 없습니다.</p>}
    </div>
    <p className="transaction-calendar-dialog-help">계정과목 수정은 표 보기에서 할 수 있습니다.</p>
   </DialogContent>
  </Dialog>
 </section>;
}

function CalendarTransaction({data,transaction,business,account,category}:{data:Dataset;transaction:Transaction;business:string;account:string;category:string}){
 const counterparty=sourceCounterparty(transaction);
 const entries=getSourceDetailEntries(transaction).filter(entry=>entry.label!=='거래 상대방');
 const provenance=transaction.source_details?.provenance;
 const isExpense=transaction.direction==='out';
 return <li className="transaction-calendar-transaction">
  <div className="transaction-calendar-transaction-main">
   <div><div className="transaction-calendar-transaction-context"><span>{business}</span><span>{account}</span>{transaction.txn_time&&<time>{transaction.txn_time}</time>}{transaction.is_internal&&<span>내부거래</span>}</div><strong className="transaction-calendar-transaction-title">{transactionTitle(transaction)}</strong>{counterparty&&transaction.description&&counterparty!==transaction.description&&<p className="transaction-calendar-description">적요 · {transaction.description}</p>}<span className="transaction-calendar-category">{category}</span><TransferFeeBreakdown data={data} transaction={transaction}/></div>
   <div className={isExpense?'transaction-calendar-amount transaction-calendar-expense':'transaction-calendar-amount transaction-calendar-income'}><span>{isExpense?'출금':'입금'}</span><strong>{won(transaction.amount)}</strong>{transaction.balance!==null&&<small>거래 후 잔액 {won(transaction.balance)}</small>}</div>
  </div>
  {entries.length>0&&<dl className="transaction-calendar-source">{entries.map(entry=><div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl>}
  {provenance&&<small className="transaction-calendar-origin">원본 · {provenance.sheet} · {provenance.row}행</small>}
 </li>;
}
