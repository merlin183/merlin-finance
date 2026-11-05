"use client";

import {useCallback,useMemo,useState,useSyncExternalStore} from 'react';
import {CASH_PLAN_PERIOD_STORAGE_KEY,restoreCashPlanPeriod,serializeCashPlanPeriod} from '@/lib/finance/cash-plan-period';
import type {DateRange} from '@/lib/finance/date-range';

const eventName='finance-cash-plan-period-change';
let temporaryValue:string|null=null;
function readPreference():string|null {
 if(temporaryValue!==null)return temporaryValue;
 try{return window.localStorage.getItem(CASH_PLAN_PERIOD_STORAGE_KEY);}catch{return null;}
}
function subscribe(onChange:()=>void){
 const onStorage=(event:StorageEvent)=>{if(event.key===CASH_PLAN_PERIOD_STORAGE_KEY||event.key===null){temporaryValue=null;onChange();}};
 window.addEventListener('storage',onStorage);
 window.addEventListener(eventName,onChange);
 return ()=>{window.removeEventListener('storage',onStorage);window.removeEventListener(eventName,onChange);};
}
const serverPreference=()=>null;

/** Store only the selected dates in this browser; never financial records. */
export function useCashPlanPeriod(){
 const serialized=useSyncExternalStore(subscribe,readPreference,serverPreference);
 const range=useMemo(()=>restoreCashPlanPeriod(serialized),[serialized]);
 const [saveError,setSaveError]=useState('');
 const applyRange=useCallback((next:DateRange)=>{
  const value=serializeCashPlanPeriod(next);
  try{
   window.localStorage.setItem(CASH_PLAN_PERIOD_STORAGE_KEY,value);
   temporaryValue=null;setSaveError('');
  }catch{
   temporaryValue=value;setSaveError('이 브라우저에서 기간을 저장할 수 없어 현재 열린 화면에만 적용했습니다.');
  }
  window.dispatchEvent(new Event(eventName));
 },[]);
 return {range,applyRange,saveError};
}
