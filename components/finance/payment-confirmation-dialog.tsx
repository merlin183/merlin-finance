"use client";
import {FinancialValue,FinancialText} from './financial-visibility';

import {useCallback,useEffect,useRef,useState,type RefObject} from 'react';
import {Check,LoaderCircle,X} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import type {CashPlanWorksheetRow} from '@/lib/finance/cash-plan-worksheet-model';
import type {Alias,Business,Category} from '@/lib/finance/types';
import {mergeCashPlanCategory} from '@/lib/finance/cash-plan-category';
import {calendarMonthRange} from '@/lib/finance/transaction-calendar';
import {cashPlanPaymentConfirmationChange} from '@/lib/finance/cash-plan-payment-confirmation';
import {cashPlanPlannedPaymentChange} from '@/lib/finance/cash-plan-planned-payment';
import type {CashPlanEditChange,CashPlanEditState} from './use-cash-plan-edits';
import {initialPaymentConfirmationDraft,paymentConfirmationSourceGross,initialPaymentConfirmationMode,initialPlannedPaymentDraft,paymentConfirmationDraftError,paymentConfirmationDraftValues,paymentConfirmationDraftsDirty,plannedPaymentDraftError,plannedPaymentDraftValues,updatePaymentConfirmationDraft,type PaymentConfirmationDraft,type PaymentConfirmationDrafts,type PaymentConfirmationMode} from './payment-confirmation-draft';
import {PaymentConfirmationFields,PaymentConfirmationModePicker} from './payment-confirmation-fields';
import {CategoryPicker} from './category-picker';
import './payment-confirmation-dialog.css';

type Props={row:CashPlanWorksheetRow|undefined;business:Business|undefined;accountName:string;categories:Category[];aliases:Alias[];asOf:string;saving:boolean;loadError:string;onReload:()=>Promise<void>;onSave:CashPlanEditState['save'];onClose:()=>void;returnFocusRef:RefObject<HTMLButtonElement|null>};
const digits=(value:number)=>value.toLocaleString('ko-KR');

export function PaymentConfirmationDialog(props:Props){
 const closeHandler=useRef<(()=>void)|null>(null);
 const registerClose=useCallback((handler:()=>void)=>{closeHandler.current=handler;},[]);
 return <Dialog open={!!props.row&&!!props.business} onOpenChange={open=>{if(!open&&!props.saving)closeHandler.current?.();}}>
  <DialogContent className="payment-confirmation-dialog" showCloseButton={false} onEscapeKeyDown={event=>{if(props.saving)event.preventDefault();}} onInteractOutside={event=>{if(props.saving)event.preventDefault();}} onCloseAutoFocus={event=>{event.preventDefault();props.returnFocusRef.current?.focus({preventScroll:true});}}>
   {props.row&&props.business&&<ConfirmationBody key={props.row.key} {...props} row={props.row} business={props.business} registerClose={registerClose}/>}
  </DialogContent>
 </Dialog>;
}

