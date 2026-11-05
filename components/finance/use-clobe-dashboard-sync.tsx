"use client";

import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {LoaderCircle,RefreshCw} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {clobeDashboardSyncCoordinator,type ClobeDashboardSyncSnapshot} from '@/lib/finance/clobe-dashboard-sync-client';
import type {Dataset} from '@/lib/finance/types';
import {clobeDashboardSyncBusy,clobeDashboardSyncProgress,clobeDashboardSyncResultLine,clobeDashboardSyncResultTitle} from './clobe-dashboard-sync-display';
import {ClobeDashboardSyncSummary} from './clobe-dashboard-sync-summary';

type SyncContext={snapshot:ClobeDashboardSyncSnapshot;busy:boolean;start:()=>void;retryRefresh:()=>void;showResult:()=>void};
const ClobeDashboardSyncContext=createContext<SyncContext|null>(null);

export function ClobeDashboardSyncProvider({actorKey,refresh,accounts,businesses,children}:{actorKey:string;refresh:()=>Promise<void>;accounts:Dataset['accounts'];businesses?:Dataset['businesses'];children?:ReactNode}){
 const snapshot=useSyncExternalStore(clobeDashboardSyncCoordinator.subscribe,clobeDashboardSyncCoordinator.getSnapshot,clobeDashboardSyncCoordinator.getServerSnapshot);
 const refreshRef=useRef(refresh),announced=useRef<ClobeDashboardSyncSnapshot['result']>(null);
 const [open,setOpen]=useState(false);
 useEffect(()=>{refreshRef.current=refresh;},[refresh]);
 useEffect(()=>()=>{clobeDashboardSyncCoordinator.reset();},[actorKey]);
 useEffect(()=>{
  const result=snapshot.result;
  if((snapshot.phase!=='done'&&snapshot.phase!=='refresh-needed')||!result||announced.current===result)return;
  announced.current=result;
  const title=clobeDashboardSyncResultTitle(result),description=clobeDashboardSyncResultLine(result);
  if(result.fullSuccess&&!result.ledger.unclassified)toast.success(title,{description});
  else toast.warning(title,{description});
 },[snapshot.phase,snapshot.result]);
 const read=useCallback(()=>refreshRef.current(),[]);
 const start=useCallback(()=>{const task=clobeDashboardSyncCoordinator.start({actorKey,refresh:read});void task?.catch(cause=>toast.error(cause instanceof Error?cause.message:'최신 동기화 결과를 확인하지 못했습니다.'));},[actorKey,read]);
 const retryRefresh=useCallback(()=>{const task=clobeDashboardSyncCoordinator.retryRefresh({actorKey,refresh:read});void task?.catch(cause=>toast.error(cause instanceof Error?cause.message:'화면 자료를 다시 조회하지 못했습니다.'));},[actorKey,read]);
 const showResult=useCallback(()=>setOpen(true),[]);
 const busy=clobeDashboardSyncBusy(snapshot.phase);
 const value=useMemo(()=>({snapshot,busy,start,retryRefresh,showResult}),[snapshot,busy,start,retryRefresh,showResult]);
 return <ClobeDashboardSyncContext.Provider value={value}>{children}<Dialog open={open} onOpenChange={setOpen}><DialogContent className="clobe-dashboard-sync-dialog"><DialogHeader><DialogTitle>Clobe 최신 동기화 결과</DialogTitle><DialogDescription>최근 2개월 거래와 현재 잔액을 반영하고, 화면 갱신 결과를 확인합니다.</DialogDescription></DialogHeader>{snapshot.result?<ClobeDashboardSyncSummary result={snapshot.result} phase={snapshot.phase} accounts={accounts} businesses={businesses} onRetryRefresh={snapshot.phase==='refresh-needed'?retryRefresh:undefined} onNavigate={()=>setOpen(false)}/>:<p role="status">{clobeDashboardSyncProgress(snapshot)||'아직 실행한 동기화가 없습니다.'}</p>}</DialogContent></Dialog></ClobeDashboardSyncContext.Provider>;
}

export function useClobeDashboardSync(){return useContext(ClobeDashboardSyncContext);}

export function ClobeDashboardSyncButton({disabled=false,compact=false,showStatus=false}:{disabled?:boolean;compact?:boolean;showStatus?:boolean}){
 const sync=useClobeDashboardSync();
 const busy=sync?.busy??false,needsRefresh=sync?.snapshot.phase==='refresh-needed';
 const label=busy?'최신 동기화 중…':needsRefresh?'화면 자료 재조회':'Clobe 최신 동기화';
 const result=sync?.snapshot.result;
 return <div className={`clobe-dashboard-sync-entry ${compact?'is-compact':''}`}>
  <div className="clobe-dashboard-sync-actions"><Button type="button" size={compact?'sm':'default'} disabled={disabled||!sync||busy} onClick={needsRefresh?sync?.retryRefresh:sync?.start} title={needsRefresh?'이미 저장한 자료를 다시 저장하지 않고 화면만 다시 조회합니다.':'전체 사업자의 저장된 통장 연결로 최근 2개월(이번 달·지난달) 거래와 현재 잔액을 함께 반영합니다.'}>{busy?<LoaderCircle size={16} className="animate-spin" aria-hidden="true"/>:<RefreshCw size={16} aria-hidden="true"/>}<span>{label}</span></Button>{result&&<Button type="button" size="xs" variant="ghost" onClick={sync?.showResult} aria-label="Clobe 최신 동기화 결과 보기">결과</Button>}</div>
  {showStatus&&(busy||result)&&<p role="status" aria-live="polite" className={result&&!result.fullSuccess&&!busy?'text-destructive':''}>{busy?clobeDashboardSyncProgress(sync!.snapshot):result&&clobeDashboardSyncResultTitle(result)}</p>}
 </div>;
}
