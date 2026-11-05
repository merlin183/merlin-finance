"use client";

import type {RefObject} from 'react';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import type {PaymentConfirmationDraft,PaymentConfirmationMode} from './payment-confirmation-draft';

export function PaymentConfirmationModePicker({mode,pending,onChange}:{mode:PaymentConfirmationMode;pending:boolean;onChange:(mode:PaymentConfirmationMode)=>void}){
 return <fieldset className="payment-confirmation-modes" disabled={pending}><legend className="sr-only">수정할 내용 선택</legend>{([{value:'planned',label:'예정 금액 수정'},{value:'actual',label:'실제 출금 확인'}] as const).map(item=><label key={item.value} data-selected={mode===item.value}><input type="radio" name="payment-confirmation-mode" value={item.value} checked={mode===item.value} onChange={()=>onChange(item.value)}/>{item.label}</label>)}</fieldset>;
}

export function PaymentConfirmationFields({mode,draft,pending,month,lastActualDate,suggestedDate,dateInput,onChange}:{mode:PaymentConfirmationMode;draft:PaymentConfirmationDraft;pending:boolean;month:{from:string;to:string};lastActualDate:string;suggestedDate:boolean;dateInput:RefObject<HTMLInputElement|null>;onChange:(patch:Partial<PaymentConfirmationDraft>)=>void}){
 const planned=mode==='planned';
 return <>
  <div className="payment-confirmation-fields"><label htmlFor="payment-confirmation-date">{planned?'예정 출금일':'실제 출금일'}<Input ref={dateInput} id="payment-confirmation-date" type="date" min={month.from} max={planned?month.to:lastActualDate} value={draft.date} disabled={pending} onInput={event=>onChange({date:event.currentTarget.value})} onChange={event=>onChange({date:event.target.value})}/><small>{planned?'이 달 안에서 선택 · 비워 두면 날짜 미정':suggestedDate?'계획일 자동 입력 · 수정 가능':'여러 건이면 마지막 출금일'}</small></label><label htmlFor="payment-confirmation-amount">{planned?'예정 출금액 (원)':'확인한 누적 출금액 (원)'}<Input id="payment-confirmation-amount" inputMode="numeric" maxLength={24} value={draft.amount} disabled={pending} onChange={event=>onChange({amount:event.target.value})}/></label></div>
  {!planned&&<label className="payment-confirmation-complete"><input type="checkbox" checked={draft.complete} disabled={pending} onChange={event=>onChange({complete:event.target.checked})}/><span>이 항목의 지출을 모두 완료했습니다<small>선택하지 않으면 일부 출금으로 확인하고 나머지 예산은 유지합니다.</small></span></label>}
  <label htmlFor="payment-confirmation-memo" className="payment-confirmation-memo-label">{planned?'계획 메모':'확인 메모'}<Textarea id="payment-confirmation-memo" value={draft.memo} maxLength={2000} disabled={pending} onChange={event=>onChange({memo:event.target.value})} placeholder={planned?'청구 금액이나 예정일을 확인한 근거':'확인한 통장 내역이나 지급 사유'}/></label>
 </>;
}
