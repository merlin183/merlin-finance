"use client";
import {useCallback,useEffect,useState,useSyncExternalStore} from 'react';
import {Textarea} from '@/components/ui/textarea';
import {Button} from '@/components/ui/button';
import {noteSubject} from '@/lib/finance/merchant-notes';
import {createMerchantNoteStore,type NoteWrite,type NoteWriteResult} from '@/lib/finance/merchant-note-store';
import type {MerchantNote,Transaction} from '@/lib/finance/types';

async function writeNote(input:NoteWrite):Promise<NoteWriteResult>{
 const response=await fetch('/api/merchant-notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),keepalive:true});
 if(response.status===401||response.status===403)window.dispatchEvent(new Event('finance-auth-invalid'));
 const result=await response.json() as NoteWriteResult;
 return response.ok?result:{error:result.error||'메모 저장에 실패했습니다.',current:result.current};
}
export function useMerchantNotes(notes:MerchantNote[]){
 const [store]=useState(()=>createMerchantNoteStore(notes,writeNote));
 useEffect(()=>{store.hydrate(notes);},[store,notes]);
 useEffect(()=>{
  const handler=(event:BeforeUnloadEvent)=>{if(store.hasUnsaved())event.preventDefault();};
  window.addEventListener('beforeunload',handler);
  return()=>{window.removeEventListener('beforeunload',handler);store.dispose();};
 },[store]);
 return store;
}
export function MerchantNoteEditor({transaction,notes}:{transaction:Transaction;notes:ReturnType<typeof useMerchantNotes>}){
 const subscribe=useCallback((listener:()=>void)=>notes.subscribe(transaction,listener),[notes,transaction]);
 const snapshot=useCallback(()=>notes.state(transaction),[notes,transaction]);
 const state=useSyncExternalStore(subscribe,snapshot,snapshot),label=noteSubject(transaction).label;
 return <div className="merchant-note"><label><span>거래처 메모</span><Textarea aria-label={`${label} 메모`} value={state.text} maxLength={2000} rows={2} placeholder="용도·담당자 등" onChange={e=>notes.change(transaction,e.target.value)} onBlur={()=>void notes.save(transaction).catch(()=>{})}/></label>
  <div className="merchant-note-status"><span role="status">{state.status==='saving'?'저장 중…':state.status==='error'?'저장 확인 필요':state.text!==state.base?'자동 저장 대기 중…':state.version?'저장됨 · 관리자 공유':'자동 저장 · 관리자 공유'}</span>{(state.text!==state.base||state.status==='error')&&!state.current&&<Button size="sm" variant="ghost" disabled={state.status==='saving'} onClick={()=>void notes.save(transaction).catch(()=>{})}>저장</Button>}</div>
  {state.error&&<p role="alert" className="negative">{state.error}</p>}{state.current&&<div className="merchant-note-conflict"><strong>다른 관리자가 저장한 메모</strong><p>{state.current.memo||'(빈 메모)'}</p><Button size="sm" variant="outline" onClick={()=>notes.acceptCurrent(transaction,false)}>최신 메모 사용</Button><Button size="sm" variant="outline" onClick={()=>notes.acceptCurrent(transaction,true)}>내 초안 계속 편집</Button></div>}
 </div>;
}
