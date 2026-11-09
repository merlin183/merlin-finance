"use client";
import {FinancialText,FinancialValue,FinancialInput} from './financial-visibility';

import {useRef,useState} from 'react';
import {LoaderCircle} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {toast} from 'sonner';
import {needsCategoryReview} from '@/lib/finance/category-status';
import {won} from '@/lib/finance/format';
import type {Dataset,Transaction} from '@/lib/finance/types';
import {api} from './common';
import {CategoryPicker} from './category-picker';
import {sameTransferFeeVersion,transferFeeRequest} from './transaction-transfer-fee-model';

export function TransactionTransferFeeDialog({data,transaction,onClose,refresh,beforeSave}:{data:Dataset;transaction:Transaction;onClose:()=>void;refresh:()=>Promise<void>;beforeSave?:()=>Promise<void>}){
 const internalCategories=data.categories.filter(category=>category.is_internal&&!needsCategoryReview(category.name));
 const feeCategories=data.categories.filter(category=>!category.is_internal&&!needsCategoryReview(category.name));
 const [transferCategoryId,setTransferCategoryId]=useState(()=>internalCategories.find(category=>category.id===transaction.category_id)?.id||internalCategories.find(category=>category.name==='계좌간이체')?.id||'');
 const [feeCategoryId,setFeeCategoryId]=useState(()=>transaction.transfer_fee_category_id||feeCategories.find(category=>category.name==='지급수수료')?.id||'');
 const [feeAmount,setFeeAmount]=useState(()=>String(transaction.transfer_fee_amount??0));
 const [busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState('');
 const inFlight=useRef(false);
 const current=data.transactions.find(row=>row.id===transaction.id);
 const stale=!current||!sameTransferFeeVersion(transaction,current);
 const amount=Number(feeAmount),principal=/^\d+$/.test(feeAmount)&&Number.isSafeInteger(amount)&&amount>=0&&amount<transaction.amount?transaction.amount-amount:null;
 const account=data.accounts.find(item=>item.id===transaction.account_id);
 const business=data.businesses.find(item=>item.id===transaction.business_id);
 async function reload(){
  try{await refresh();onClose();}
  catch{setError('분류는 저장됐습니다. 화면 자료를 다시 불러와주세요.');}
 }
 async function save(){
  if(inFlight.current||saved)return;
  inFlight.current=true;setBusy(true);setError('');
  try{
   if(stale)throw Error('거래가 변경됐습니다. 닫은 뒤 최신 거래에서 다시 확인해주세요.');
   const request=transferFeeRequest(transaction,data.categories,{transferCategoryId,feeCategoryId,feeAmount});
   await beforeSave?.();
   const result=await api<{ok?:boolean}>('/api/transaction-transfer-fee',request);
   if(result.ok!==true)throw Error('저장 결과를 확인하지 못했습니다. 같은 내용으로 다시 확인해주세요.');
   setSaved(true);toast.success('통장 원본을 유지하고 이체 원금과 수수료를 분류했습니다.');
   await reload();
  }catch(cause){setError(cause instanceof Error?cause.message:'분류를 저장하지 못했습니다. 같은 내용으로 다시 확인해주세요.');}
  finally{inFlight.current=false;setBusy(false);}
 }
 return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent className="transfer-fee-dialog" onInteractOutside={event=>{if(busy)event.preventDefault();}} onEscapeKeyDown={event=>{if(busy)event.preventDefault();}}><DialogHeader><DialogTitle>계좌간이체 · 수수료 분리</DialogTitle><DialogDescription>{business?.name} · <FinancialText value={String((account?.name)||'')}/> · {transaction.txn_date}{transaction.txn_time?` ${transaction.txn_time}`:''}</DialogDescription></DialogHeader>
  <div className="transfer-fee-original"><span><FinancialText value={String((transaction.description||'적요 없음')||'')}/></span><strong>통장 출금액 <FinancialValue value={won(transaction.amount)}/></strong></div>
  <p className="transfer-fee-help">통장 원본은 한 건으로 유지합니다. 이 거래의 출금액 안에서 이체 원금과 수수료만 나눕니다.</p>
  <div className="transfer-fee-fields"><div><span>이체 원금 계정과목</span><CategoryPicker label="이체 원금 계정과목" categories={internalCategories} aliases={data.aliases} value={transferCategoryId} onChange={setTransferCategoryId} disabled={busy||saved}/></div><label htmlFor="transfer-fee-amount">이체 수수료(원)<FinancialInput id="transfer-fee-amount" type="text" inputMode="numeric" autoComplete="off" value={feeAmount} disabled={busy||saved} onChange={event=>setFeeAmount(event.target.value)}/></label><div><span>수수료 계정과목</span><CategoryPicker label="수수료 계정과목" categories={feeCategories} aliases={data.aliases} value={feeCategoryId} onChange={setFeeCategoryId} disabled={busy||saved||amount===0}/></div></div>
  <div className="transfer-fee-principal"><span>이체 원금</span><strong><FinancialValue value={principal===null?'금액 확인 필요':won(principal)}/></strong></div>
  {(error||(stale&&!saved))&&<p className="transfer-fee-error" role="alert"><FinancialText value={String((error||'거래가 변경됐습니다. 닫은 뒤 최신 거래에서 다시 확인해주세요.')||'')}/></p>}
  {saved&&<p role="status" className="transfer-fee-help">분류 저장 완료 · 화면 갱신이 필요하면 재조회만 진행합니다.</p>}
  <div className="transfer-fee-actions"><Button variant="outline" disabled={busy} onClick={onClose}>닫기</Button>{saved?<Button disabled={busy} onClick={()=>{setBusy(true);void reload().finally(()=>setBusy(false));}}>화면 자료 재조회</Button>:<Button disabled={busy||stale||principal===null||!transferCategoryId||(amount>0&&!feeCategoryId)} onClick={()=>void save()}>{busy&&<LoaderCircle size={16} className="animate-spin"/>}이 거래만 분류 저장</Button>}</div>
 </DialogContent></Dialog>;
}
