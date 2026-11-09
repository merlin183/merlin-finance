"use client";
import {FinancialText,FinancialValue,useFinancialVisibility} from './financial-visibility';


import {useMemo,useRef,useState} from 'react';
import {BellRing,CalendarDays,CheckCircle2,RefreshCw,TriangleAlert,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogClose,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {taxPaymentNotices,taxPaymentStatusLabel,type TaxPaymentNotice} from '@/lib/finance/tax-payment-display';
import {won} from '@/lib/finance/format';
import type {Dataset} from '@/lib/finance/types';
import type {CashPlanEditState} from './use-cash-plan-edits';
import './tax-payment-alert.css';

type Props={data:Dataset;biz:string;asOf:string;state:CashPlanEditState;onViewDate:(date:string)=>void};
const dueLabel=(date:string|null)=>date?`${date.slice(0,4)}년 ${Number(date.slice(5,7))}월 ${Number(date.slice(8))}일`:'납부일 미지정';

export function TaxPaymentAlert({data,biz,asOf,state,onViewDate}:Props){
 const {privateValue}=useFinancialVisibility();
 const notices=useMemo(()=>taxPaymentNotices(state.edits??[],data.businesses,data.accounts,biz,asOf),[state.edits,data.businesses,data.accounts,biz,asOf]);
 const pending=notices.filter(notice=>notice.status!=='paid'),history=notices.filter(notice=>notice.status==='paid');
 const total=pending.reduce((sum,notice)=>sum+notice.edit.amount,0),nearest=pending[0];
 const [open,setOpen]=useState(false),[tab,setTab]=useState<'pending'|'paid'>('pending');
 const [confirmation,setConfirmation]=useState<{id:string;version:number;status:'pending'|'paid'}|null>(null);
 const [error,setError]=useState(''),[message,setMessage]=useState('');
 const triggerRef=useRef<HTMLButtonElement|null>(null);
 const show=(next:'pending'|'paid')=>{setTab(next);setError('');setMessage('');setConfirmation(null);setOpen(true);};
 async function confirmPayment(notice:TaxPaymentNotice){
  if(!confirmation||state.saving)return;
  if(confirmation.id!==notice.edit.id||confirmation.version!==notice.edit.version){setError('다른 관리자가 이 일정을 변경했습니다. 최신 내역을 확인한 뒤 다시 처리해 주세요.');setConfirmation(null);return;}
  setError('');setMessage('');
  try{await state.save([{action:'payment_status',id:notice.edit.id,version:notice.edit.version,payment_status:confirmation.status}]);setMessage(confirmation.status==='paid'?`${notice.business.name} 납부 완료 표시를 저장했습니다.`:`${notice.business.name} 세금 일정을 미납으로 다시 표시했습니다.`);setConfirmation(null);}
  catch(cause){setError(cause instanceof Error?cause.message:'납부 상태를 저장하지 못했습니다. 다시 시도해 주세요.');}
 }
 const viewDate=(date:string)=>{setOpen(false);onViewDate(date);};
 if(state.error)return <section className="tax-payment-load-error" role="alert"><TriangleAlert size={18}/><div><strong>세금 납부 일정을 확인하지 못했습니다</strong><p><FinancialText value={String((state.error)||'')}/></p></div><Button variant="outline" size="sm" disabled={state.loading} onClick={()=>void state.refresh()}><RefreshCw size={14}/>일정 다시 확인</Button></section>;
 if(state.edits===null)return <p className="tax-payment-loading" role="status"><BellRing size={14}/>세금 납부 일정 확인 중…</p>;
 if(!notices.length)return null;
 return <>
  {nearest?<section className={`tax-payment-alert ${pending.some(notice=>notice.status==='overdue')?'overdue':''}`} aria-label="세금 납부 기한 알림">
   <div className="tax-payment-alert-heading"><span className="tax-payment-icon"><BellRing size={22} aria-hidden="true"/></span><div><p>놓치면 안 되는 세금 납부</p><h2><time dateTime={nearest.edit.plan_date??undefined}>{dueLabel(nearest.edit.plan_date)}</time><span className="tax-payment-badge">{taxPaymentStatusLabel(nearest)}</span></h2></div><div className="tax-payment-alert-total"><span>납부할 세금 {pending.length}건</span><strong><FinancialValue value={won(total)}/></strong></div><Button ref={triggerRef} type="button" className="tax-payment-detail-button" aria-haspopup="dialog" onClick={()=>show('pending')}>납부 일정 확인</Button></div>
   <div className="tax-payment-alert-items">{pending.slice(0,4).map(notice=><div key={notice.edit.id}><strong>{notice.business.name}</strong><span><FinancialText value={String((notice.edit.title)||'')}/></span><b><FinancialValue value={won(notice.edit.amount)}/></b><small><FinancialText value={String(notice.edit.plan_date===nearest.edit.plan_date?'':`${dueLabel(notice.edit.plan_date)} · `)}/><FinancialText value={String((notice.account?[notice.account.name,notice.account.bank,notice.account.masked_number].filter(Boolean).join(' · '):'출금 계좌 미지정')||'')}/><FinancialText value={String(notice.edit.excluded?' · 계획에서 제외됨, 납부 완료 미확인':'')}/></small></div>)}</div>
   <footer><span>납부 완료로 표시할 때까지 알림을 유지합니다.{pending.length>4?` 외 ${pending.length-4}건은 일정 확인에서 볼 수 있습니다.`:''}</span>{nearest.edit.plan_date&&<button type="button" onClick={()=>viewDate(nearest.edit.plan_date!)}><CalendarDays size={14}/>납부일 달력 보기</button>}</footer>
  </section>:<div className="tax-payment-complete"><CheckCircle2 size={16}/><span>등록된 세금 {history.length}건 납부 완료</span><Button ref={triggerRef} variant="ghost" size="sm" aria-haspopup="dialog" onClick={()=>show('paid')}>납부 기록 확인</Button></div>}
  <Dialog open={open} onOpenChange={next=>{if(!state.saving){setOpen(next);setConfirmation(null);}}}>
   <DialogContent className="tax-payment-dialog" showCloseButton={false} onEscapeKeyDown={event=>{if(state.saving)event.preventDefault();}} onInteractOutside={event=>{if(state.saving)event.preventDefault();}} onCloseAutoFocus={event=>{event.preventDefault();triggerRef.current?.focus({preventScroll:true});}}>
    <DialogClose asChild><Button type="button" variant="ghost" size="icon" className="tax-payment-close" aria-label="세금 납부 일정 닫기" disabled={state.saving}><X size={18}/></Button></DialogClose>
    <DialogHeader><DialogTitle>세금 납부 일정</DialogTitle><DialogDescription>선택한 사업자의 전체 납부 일정입니다. 조회 기간과 무관하게 납부가 확인되지 않은 세금을 확인합니다.</DialogDescription></DialogHeader>
    <div className="tax-payment-dialog-summary"><span>납부할 세금</span><strong><FinancialValue value={won(total)}/></strong><small>{pending.length}건 · 납부 상태는 관리자들이 공동 관리</small></div>
    <div className="tax-payment-tabs" role="group" aria-label="세금 납부 상태"><button type="button" aria-pressed={tab==='pending'} disabled={state.saving} onClick={()=>{setTab('pending');setConfirmation(null);}}>미납 {pending.length}</button><button type="button" aria-pressed={tab==='paid'} disabled={state.saving} onClick={()=>{setTab('paid');setConfirmation(null);}}>납부 완료 {history.length}</button></div>
    <div className="tax-payment-dialog-body">{(tab==='pending'?pending:history).map(notice=><article key={notice.edit.id} className={`tax-payment-entry ${notice.status==='paid'?'paid':''}`}>
     <header><div><strong>{notice.business.name}</strong><p><FinancialText value={String((notice.edit.title)||'')}/></p></div><b><FinancialValue value={won(notice.edit.amount)}/></b></header>
     <div className="tax-payment-entry-date"><time dateTime={notice.edit.plan_date??undefined}><FinancialText value={String((dueLabel(notice.edit.plan_date))||'')}/>까지</time><span className="tax-payment-badge"><FinancialText value={String((taxPaymentStatusLabel(notice))||'')}/></span></div>
     <p className="tax-payment-account">출금 계좌 · <FinancialText value={String((notice.account?[notice.account.name,notice.account.bank,notice.account.masked_number].filter(Boolean).join(' · '):'미지정 — 납부월 계획 편집에서 선택')||'')}/></p>
     {notice.edit.memo&&<p className="tax-payment-memo"><FinancialText value={String((notice.edit.memo)||'')}/></p>}
     {notice.edit.excluded&&notice.status!=='paid'&&<p className="tax-payment-entry-warning">지출 계획에서 제외되어도 실제 납부 완료로 확인되지 않아 알림을 유지합니다.</p>}
     <div className="tax-payment-entry-actions">{notice.edit.plan_date&&<Button type="button" variant="outline" size="sm" disabled={state.saving} onClick={()=>viewDate(notice.edit.plan_date!)}><CalendarDays size={14}/>납부일 달력</Button>}<Button type="button" variant={notice.status==='paid'?'outline':'default'} size="sm" disabled={state.saving} onClick={()=>{setConfirmation({id:notice.edit.id,version:notice.edit.version,status:notice.status==='paid'?'pending':'paid'});setError('');setMessage('');}}><FinancialText value={String(notice.status==='paid'?'미납으로 되돌리기':'납부 완료 표시')}/></Button></div>
     {confirmation?.id===notice.edit.id&&<div className="tax-payment-confirm" role="alert"><p>{confirmation.status==='paid'?`${notice.business.name} ${privateValue(won(notice.edit.amount))}을 실제 납부했나요? 완료로 표시하면 미납 알림과 남은 지출에서 제외합니다.`:'이 항목을 미납으로 되돌리면 납부 알림과 남은 지출에 다시 반영합니다.'} 통장 거래·잔액은 변경하지 않습니다.</p><div><Button type="button" variant="outline" size="sm" disabled={state.saving} onClick={()=>setConfirmation(null)}>취소</Button><Button type="button" size="sm" disabled={state.saving} onClick={()=>void confirmPayment(notice)}>{state.saving?'저장 중…':confirmation.status==='paid'?'납부 완료로 표시':'미납으로 표시'}</Button></div></div>}
    </article>)}{!(tab==='pending'?pending:history).length&&<p className="tax-payment-empty">{tab==='pending'?'미납으로 등록된 세금이 없습니다.':'납부 완료 표시한 세금이 없습니다.'}</p>}</div>
    {error&&<p className="tax-payment-error" role="alert"><FinancialText value={String((error)||'')}/></p>}{message&&<p className="tax-payment-success" role="status"><FinancialText value={String((message)||'')}/></p>}
    <p className="tax-payment-dialog-note">납부 완료는 상태 기록이며 실제 세금 납부를 실행하지 않습니다. 납부일 달력을 열면 계획 기간을 해당 월로 변경합니다.</p>
   </DialogContent>
  </Dialog>
 </>;
}
