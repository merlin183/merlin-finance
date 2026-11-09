"use client";
import {FinancialText} from './financial-visibility';


import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,CheckCircle2,LoaderCircle,RefreshCw,TriangleAlert} from 'lucide-react';
import {Button} from '@/components/ui/button';
import './sheet-sync-status.css';

type SyncCounts=Record<string,unknown>;
type SyncSource={id:string;source_url:string;enabled:boolean;last_run_at:string|null;last_result:SyncCounts|null;last_error:string|null;mappings:unknown[]};
type SyncStatus={sources:SyncSource[];configured:boolean};

const countLabels=[['inserted','새로 추가'],['updated','업데이트'],['removed','중복 정리'],['unchanged','변경 없음'],['blocked','확인 필요 · 보류']] as const;

function sheetLink(value:string){
 try{
  const url=new URL(value);
  return url.protocol==='https:'&&url.hostname==='docs.google.com'&&!url.username&&!url.password&&/^\/spreadsheets\/d\/[\w-]+(?:\/|$)/.test(url.pathname)?url.href:null;
 }catch{return null;}
}

function errorMessage(value:unknown,fallback:string){
 if(typeof value!=='string'||!value.trim())return fallback;
 if(/(?:bearer\s|(?:access[_ -]?token|refresh[_ -]?token|secret|password|authorization|private[_ -]?key)\s*[:=]|eyJ[\w-]+\.[\w-]+\.[\w-]+|-----BEGIN)/i.test(value))return fallback;
 return value.slice(0,300);
}

async function request<T>(options?:RequestInit):Promise<T>{
 let response:Response;
 try{response=await fetch('/api/sheet-sync',{cache:'no-store',credentials:'same-origin',...options});}
 catch(cause){if(cause instanceof DOMException&&cause.name==='AbortError')throw cause;throw Error('연결을 확인하지 못했습니다. 네트워크 상태를 확인하고 다시 시도해주세요.');}
 const value=await response.json().catch(()=>null) as (T&{error?:unknown})|null;
 if(!response.ok){
  if(response.status===401)throw Error('로그인 시간이 만료되었습니다. Google 계정으로 다시 로그인해주세요.');
  if(response.status===403)throw Error('관리자 권한이 있는 계정으로 로그인해주세요.');
  throw Error(errorMessage(value?.error,'동기화 상태를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.'));
 }
 if(!value)throw Error('서버 응답을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.');
 return value;
}

function ResultCounts({value}:{value:SyncCounts}){
 return <dl className="sheet-sync-counts">{countLabels.map(([key,label])=>{
  const count=value[key];
  const valid=typeof count==='number'&&Number.isSafeInteger(count)&&count>=0;
  return <div key={key}><dt>{label}</dt><dd className={key==='blocked'&&valid&&count>0?'negative':undefined}>{valid?count.toLocaleString('ko-KR'):'—'}{valid&&<small>건</small>}</dd></div>;
 })}</dl>;
}