function ConfirmationBody({row,business,accountName,categories,aliases,asOf,saving,loadError,onReload,onSave,onClose,registerClose}:Props&{row:CashPlanWorksheetRow;business:Business;registerClose:(handler:()=>void)=>void}){
 const sourceGross=paymentConfirmationSourceGross({businessId:row.businessId,month:row.month,asOf,recordedTransactions:row.editorItem.recordedTransactions,recordedPaymentDates:row.recordedPaymentDates});
 const [originalItem]=useState(()=>row.editorItem);
 const [categoryOverrideId,setCategoryOverrideId]=useState<string|null>(()=>row.editorItem.categoryOverrideId);
 const [originalDrafts]=useState<PaymentConfirmationDrafts>(()=>({actual:initialPaymentConfirmationDraft(row),planned:initialPlannedPaymentDraft(row.editorItem)}));
 const [drafts,setDrafts]=useState<PaymentConfirmationDrafts>(originalDrafts);
 const [mode,setMode]=useState<PaymentConfirmationMode>(()=>initialPaymentConfirmationMode({confirmation:row.confirmation,date:row.editorItem.date},asOf));
 const planned=mode==='planned';
 const draft:PaymentConfirmationDraft=planned?{...drafts.planned,complete:false}:drafts.actual;
 const [error,setError]=useState('');
 const [submitting,setSubmitting]=useState(false);
 const [discardPrompt,setDiscardPrompt]=useState(false);
 const dateInput=useRef<HTMLInputElement|null>(null),busy=useRef(false);
 const pending=saving||submitting;
 const currentEdit=row.editorItem.edit,originalEdit=originalItem.edit;
 const stale=(currentEdit?.id??'')!==(originalEdit?.id??'')||(currentEdit?.version??0)!==(originalEdit?.version??0);
 const locked=pending||!!loadError||stale;
 const dirty=paymentConfirmationDraftsDirty(originalDrafts,drafts)||categoryOverrideId!==originalItem.categoryOverrideId;
 const month=calendarMonthRange(row.month),lastDate=month.to<asOf?month.to:asOf;
 const close=useCallback(()=>{if(busy.current||saving)return;if(dirty){setDiscardPrompt(true);return;}onClose();},[saving,dirty,onClose]);
 useEffect(()=>registerClose(close),[registerClose,close]);
 function change(patch:Partial<PaymentConfirmationDraft>){setDrafts(current=>updatePaymentConfirmationDraft(current,mode,patch));setError('');setDiscardPrompt(false);}
 function selectMode(next:PaymentConfirmationMode){if(pending)return;setMode(next);setError('');setDiscardPrompt(false);}
 async function commit(clear=false){
  if(busy.current||locked)return;
  const next={...draft,date:dateInput.current?.value??draft.date};
  if(!clear){
   const invalid=dateInput.current?.validity.badInput?`${planned?'예정':'실제'} 출금일을 완전하게 입력해 주세요.`:planned?plannedPaymentDraftError(next,row.month):paymentConfirmationDraftError(next,row.month,asOf);
   if(invalid){setError(invalid);return;}
   if(planned&&categoryOverrideId&&!categories.some(category=>category.id===categoryOverrideId)){setError('현재 사용할 수 있는 계정과목을 선택해 주세요.');return;}
  }
  busy.current=true;setSubmitting(true);setError('');
  try{
   let change:CashPlanEditChange=clear?cashPlanPaymentConfirmationChange(originalItem,null):planned?cashPlanPlannedPaymentChange(originalItem,plannedPaymentDraftValues(next)):cashPlanPaymentConfirmationChange(originalItem,paymentConfirmationDraftValues(next));
   if(planned&&change.action==='save')change={...change,memo:mergeCashPlanCategory(change.memo,categoryOverrideId)};
   await onSave([change]);
   toast.success(<FinancialText value={String(clear?'직접 출금 확인을 취소했습니다.':planned?'예정 금액을 저장하고 자금계획을 다시 계산했습니다.':'출금 확인을 저장하고 남은 지출·필요자금을 다시 계산했습니다.')}/>);
   onClose();
  }catch(cause){setError(cause instanceof Error?cause.message:'저장하지 못했습니다. 입력값은 유지했습니다.');}
  finally{busy.current=false;setSubmitting(false);}
 }
 return <>
  <DialogHeader className="payment-confirmation-heading"><div><DialogTitle>{planned?'예정 금액 수정':'실제 출금 확인'}</DialogTitle><DialogDescription>{business.name} · <FinancialText value={row.title}/></DialogDescription></div><Button type="button" variant="ghost" size="icon" aria-label="출금 확인 닫기" disabled={pending} onClick={close}><X size={18}/></Button></DialogHeader>
  <div className="payment-confirmation-body" aria-busy={pending}>
   <PaymentConfirmationModePicker mode={mode} pending={pending} onChange={selectMode}/>
   <dl className="payment-confirmation-plan"><div><dt>계획 금액</dt><dd><FinancialValue value={digits(originalItem.amount)}/>원</dd></div><div><dt>출금 계좌</dt><dd><FinancialText value={accountName||'계좌 미지정'}/></dd></div></dl>
   <p className="payment-confirmation-help">{planned?'예정일과 월 계획 금액을 수정합니다. 실제 출금 완료 처리가 아니며 통장 잔액·거래내역은 바뀌지 않습니다.':'반환 전 출금 총액을 입력하고, 돌려받은 금액은 ‘반환 입금 반영’에서 구분하세요. 통장 잔액과 거래내역은 바뀌지 않습니다.'}</p>
   {!planned&&draft.date>asOf&&<p className="payment-confirmation-help">미래 예정일·금액은 ‘예정 금액 수정’에서 저장하세요.</p>}
   {loadError&&<div className="payment-confirmation-error" role="alert"><p><FinancialText value={loadError}/> 저장된 확인 상태를 먼저 다시 불러와 주세요.</p><Button type="button" variant="outline" size="sm" disabled={pending} onClick={()=>void onReload()}>상태 다시 불러오기</Button></div>}
   {stale&&<p className="payment-confirmation-error" role="alert">다른 관리자가 이 항목을 변경했습니다. 입력값은 유지했습니다. 최신 내용을 확인하려면 닫은 뒤 다시 열어 주세요.</p>}
   {error&&<p className="payment-confirmation-error" role="alert"><FinancialText value={error}/></p>}
   {discardPrompt&&<div className="payment-confirmation-error" role="alert"><p>저장하지 않은 입력값이 있습니다.</p><Button type="button" variant="outline" size="sm" onClick={()=>setDiscardPrompt(false)}>계속 입력</Button><Button type="button" variant="outline" size="sm" onClick={onClose}>입력 취소하고 닫기</Button></div>}
   <form id="payment-confirmation-form" noValidate onSubmit={event=>{event.preventDefault();void commit();}}>
    {planned&&<div className="payment-confirmation-memo-label"><span>계정과목</span><CategoryPicker label="예정 계획 계정과목" value={categoryOverrideId??'all'} onChange={id=>{setCategoryOverrideId(id==='all'?null:id);setError('');setDiscardPrompt(false);}} categories={categories} aliases={aliases} allLabel={`원본 과목 유지${originalItem.sourceCategoryId?` · ${categories.find(category=>category.id===originalItem.sourceCategoryId)?.name??'과목 미지정'}`:''}`} disabled={locked}/><small className="payment-confirmation-help">이 계획에만 적용하며 실제 거래의 과목은 유지합니다.</small></div>}
    <PaymentConfirmationFields key={mode} mode={mode} draft={draft} pending={pending} month={month} lastActualDate={lastDate} suggestedDate={!row.confirmation&&!!row.date} dateInput={dateInput} onChange={change} recordedAmount={sourceGross}/>
   </form>
   {pending&&<p className="payment-confirmation-saving" role="status"><LoaderCircle size={15} className="animate-spin"/>{planned?'예정 금액 저장 중…':'출금 확인 저장 중…'}</p>}
  </div>
  <footer className="payment-confirmation-footer"><div>{!planned&&row.confirmation&&<Button type="button" variant="outline" disabled={locked} onClick={()=>void commit(true)}>확인 취소</Button>}</div><div><Button type="button" variant="outline" disabled={pending} onClick={close}>닫기</Button><Button type="submit" form="payment-confirmation-form" disabled={locked}>{pending?<LoaderCircle size={15} className="animate-spin"/>:<Check size={15}/>} {planned?'예정 금액 저장':'확인 저장'}</Button></div></footer>
 </>;
}
