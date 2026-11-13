"use client";

import {useCallback,useEffect,useRef,useState,type RefObject} from 'react';
import {Check,LoaderCircle,X} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import type {CashPlanWorksheetActualOnlyRow} from '@/lib/finance/cash-plan-worksheet-model';
import type {Alias,Category,Transaction} from '@/lib/finance/types';
import {api} from './common';
import {CategoryPicker} from './category-picker';
import {FinancialText,FinancialValue} from './financial-visibility';

export type CashPlanActualCategorySelection={row:CashPlanWorksheetActualOnlyRow;transaction:Transaction};
type Props={selection:CashPlanActualCategorySelection|null;currentTransaction:Transaction|undefined;categories:Category[];aliases:Alias[];accountName:string;businessName:string;refresh:()=>Promise<void>;onClose:()=>void;returnFocusRef:RefObject<HTMLButtonElement|null>};

/** Only a saved ledger transaction is editable. A provider reference by itself
 * is never an identity that may be sent to the transaction update endpoint. */
export function cashPlanActualCategoryConflict(original:Transaction,current:Transaction|undefined){
 return !current||(['id','business_id','account_id','direction','txn_date','amount','category_id','is_internal','manually_classified'] as const).some(key=>original[key]!==current[key])
  ||(original.transfer_fee_amount??0)!==(current.transfer_fee_amount??0)||(original.transfer_fee_category_id??null)!==(current.transfer_fee_category_id??null);
}

/** Keep write completion separate from read-back completion. A refresh retry
 * never repeats a successful classification request. */
export async function saveCashPlanActualCategory({transactionId,categoryId,savedRef,busyRef,post,refresh,onSaved}:{transactionId:string;categoryId:string;savedRef:RefObject<string|null>;busyRef:RefObject<boolean>;post:(body:{ids:string[];category_id:string})=>Promise<unknown>;refresh:()=>Promise<void>;onSaved:(id:string)=>void}){
 if(busyRef.current)return false;
 busyRef.current=true;
 try{
  if(!savedRef.current){
   await post({ids:[transactionId],category_id:categoryId});
   savedRef.current=categoryId;onSaved(categoryId);
  }
  await refresh();
  return true;
 }finally{busyRef.current=false;}
}

export function CashPlanActualCategoryDialog(props:Props){
 const closeHandler=useRef<(()=>void)|null>(null),busyRef=useRef(false);
 const registerClose=useCallback((handler:()=>void)=>{closeHandler.current=handler;},[]);
 return <Dialog open={!!props.selection} onOpenChange={open=>{if(!open)closeHandler.current?.();}}>
  <DialogContent className="payment-confirmation-dialog" showCloseButton={false} onEscapeKeyDown={event=>{if(busyRef.current)event.preventDefault();}} onInteractOutside={event=>{if(busyRef.current)event.preventDefault();}} onCloseAutoFocus={event=>{event.preventDefault();props.returnFocusRef.current?.focus({preventScroll:true});}}>
   {props.selection&&<ActualCategoryBody key={props.selection.transaction.id} {...props} selection={props.selection} busyRef={busyRef} registerClose={registerClose}/>}
  </DialogContent>
 </Dialog>;
}