export function SheetSyncStatus({onRefresh,disabled=false}:{onRefresh:()=>Promise<void>;disabled?:boolean}){
 const [status,setStatus]=useState<SyncStatus|null>(null);
 const [loading,setLoading]=useState(true);
 const [running,setRunning]=useState(false);
 const [error,setError]=useState('');
 const [result,setResult]=useState<SyncCounts|null>(null);
 const [notice,setNotice]=useState('');
 const mounted=useRef(false);
 const inFlight=useRef(false);

 const loadStatus=useCallback(async(signal?:AbortSignal)=>{
  const next=await request<SyncStatus>({signal});
  if(!Array.isArray(next.sources)||typeof next.configured!=='boolean')throw Error('자동 연동 설정을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.');
  if(mounted.current&&!signal?.aborted)setStatus(next);
 },[]);

 useEffect(()=>{
  mounted.current=true;
  const controller=new AbortController();
  void loadStatus(controller.signal).catch(cause=>{
   if(mounted.current&&!controller.signal.aborted)setError(cause instanceof Error?cause.message:'자동 연동 상태를 확인하지 못했습니다.');
  }).finally(()=>{if(mounted.current&&!controller.signal.aborted)setLoading(false);});
  return()=>{mounted.current=false;controller.abort();};
 },[loadStatus]);

 async function refreshStatus(){
  if(inFlight.current||disabled)return;
  inFlight.current=true;setLoading(true);setError('');
  try{await loadStatus();}
  catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'자동 연동 상태를 확인하지 못했습니다.');}
  finally{inFlight.current=false;if(mounted.current)setLoading(false);}
 }

 async function runSync(){
  if(inFlight.current||disabled||loading||!status?.configured||!status.sources.some(source=>source.enabled))return;
  inFlight.current=true;setRunning(true);setError('');setResult(null);setNotice('');
  try{
   const value=await request<{result:SyncCounts}>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'run'})});
   if(!mounted.current)return;
   setResult(value.result);
   const results=await Promise.allSettled([loadStatus(),onRefresh()]);
   if(!mounted.current)return;
   if(results[0].status==='rejected')setError('동기화는 완료됐지만 마지막 실행 상태를 읽지 못했습니다. 상태 새로고침을 눌러주세요.');
   if(results[1].status==='rejected')setNotice('동기화는 완료됐습니다. 페이지를 새로고침하면 최신 거래를 확인할 수 있습니다.');
  }catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'동기화 결과를 확인하지 못했습니다. 상태를 새로고침한 뒤 다시 확인해주세요.');}
  finally{inFlight.current=false;if(mounted.current)setRunning(false);}
 }

 const busy=disabled||loading||running;
 const enabled=!!status?.configured&&status.sources.some(source=>source.enabled);
 return <section className="sheet-sync" aria-label="계정관리봇 자동 연동" aria-busy={loading||running}>
  <div className="sheet-sync-heading"><div><h3>계정관리봇 자동 연동</h3><p>슬랙에 올린 엑셀을 봇이 계정과목별로 정리하면, Google 스프레드시트의 거래를 멀린 대시보드에 반영합니다.</p></div><div className="sheet-sync-actions"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>void refreshStatus()}><RefreshCw size={15} className={loading?'animate-spin':undefined}/>상태 새로고침</Button><Button type="button" size="sm" disabled={busy||!enabled} onClick={()=>void runSync()}>{running?<LoaderCircle size={15} className="animate-spin"/>:<RefreshCw size={15}/>} {running?'동기화 중…':'지금 동기화'}</Button></div></div>
  <p className="sheet-sync-cadence">{enabled?'5분마다 시트의 변경 사항을 자동으로 확인합니다. 화면을 닫아도 연동은 계속됩니다. 같은 거래는 반복해서 추가하지 않으며, 구분이 어려운 거래는 보류합니다.':loading?'자동 연동 상태를 불러오는 중입니다.':!status?.configured?'자동 연동 설정을 확인하고 있습니다.':'자동 연동이 꺼져 있습니다.'}</p>
  {error&&<div className="gs-warning" role="alert"><TriangleAlert size={17}/><span><FinancialText value={String((error)||'')}/></span></div>}
  {!!status?.sources.length&&<ul className="sheet-sync-sources">{status.sources.map(source=>{
   const link=sheetLink(source.source_url);
   const date=source.last_run_at?new Date(source.last_run_at):null;
   const timestamp=date&&!Number.isNaN(date.getTime())?date.toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):null;
   return <li key={source.id}><div className="sheet-sync-source-heading"><strong>연결된 스프레드시트</strong><span className={source.enabled&&status.configured?'positive':'muted'}><FinancialText value={String(source.enabled?(status.configured?'자동 연동 켜짐':'설정 확인 필요'):'자동 연동 꺼짐')}/></span></div>{link?<a className="sheet-sync-link" href={link} target="_blank" rel="noopener noreferrer" aria-label="자동 연동 원본 스프레드시트 열기">{link}<ArrowUpRight size={14}/></a>:<p className="sheet-sync-cadence">원본 스프레드시트 링크를 확인해주세요.</p>}<p className="sheet-sync-timestamp">마지막 실행: {timestamp?`${timestamp} (한국 시간)`:'아직 실행 기록이 없습니다.'}</p>{source.last_result&&<ResultCounts value={source.last_result}/>} {source.last_error&&<div className="gs-warning" role="alert"><TriangleAlert size={17}/><span>마지막 실행 오류: <FinancialText value={String((errorMessage(source.last_error,'동기화를 완료하지 못했습니다. 시트 접근 권한과 연동 설정을 확인해주세요.'))||'')}/></span></div>}</li>;
  })}</ul>}
  {result&&<div className="sheet-sync-complete" role="status"><p><CheckCircle2 size={17}/>동기화가 완료되었습니다.</p><ResultCounts value={result}/></div>}
  {notice&&<p className="sheet-sync-cadence" role="status"><FinancialText value={String((notice)||'')}/></p>}
 </section>;
}
