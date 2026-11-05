"use client";

import {useCallback,useEffect,useRef,useState} from 'react';
import type {CashPlanEdit,CashPlanChange} from '@/lib/finance/cash-plan-edits';
import {publishDatasetChange,subscribeDatasetChanges} from '@/lib/finance/dataset-change-signal';
import {FixedCostRequestError,requestFixedCostSave} from '@/lib/finance/cash-plan-fixed-request';
import type {FixedCostForwardRequest,FixedCostSaveResult} from '@/lib/finance/cash-plan-series-forward';

export type CashPlanEditChange=CashPlanChange;
export type CashPlanEditState=ReturnType<typeof useCashPlanEdits>;
const localChangeEvent='finance-cash-plan-edits-changed';
class EditRequestError extends Error{
 constructor(message:string,readonly status:number){super(message);}
}
async function request(changes?:CashPlanEditChange[]):Promise<CashPlanEdit[]>{
 const response=await fetch('/api/cash-plan',changes?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({changes}),cache:'no-store'}:{cache:'no-store'});
 let result:{edits?:CashPlanEdit[];error?:string};
 try{result=await response.json();}catch{throw new EditRequestError('계획 설정 응답을 확인하지 못했습니다. 다시 불러와 주세요.',response.status);}
 if(!response.ok)throw new EditRequestError(response.status===401?'로그인이 만료되었습니다. 다시 로그인해 주세요.':response.status===409?'다른 관리자가 이 항목을 변경했습니다. 입력값은 유지했습니다. 최신 설정을 확인한 뒤 다시 편집해 주세요.':result.error||'계획 설정을 저장하거나 불러오지 못했습니다.',response.status);
 if(!Array.isArray(result.edits))throw new EditRequestError('계획 설정 목록을 확인하지 못했습니다. 다시 불러와 주세요.',response.status);
 return result.edits;
}

/** Shared server settings only. Financial drafts never enter browser storage. */
export function useCashPlanEdits(){
 const [edits,setEdits]=useState<CashPlanEdit[]|null>(null);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 const [saving,setSaving]=useState(false);
 const mounted=useRef(false),writing=useRef(false),generation=useRef(0);
 const refresh=useCallback(async()=>{
  if(writing.current)return;
  const current=++generation.current;
  try{
   const value=await request();
   if(mounted.current&&current===generation.current){setEdits(value);setError('');}
  }catch(cause){
   if(mounted.current&&current===generation.current)setError(cause instanceof Error?cause.message:'계획 설정을 불러오지 못했습니다.');
  }finally{if(mounted.current&&current===generation.current)setLoading(false);}
 },[]);
 useEffect(()=>{
  mounted.current=true;
  let active=true;
  void Promise.resolve().then(()=>{if(active)void refresh();});
  const reload=()=>{if(document.visibilityState==='visible')void refresh();};
  const unsubscribe=subscribeDatasetChanges(()=>void refresh());
  window.addEventListener(localChangeEvent,reload);
  window.addEventListener('focus',reload);
  document.addEventListener('visibilitychange',reload);
  return()=>{active=false;mounted.current=false;unsubscribe();window.removeEventListener(localChangeEvent,reload);window.removeEventListener('focus',reload);document.removeEventListener('visibilitychange',reload);};
 },[refresh]);
 const save=useCallback(async(changes:CashPlanEditChange[])=>{
  if(writing.current)throw Error('이전 변경사항을 저장하고 있습니다.');
  if(edits===null||error)throw Error('공동 계획 설정을 먼저 다시 불러와 주세요.');
  writing.current=true;generation.current++;
  if(mounted.current){setSaving(true);setLoading(false);}
  try{
   const value=await request(changes);
   generation.current++;
   if(mounted.current){setEdits(value);setError('');}
   // Keep a newly mounted same-tab view and other open tabs fresh as well.
   window.dispatchEvent(new Event(localChangeEvent));
   publishDatasetChange();
   return value;
  }catch(cause){
   if(cause instanceof EditRequestError&&cause.status===409){
    writing.current=false;
    await refresh();
   }
   throw cause;
  }finally{writing.current=false;if(mounted.current)setSaving(false);}
 },[edits,error,refresh]);
 const saveFixedCosts=useCallback(async(change:FixedCostForwardRequest,onApplied:(value:FixedCostSaveResult)=>void)=>{
  if(writing.current)throw Error('이전 변경사항을 저장하고 있습니다.');
  if(edits===null||error)throw Error('공동 계획 설정을 먼저 다시 불러와 주세요.');
  writing.current=true;generation.current++;
  if(mounted.current){setSaving(true);setLoading(false);}
  try{
   const value=await requestFixedCostSave(change);
   generation.current++;
   if(mounted.current){onApplied(value);setEdits(value.edits);setError('');}
   window.dispatchEvent(new Event(localChangeEvent));
   publishDatasetChange();
   return value;
  }catch(cause){
   if(cause instanceof FixedCostRequestError&&cause.status===409){
    writing.current=false;
    await refresh();
    // The competing change may affect a recurrence without changing its month.
    publishDatasetChange();
   }
   throw cause;
  }finally{writing.current=false;if(mounted.current)setSaving(false);}
 },[edits,error,refresh]);
 const reload=useCallback(async()=>{setLoading(true);await refresh();},[refresh]);
 return {edits,loading,error,saving,refresh:reload,save,saveFixedCosts};
}