function ActualCategoryBody({selection,currentTransaction,categories,aliases,accountName,businessName,refresh,onClose,busyRef,registerClose}:Props&{selection:CashPlanActualCategorySelection;busyRef:RefObject<boolean>;registerClose:(handler:()=>void)=>void}){
 const {row,transaction:original}=selection;
 const [categoryId,setCategoryId]=useState(original.category_id??'');
 const [pending,setPending]=useState(false),[error,setError]=useState(''),[discardPrompt,setDiscardPrompt]=useState(false);
 const [savedCategoryId,setSavedCategoryId]=useState<string|null>(null);
 const savedCategoryRef=useRef<string|null>(null);
 const stale=cashPlanActualCategoryConflict(original,currentTransaction);
 const dirty=categoryId!==(original.category_id??'');
 const locked=pending||stale||savedCategoryId!==null;
 const close=useCallback(()=>{if(busyRef.current)return;if(dirty&&!savedCategoryId){setDiscardPrompt(true);return;}onClose();},[busyRef,dirty,savedCategoryId,onClose]);
 useEffect(()=>registerClose(close),[registerClose,close]);
 async function save(){
  if(busyRef.current)return;
  if(!savedCategoryId){
   if(stale){setError('공유 거래의 현재 과목이 변경되었습니다. 입력값은 유지했습니다. 최신 내용을 확인한 뒤 다시 열어 주세요.');return;}
   if(!row.editableTransactionId||row.editableTransactionId!==original.id||!currentTransaction){setError('저장된 거래를 확인할 수 없습니다. 거래 불러오기에서 적용 상태를 확인해 주세요.');return;}
   if(!categoryId||!categories.some(category=>category.id===categoryId)){setError('계정과목을 선택해 주세요.');return;}
  }
  setPending(true);setError('');
  try{
   const completed=await saveCashPlanActualCategory({transactionId:original.id,categoryId,savedRef:savedCategoryRef,busyRef,post:body=>api('/api/transactions',body),refresh,onSaved:setSavedCategoryId});
   if(!completed)return;
   toast.success('선택한 실제 거래 1건의 계정과목을 수정했습니다.');
   onClose();
  }catch(cause){
   setError(savedCategoryRef.current?'과목은 저장했지만 화면 자료를 다시 불러오지 못했습니다. ‘자료 새로고침’으로 다시 조회해 주세요.':cause instanceof Error?cause.message:'과목을 저장하지 못했습니다. 선택값은 유지했습니다.');
  }finally{setPending(false);}
 }
 return <>
  <DialogHeader className="payment-confirmation-heading"><div><DialogTitle>실제 거래 과목 수정</DialogTitle><DialogDescription><FinancialText value={businessName}/> · <FinancialText value={row.title}/></DialogDescription></div><Button type="button" variant="ghost" size="icon" aria-label="과목 수정 닫기" disabled={pending} onClick={close}><X size={18}/></Button></DialogHeader>
  <div className="payment-confirmation-body" aria-busy={pending}>
   <dl className="payment-confirmation-plan"><div><dt>실제 출금일</dt><dd>{original.txn_date}</dd></div><div><dt>출금 계좌</dt><dd><FinancialText value={accountName}/></dd></div><div><dt>실제 출금액</dt><dd><FinancialValue value={original.amount.toLocaleString('ko-KR')}/>원</dd></div><div><dt>현재 계정과목</dt><dd><FinancialText value={categories.find(category=>category.id===original.category_id)?.name??'미분류'}/></dd></div></dl>
   <p className="payment-confirmation-help">선택한 실제 거래 1건의 과목을 수정합니다. 같은 상대방의 다른 거래에는 적용하지 않습니다.</p>
   {(original.transfer_fee_amount??0)>0&&<p className="payment-confirmation-error">이 거래에 설정된 이체 수수료 분리는 과목을 바꾸면 해제됩니다.</p>}
   {stale&&!savedCategoryId&&<p className="payment-confirmation-error" role="alert">다른 관리자가 이 거래를 변경했거나 현재 자료에서 확인되지 않습니다. 선택값은 유지했습니다. 최신 내용을 확인한 뒤 다시 열어 주세요.</p>}
   {error&&<p className="payment-confirmation-error" role="alert"><FinancialText value={error}/></p>}
   {discardPrompt&&<div className="payment-confirmation-error" role="alert"><p>저장하지 않은 선택값이 있습니다.</p><Button type="button" variant="outline" size="sm" onClick={()=>setDiscardPrompt(false)}>계속 편집</Button><Button type="button" variant="outline" size="sm" onClick={onClose}>입력 취소하고 닫기</Button></div>}
   <form id="cash-plan-actual-category-form" onSubmit={event=>{event.preventDefault();void save();}}><div className="payment-confirmation-memo-label"><span>변경할 계정과목</span><CategoryPicker label="실제 거래 계정과목" value={categoryId} onChange={id=>{setCategoryId(id);setError('');setDiscardPrompt(false);}} categories={categories} aliases={aliases} disabled={locked}/></div></form>
   {pending&&<p className="payment-confirmation-saving" role="status"><LoaderCircle size={15} className="animate-spin"/>{savedCategoryId?'자료 다시 불러오는 중…':'과목 저장 중…'}</p>}
  </div>
  <footer className="payment-confirmation-footer"><div/><div><Button type="button" variant="outline" disabled={pending} onClick={close}>닫기</Button><Button type="submit" form="cash-plan-actual-category-form" disabled={pending||(!savedCategoryId&&(stale||!dirty))}>{pending?<LoaderCircle size={15} className="animate-spin"/>:<Check size={15}/>} {savedCategoryId?'자료 새로고침':'과목 저장'}</Button></div></footer>
 </>;
}
