"use client";

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {toast} from 'sonner';
import type {Dataset} from '@/lib/finance/types';
import {subscribeDatasetChanges} from '@/lib/finance/dataset-change-signal';
import {settleDatasetMutation} from '@/lib/finance/dataset-refresh';
import {reconcileTossSettlements} from '@/lib/toss/reconcile';
import type {TossSettlementResponse} from '@/lib/toss/types';

async function request(method:'GET'|'POST',signal?:AbortSignal):Promise<TossSettlementResponse>{
 const response=await fetch('/api/toss/settlements',{method,cache:'no-store',signal,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:'{}'}:{})});
 const result=await response.json() as TossSettlementResponse&{error?:string};
 if(!response.ok){
  if(response.status===401)window.dispatchEvent(new Event('finance-auth-invalid'));
  throw Error(result.error||'토스 정산 자료를 확인하지 못했습니다.');
 }
 return result;
}

export function useTossSettlements({data,asOf,refresh}:{data:Dataset;asOf:string;refresh:()=>Promise<void>}){
 const [response,setResponse]=useState<TossSettlementResponse|null>(null);
 const [loading,setLoading]=useState(true),[syncing,setSyncing]=useState(false),[error,setError]=useState('');
 const sequence=useRef(0),alive=useRef(true),syncBusy=useRef(false),refreshRef=useRef(refresh);
 useEffect(()=>{refreshRef.current=refresh;},[refresh]);
 const load=useCallback(async(signal?:AbortSignal)=>{
  const id=++sequence.current;
  try{
   const result=await request('GET',signal);
   if(!signal?.aborted&&alive.current&&sequence.current===id){setResponse(result);setError('');}
  }catch(cause){if(!signal?.aborted&&alive.current&&sequence.current===id)setError(cause instanceof Error?cause.message:'토스 정산 자료를 확인하지 못했습니다.');}
  finally{if(!signal?.aborted&&alive.current&&sequence.current===id)setLoading(false);}
 },[]);
 useEffect(()=>{
  alive.current=true;const controller=new AbortController();
  void Promise.resolve().then(()=>{if(!controller.signal.aborted)return load(controller.signal);});
  const unsubscribe=subscribeDatasetChanges(()=>{if(!syncBusy.current)void load(controller.signal);});
  return()=>{alive.current=false;controller.abort();unsubscribe();};
 },[load]);
 const sync=useCallback(async()=>{
  if(syncBusy.current)return;
  syncBusy.current=true;sequence.current++;setSyncing(true);setError('');
  try{
   const result=await request('POST');
   if(alive.current){setResponse(result);setLoading(false);}
   const completion=await settleDatasetMutation(Promise.resolve(result),()=>refreshRef.current());
   if(completion.refreshed)toast.success('토스 정산 동기화 완료',{description:'입금 예정액과 통장 입금 여부를 다시 계산했습니다.'});
   else toast.warning('정산 저장 완료 · 통장 자료 새로고침 필요');
  }catch(cause){const message=cause instanceof Error?cause.message:'토스 정산 동기화에 실패했습니다.';if(alive.current)setError(message);toast.error(message);}
  finally{syncBusy.current=false;if(alive.current)setSyncing(false);}
 },[]);
 const groups=useMemo(()=>response?.configured?reconcileTossSettlements(data,response.settlements,response.merchants,asOf):[],[data,response,asOf]);
 return {response,groups,loading,syncing,error,sync,reload:()=>load()};
}

export type TossSettlementState=ReturnType<typeof useTossSettlements>;
