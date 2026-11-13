"use client";
import {FinancialInput,FinancialValue,useFinancialVisibility} from './financial-visibility';

import type {RefObject} from 'react';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {paymentConfirmationReturnPatch,type PaymentConfirmationDraft,type PaymentConfirmationMode} from './payment-confirmation-draft';

export function PaymentConfirmationModePicker({mode,pending,onChange}:{mode:PaymentConfirmationMode;pending:boolean;onChange:(mode:PaymentConfirmationMode)=>void}){
 return <fieldset className="payment-confirmation-modes" disabled={pending}><legend className="sr-only">수정할 내용 선택</legend>{([{value:'planned',label:'예정 금액 수정'},{value:'actual',label:'실제 출금 확인'}] as const).map(item=><label key={item.value} data-selected={mode===item.value}><input type="radio" name="payment-confirmation-mode" value={item.value} checked={mode===item.value} onChange={()=>onChange(item.value)}/>{item.label}</label>)}</fieldset>;
}

export function PaymentConfirmationFields({mode,draft,pending,month,lastActualDate,suggestedDate,dateInput,onChange,recordedAmount=0}:{mode:PaymentConfirmationMode;draft:PaymentConfirmationDraft;pending:boolean;month:{from:string;to:string};lastActualDate:string;suggestedDate:boolean;dateInput:RefObject<HTMLInputElement|null>;onChange:(patch:Partial<PaymentConfirmationDraft>)=>void;recordedAmount?:number|null}){
 const {privateText,amountsVisible}=useFinancialVisibility();
 const planned=mode==='planned';
 const gross=Math.max(Number(draft.amount.replaceAll(',','').trim())||0,recordedAmount??0),returned=Number((draft.returnedAmount??'').replaceAll(',','').trim())||0;
 const net=Math.max(0,gross-returned);
 return <>
  <div className="payment-confirmation-fields"><label htmlFor="payment-confirmation-date">{planned?'예정 출금일':'실제 출금일'}<Input ref={dateInput} id="payment-confirmation-date" type="date" min={month.from} max={planned?month.to:lastActualDate} value={draft.date} disabled={pending} onInput={event=>onChange({date:event.currentTarget.value})} onChange={event=>onChange({date:event.target.value})}/><small>{planned?'이 달 안에서 선택 · 비워 두면 날짜 미정':suggestedDate?'계획일 자동 입력 · 수정 가능':'여러 건이면 마지막 출금일'}</small></label><label htmlFor="payment-confirmation-amount">{planned?'예정 출금액 (원)':draft.returnEnabled?'누적 출금액 (반환 전)':'확인한 누적 출금액 (원)'}<FinancialInput id="payment-confirmation-amount" inputMode="numeric" maxLength={24} value={draft.amount} disabled={pending} onChange={event=>onChange({amount:event.target.value})}/></label></div>
  {!planned&&<div className="payment-confirmation-return">
   <label className="payment-confirmation-return-toggle"><input type="checkbox" checked={!!draft.returnEnabled} disabled={pending||!amountsVisible} onChange={event=>onChange(paymentConfirmationReturnPatch(draft,event.target.checked,recordedAmount,lastActualDate))}/><span>반환 입금 반영</span></label>
   {draft.returnEnabled&&<><div className="payment-confirmation-fields"><label htmlFor="payment-confirmation-returned-amount">돌려받은 금액 (원)<FinancialInput id="payment-confirmation-returned-amount" inputMode="numeric" maxLength={24} value={draft.returnedAmount??''} disabled={pending} onChange={event=>onChange({returnedAmount:event.target.value})}/></label><label htmlFor="payment-confirmation-returned-date">반환 입금일<Input id="payment-confirmation-returned-date" type="date" min={month.from} max={lastActualDate} value={draft.returnedDate??''} disabled={pending} onChange={event=>onChange({returnedDate:event.target.value})}/></label></div>
   <p className="payment-confirmation-net">순지출 <strong><FinancialValue value={net.toLocaleString('ko-KR')}/>원</strong><small>출금과 반환을 구분해 기록합니다.</small></p></>}
  </div>}
  {!planned&&<label className="payment-confirmation-complete"><input type="checkbox" checked={draft.complete} disabled={pending} onChange={event=>onChange({complete:event.target.checked})}/><span>이 항목의 지출을 모두 완료했습니다<small>선택하지 않으면 일부 출금으로 확인하고 나머지 예산은 유지합니다.</small></span></label>}
  <label htmlFor="payment-confirmation-memo" className="payment-confirmation-memo-label">{planned?'계획 메모':'확인 메모'}<Textarea id="payment-confirmation-memo" value={privateText(draft.memo)} readOnly={privateText(draft.memo)!==draft.memo} maxLength={2000} disabled={pending} onChange={event=>onChange({memo:event.target.value})} placeholder={planned?'청구 금액이나 예정일을 확인한 근거':'확인한 통장 내역이나 지급 사유'}/></label>
 </>;
}
