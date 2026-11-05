"use client";

import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import {ArrowRight,ArrowRightLeft,Check,ExternalLink,Info,Plus,RefreshCw,RotateCcw,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Dialog,DialogClose,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import {buildIntercompanyRegister,intercompanyRegisterSchema,type IntercompanyChange,type IntercompanyEntry,type IntercompanyRegisterData} from '@/lib/finance/intercompany-register';
import {publishDatasetChange,subscribeDatasetChanges} from '@/lib/finance/dataset-change-signal';
import {addDays} from '@/lib/finance/format';
import type {Dataset} from '@/lib/finance/types';
import {IntercompanyPairFlow} from './intercompany-pair-flow';
import './intercompany-register.css';

type CreateChange=Extract<IntercompanyChange,{action:'create'}>;
type RegisterChange=IntercompanyChange|{action:'sync';id:string};
type Draft={id:string;entry_date:string;from_party:string;to_party:string;kind:'loan'|'repayment';amount:string;memo:string};
type RegisterResponse={register:IntercompanyRegisterData;sheetWarning:string};
type SheetSyncSummary={added:number;updated:number;unchanged:number;basisUpdated:number;syncedAt:string};
type SheetSyncResponse=RegisterResponse&{summary:SheetSyncSummary};
type Movement={id:string;entry_date:string;from_party:string;to_party:string;kind:'loan'|'repayment'|'source_unspecified';amount:number;memo:string;entry?:IntercompanyEntry;sourceRow?:number;origin?:'source'|'mirror'};
type ExternalBalance={key:string;name:string;amount:number;direction:'receive'|'pay'};
const digits=(value:number)=>value.toLocaleString('ko-KR');
const monthLabel=(month:string)=>`${month.slice(0,4)}년 ${Number(month.slice(5))}월`;
const pageSize=15;
const sheetLabels={pending:'기록 탭 반영 대기',syncing:'기록 탭 반영 중',synced:'기록 탭 반영 완료',error:'기록 탭 반영 재시도 필요'} as const;

class RegisterError extends Error{
 constructor(message:string,readonly uncertain=false,readonly status=0){super(message);}
}

async function requestRegister(change?:RegisterChange,signal?:AbortSignal):Promise<RegisterResponse>{
 let response:Response;
 try{
  response=await fetch('/api/intercompany-register',change?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(change),cache:'no-store',signal:signal??AbortSignal.timeout(90000)}:{cache:'no-store',signal:signal??AbortSignal.timeout(45000)});
 }catch{throw new RegisterError(change?'저장 응답을 확인하지 못했습니다. 같은 등록으로 결과를 다시 확인해 주세요.':'대여·상환 기록을 불러오지 못했습니다. 다시 조회해 주세요.',!!change);}
 let raw:unknown;
 try{raw=await response.json();}catch{throw new RegisterError(change?'저장 결과를 읽지 못했습니다. 같은 등록으로 결과를 다시 확인해 주세요.':'대여·상환 조회 응답을 확인하지 못했습니다.',!!change,response.status);}
 const result=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
 if(!response.ok){
  if(response.status===401||response.status===403)window.dispatchEvent(new Event('finance-auth-invalid'));
  throw new RegisterError(response.status===401?'로그인이 만료되었습니다. 다시 로그인해 주세요.':response.status===409?'공동 기록이 변경되었거나 같은 등록번호의 내용이 다릅니다. 최신 기록을 확인해 주세요.':typeof result.error==='string'?result.error:'대여·상환 기록을 처리하지 못했습니다.',!!change&&response.status>=500,response.status);
 }
 const parsed=intercompanyRegisterSchema.safeParse(result.register??{baseline:result.baseline,entries:result.entries,...(result.sheet_sync!==undefined?{sheet_sync:result.sheet_sync}:{})});
 if(!parsed.success)throw new RegisterError(change?'저장 응답의 기록을 확인하지 못했습니다. 같은 등록으로 결과를 다시 확인해 주세요.':'대여·상환 기록의 형식을 확인하지 못했습니다.',!!change,response.status);
 if(change){
  const stored=parsed.data.entries.find(entry=>entry.id===change.id);
  if(!stored||change.action==='create'&&(stored.from_party!==change.from_party||stored.to_party!==change.to_party||stored.entry_date!==change.entry_date||stored.kind!==change.kind||stored.amount!==change.amount||stored.memo!==change.memo)||change.action==='set_voided'&&stored.voided!==change.voided)throw new RegisterError('응답에서 해당 등록의 저장 결과를 확인하지 못했습니다. 같은 등록으로 결과를 다시 확인해 주세요.',true,response.status);
 }
 return {register:parsed.data,sheetWarning:typeof result.sheetWarning==='string'?result.sheetWarning:''};
}

async function requestSheetSync():Promise<SheetSyncResponse>{
 const unknownResult='시트 동기화 결과를 확인하지 못했습니다. 다시 누르면 같은 원본 기록으로 결과를 재확인하며 중복 추가하지 않습니다.';
 let response:Response;
 try{response=await fetch('/api/intercompany-sheet-sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({}),cache:'no-store',signal:AbortSignal.timeout(90000)});}
 catch{throw new RegisterError(unknownResult,true);}
 let raw:unknown;
 try{raw=await response.json();}catch{throw new RegisterError(unknownResult,true,response.status);}
 const result=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
 if(!response.ok){
  if(response.status===401||response.status===403)window.dispatchEvent(new Event('finance-auth-invalid'));
  const error=response.status===401?'로그인이 만료되었습니다. 다시 로그인해 주세요.':typeof result.error==='string'?result.error:'원본 시트를 동기화하지 못했습니다.';
  throw new RegisterError(response.status>=500?`${error} ${unknownResult}`:error,response.status>=500,response.status);
 }
 const parsed=intercompanyRegisterSchema.safeParse(result.register);
 const summary=result.summary&&typeof result.summary==='object'?result.summary as Record<string,unknown>:{};
 const validCount=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
 if(!parsed.success||!validCount(summary.added)||!validCount(summary.updated)||!validCount(summary.unchanged)||!validCount(summary.basisUpdated)||typeof summary.syncedAt!=='string'||Number.isNaN(Date.parse(summary.syncedAt)))throw new RegisterError(unknownResult,true,response.status);
 return {register:parsed.data,summary:summary as SheetSyncSummary,sheetWarning:typeof result.sheetWarning==='string'?result.sheetWarning:''};
}

function syncTime(value?:string){
 if(!value||Number.isNaN(Date.parse(value)))return null;
 return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
}

function SheetStatus({entry,baseline}:{entry:IntercompanyEntry;baseline:IntercompanyRegisterData['baseline']}){
 const recordUrl=entry.sheet_status==='synced'&&baseline?sheetRecordUrl(baseline,entry.sheet_row):null;
 return <span className="intercompany-sheet-location"><span className={`intercompany-sheet-status is-${entry.sheet_status}`}>{entry.sheet_status==='synced'&&<Check size={11}/>} {sheetLabels[entry.sheet_status]}</span>{recordUrl&&<a href={recordUrl} target="_blank" rel="noopener noreferrer" className="intercompany-sheet-record-link" title={`‘${baseline?.mirror_sheet_name}’ 탭 ${entry.sheet_row}행에서 이 기록 보기`}>시트에서 보기<ExternalLink size={10}/></a>}</span>;
}

function sheetTabUrl(source:string,gid:string){
 const url=new URL(source);url.searchParams.set('gid',gid);url.hash=`gid=${gid}`;return url.toString();
}

function sheetRecordUrl(baseline:NonNullable<IntercompanyRegisterData['baseline']>,row:number){
 return sheetRangeUrl(baseline.source_url,baseline.mirror_gid,row);
}

function sheetRangeUrl(source:string,gid:string,row:number){
 if(!Number.isInteger(row)||row<2||row>10000||!/^\d+$/.test(gid))return null;
 const url=new URL(source);
 if(url.origin!=='https://docs.google.com'||!/^\/spreadsheets\/d\/[A-Za-z0-9_-]+\/edit\/?$/.test(url.pathname))return null;
 const range=`A${row}:I${row}`;
 url.searchParams.set('gid',gid);url.searchParams.delete('range');url.hash=`gid=${gid}&range=${range}`;
 return url.toString();
}

function sourceMovementUrl(baseline:NonNullable<IntercompanyRegisterData['baseline']>,row:Movement){
 return row.sourceRow===undefined?baseline.source_url:sheetRangeUrl(baseline.source_url,row.origin==='mirror'?baseline.mirror_gid:baseline.gid,row.sourceRow)||baseline.source_url;
}

export function IntercompanyRegisterView({data,biz,month,asOf}:{data:Dataset;biz:string;month:string;asOf:string}){
 const [register,setRegister]=useState<IntercompanyRegisterData|null>(null);
 const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState('');
 const [notice,setNotice]=useState(''),[noticeWarning,setNoticeWarning]=useState(false);
 const [busy,setBusy]=useState(false),[draft,setDraft]=useState<Draft|null>(null),[formError,setFormError]=useState('');
 const [sheetSyncing,setSheetSyncing]=useState(false),[sheetSyncError,setSheetSyncError]=useState('');
 const [uncertain,setUncertain]=useState(false),[confirm,setConfirm]=useState<IntercompanyEntry|null>(null),[confirmError,setConfirmError]=useState('');
 const [allMovements,setAllMovements]=useState(false),[page,setPage]=useState(0);
 const [overview,setOverview]=useState<'flows'|'businesses'>('flows'),[includeBalanced,setIncludeBalanced]=useState(false);
 const mounted=useRef(false),writing=useRef(false),generation=useRef(0),readController=useRef<AbortController|null>(null);
 const attemptedCreate=useRef<CreateChange|null>(null),createTrigger=useRef<HTMLButtonElement|null>(null);
 const cancelRead=useCallback(()=>{generation.current++;readController.current?.abort();},[]);
 const refresh=useCallback(async(showLoading=false)=>{
  if(writing.current)return;
  const current=++generation.current;
  readController.current?.abort();
  const controller=new AbortController();readController.current=controller;
  const timeout=setTimeout(()=>controller.abort(),45000);
  if(showLoading&&mounted.current)setLoading(true);
  try{
   const result=await requestRegister(undefined,controller.signal);
   if(mounted.current&&current===generation.current){setRegister(result.register);setLoadError('');}
  }catch(cause){if(mounted.current&&current===generation.current)setLoadError(cause instanceof Error?cause.message:'기록을 불러오지 못했습니다.');}
  finally{clearTimeout(timeout);if(mounted.current&&current===generation.current)setLoading(false);}
 },[]);
 useEffect(()=>{
  mounted.current=true;
  const reload=()=>{if(document.visibilityState==='visible')void refresh();};
  const unsubscribe=subscribeDatasetChanges(()=>void refresh());
  window.addEventListener('focus',reload);document.addEventListener('visibilitychange',reload);
  return()=>{mounted.current=false;cancelRead();unsubscribe();window.removeEventListener('focus',reload);document.removeEventListener('visibilitychange',reload);};
 },[refresh,cancelRead]);
 useEffect(()=>{let active=true;void Promise.resolve().then(()=>{if(active)void refresh();});return()=>{active=false;};},[data,refresh]);
 useEffect(()=>{
  if(!busy&&!uncertain)return;
  const preventUnload=(event:BeforeUnloadEvent)=>{event.preventDefault();};
  window.addEventListener('beforeunload',preventUnload);
  return()=>window.removeEventListener('beforeunload',preventUnload);
 },[busy,uncertain]);
 const modelState=useMemo(()=>{
  if(!register)return {model:null,error:''};
  try{return {model:buildIntercompanyRegister(register,data.businesses),error:''};}
  catch(cause){return {model:null,error:cause instanceof Error?cause.message:'사업자 연결을 확인해 주세요.'};}
 },[register,data.businesses]);
 const model=modelState.model,baseline=register?.baseline;
 const sourceSyncedAt=register?.sheet_sync?.synced_at;
 const sourceSyncTime=syncTime(sourceSyncedAt);
 const selectedKey=model?.businesses.find(item=>item.party.business_id===biz)?.party.key;
 const inScope=(from:string,to:string)=>biz==='all'||!!selectedKey&&(from===selectedKey||to===selectedKey);
 const summaries=model?.businesses.filter(item=>!!item.party.business_id&&(biz==='all'||item.party.key===selectedKey))??[];
 const externalBalances=new Map(summaries.map(item=>[item.party.key,(model?.pairs??[]).flatMap<ExternalBalance>(pair=>{
  if(pair.amount<=0)return [];
  if(pair.creditor?.key===item.party.key&&pair.debtor&&!pair.debtor.business_id)return [{key:pair.key,name:pair.debtor.name,amount:pair.amount,direction:'receive'}];
  if(pair.debtor?.key===item.party.key&&pair.creditor&&!pair.creditor.business_id)return [{key:pair.key,name:pair.creditor.name,amount:pair.amount,direction:'pay'}];
  return [];
 })]));
 const pairs=model?.pairs.filter(pair=>inScope(pair.businessA.key,pair.businessB.key))??[];
 const visiblePairs=includeBalanced?pairs:pairs.filter(pair=>pair.amount>0);
 const parties=model?.businesses.map(item=>item.party)??[];
 const partyName=(key:string)=>parties.find(party=>party.key===key)?.name||'사업자 확인 필요';
 const minDate=baseline?addDays(baseline.as_of,1):asOf;
 const canCreate=!!baseline&&!!model&&!loadError&&!modelState.error&&minDate<=asOf;
 const sourceAdditions=model?.sourceAdditions??[];
 const movements:Movement[]=[...sourceAdditions.map(item=>({id:`source:${item.id}`,entry_date:item.date,from_party:item.from_business,to_party:item.to_business,kind:item.kind,amount:item.amount,memo:item.memo,sourceRow:item.source_row,origin:item.origin})),...(model?.entries??[]).map(entry=>({id:entry.id,entry_date:entry.entry_date,from_party:entry.from_party,to_party:entry.to_party,kind:entry.kind,amount:entry.amount,memo:entry.memo,entry}))]
  .filter(row=>inScope(row.from_party,row.to_party)&&(allMovements||row.entry_date.startsWith(month)))
  .sort((a,b)=>b.entry_date.localeCompare(a.entry_date)||b.id.localeCompare(a.id));
 const pages=Math.max(1,Math.ceil(movements.length/pageSize)),currentPage=Math.min(page,pages-1);
 const visibleMovements=movements.slice(currentPage*pageSize,(currentPage+1)*pageSize);
 const selectedPending=(model?.entries??[]).filter(entry=>entry.sheet_status!=='synced'&&inScope(entry.from_party,entry.to_party));
 const safeAmount=draft&&/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(draft.amount)?Number(draft.amount.replaceAll(',','')):0;
 const validDraft=!!draft&&!!baseline&&draft.entry_date>=minDate&&draft.entry_date<=asOf&&!!draft.from_party&&!!draft.to_party&&draft.from_party!==draft.to_party&&Number.isSafeInteger(safeAmount)&&safeAmount>0&&draft.memo.length<=2000;

 const mutate=async(change:RegisterChange)=>{
  if(writing.current)throw new RegisterError('이전 변경을 저장하고 있습니다.');
  writing.current=true;generation.current++;readController.current?.abort();setBusy(true);setLoading(false);
  try{
   const result=await requestRegister(change);
   if(mounted.current){
    setRegister(result.register);setLoadError('');
    const entry=result.register.entries.find(item=>item.id===change.id);
    const synced=entry?.sheet_status==='synced';
    const destination=`‘${result.register.baseline?.mirror_sheet_name||'등록 기록'}’ 기록 탭`;
    setNoticeWarning(!synced||!!result.sheetWarning);
    const savedMessage=!synced?`대시보드에는 저장했습니다. 같은 Google 파일의 ${destination} 반영은 대기 중입니다. 기록 상태에서 재시도할 수 있습니다.`:change.action==='create'?`대여·상환 내역을 대시보드와 같은 Google 파일의 ${destination}에 저장했습니다.`:change.action==='sync'?`같은 Google 파일의 ${destination} 반영을 확인했습니다.`:change.voided?`등록을 취소하고 합계를 다시 계산했습니다. ${destination}에도 취소 상태를 반영했습니다.`:`등록을 복원하고 합계를 다시 계산했습니다. ${destination}에도 복원 상태를 반영했습니다.`;
    setNotice([savedMessage,result.sheetWarning].filter(Boolean).join(' '));
   }
   publishDatasetChange();
   return result;
  }finally{writing.current=false;if(mounted.current)setBusy(false);}
 };
 const startCreate=()=>{
  if(!canCreate||busy)return;
  attemptedCreate.current=null;setUncertain(false);setFormError('');
  setDraft({id:crypto.randomUUID(),entry_date:asOf,from_party:selectedKey??parties[0]?.key??'',to_party:'',kind:'loan',amount:'',memo:''});
 };
 const changeDraft=(patch:Partial<Draft>)=>{if(!busy&&!uncertain){setDraft(previous=>previous?{...previous,...patch}:previous);setFormError('');}};
 const saveCreate=async(event:FormEvent)=>{
  event.preventDefault();if(busy||!draft||(!uncertain&&!validDraft))return;
  const change=attemptedCreate.current??{action:'create',id:draft.id,from_party:draft.from_party,to_party:draft.to_party,entry_date:draft.entry_date,kind:draft.kind,amount:safeAmount,memo:draft.memo.trim()};
  attemptedCreate.current=change;
  setFormError('');
  try{await mutate(change);if(mounted.current){attemptedCreate.current=null;setUncertain(false);setDraft(null);}}
  catch(cause){
   if(!mounted.current)return;
   const unknown=uncertain||cause instanceof RegisterError&&cause.uncertain;
   setUncertain(unknown);if(!unknown)attemptedCreate.current=null;
   setFormError(cause instanceof Error?cause.message:'저장하지 못했습니다. 입력값은 유지했습니다.');
  }
 };
 const saveVoid=async()=>{
  if(!confirm||busy)return;setConfirmError('');
  try{await mutate({action:'set_voided',id:confirm.id,version:confirm.version,voided:!confirm.voided});if(mounted.current)setConfirm(null);}
  catch(cause){if(mounted.current)setConfirmError(cause instanceof Error?cause.message:'변경하지 못했습니다.');}
 };
 const syncEntry=async(entry:IntercompanyEntry)=>{
  if(busy)return;
  try{await mutate({action:'sync',id:entry.id});}
  catch(cause){if(mounted.current){setNoticeWarning(true);setNotice(cause instanceof Error?cause.message:'시트 기록 상태를 갱신하지 못했습니다.');}}
 };
 const syncSheet=async()=>{
  if(writing.current||draft||confirm||uncertain||!baseline)return;
  writing.current=true;generation.current++;readController.current?.abort();setBusy(true);setSheetSyncing(true);setLoading(false);setSheetSyncError('');setNotice('');
  try{
   const result=await requestSheetSync();
   if(mounted.current){
    const {added,updated,unchanged,basisUpdated}=result.summary;
    const noChanges=added===0&&updated===0&&basisUpdated===0;
    setRegister(result.register);setLoadError('');setPage(0);setNoticeWarning(!!result.sheetWarning);
    const message=noChanges?`시트 동기화 완료 · 추가·수정된 내역이 없습니다. 기존 기록 ${digits(unchanged)}건을 확인했습니다.`:`시트 동기화 완료 · 신규 ${digits(added)}건 · 수정 ${digits(updated)}건 · 변경 없음 ${digits(unchanged)}건${basisUpdated?` · 기준표 갱신 ${digits(basisUpdated)}건`:''}`;
    setNotice([message,result.sheetWarning].filter(Boolean).join(' '));
   }
   publishDatasetChange();
  }catch(cause){if(mounted.current)setSheetSyncError(cause instanceof Error?cause.message:'시트 동기화에 실패했습니다. 기존 표시 자료는 유지했습니다.');}
  finally{writing.current=false;if(mounted.current){setBusy(false);setSheetSyncing(false);}}
 };

 return <section className="intercompany-register panel" aria-labelledby="intercompany-register-title">
  <header className="intercompany-header"><div><span className="intercompany-eyebrow"><ArrowRightLeft size={14}/> 공동 대여금 관리</span><h2 id="intercompany-register-title">사업자간 대여·상환</h2><p>누적 기록 {baseline?.coverage_start||'시작일 미확인'} ~ {model?.asOf||'기준일 미확인'}<span> · 월 선택은 하단 개별 기재 내역에만 적용됩니다.</span></p><small className="intercompany-source-sync-time">원본 시트 반영 {sourceSyncTime?<time dateTime={sourceSyncedAt}>{sourceSyncTime} (서울)</time>:'동기화 전'}</small></div><div className="intercompany-actions">{baseline&&<><a href={baseline.source_url} target="_blank" rel="noopener noreferrer" className="intercompany-source-link">원본 요약<ExternalLink size={12}/></a><a href={sheetTabUrl(baseline.source_url,baseline.mirror_gid)} target="_blank" rel="noopener noreferrer" className="intercompany-source-link" title={baseline.mirror_sheet_name}>등록 기록 탭<ExternalLink size={12}/></a></>}<Button size="sm" variant="outline" disabled={loading||busy} onClick={()=>void refresh(true)} aria-label="대여·상환 기록 새로고침" title="대시보드에 저장된 기록만 다시 조회합니다. 원본 시트의 추가·수정 반영은 ‘시트 동기화’를 사용하세요."><RefreshCw size={14} className={loading?'intercompany-spin':''}/><span>새로고침</span></Button><Button size="sm" className="intercompany-sheet-sync-button" disabled={!baseline||loading||busy||!!draft||!!confirm||uncertain} aria-label="시트 동기화" aria-busy={sheetSyncing} onClick={()=>void syncSheet()} title="원본 시트의 추가·수정 내역을 대조해 반영합니다. 같은 원본 기록은 중복으로 추가하지 않습니다."><RefreshCw size={14} className={sheetSyncing?'intercompany-spin':''}/>{sheetSyncing?'시트 동기화 중…':'시트 동기화'}</Button><Button ref={createTrigger} size="sm" variant="outline" disabled={!canCreate||busy} onClick={startCreate}><Plus size={14}/>대여·상환 등록</Button></div></header>
  <div className="intercompany-basis"><Info size={15}/><p><strong>두 사업자가 주고받은 누계의 차이입니다.</strong><span>기초잔액 미확인 · 실제 채무 확정액이나 다자간 상계 결과가 아닙니다. 통장 잔액·거래내역은 변경하지 않습니다.</span></p></div>
  {(loadError||modelState.error)&&<div className="intercompany-message is-error" role="alert">{loadError||modelState.error} 기존 표시값은 최신 상태가 아닐 수 있습니다. <Button size="sm" variant="outline" disabled={loading||busy} onClick={()=>void refresh(true)}>다시 조회</Button></div>}
  {sheetSyncError&&<div className="intercompany-message is-error" role="alert"><span>{sheetSyncError} 기존 표시 자료는 유지했습니다.</span><Button size="sm" variant="outline" disabled={loading||busy||!!draft||!!confirm||uncertain} onClick={()=>void syncSheet()}>시트 동기화 재시도</Button></div>}
  {notice&&<div className={`intercompany-message ${noticeWarning?'is-warning':'is-success'}`} role="status"><span>{notice}</span><button type="button" aria-label="대여금 알림 닫기" onClick={()=>setNotice('')}><X size={14}/></button></div>}
  {loading&&!register?<p className="intercompany-empty" role="status">대여·상환 공동 기록을 불러오고 있습니다.</p>:!baseline?<p className="intercompany-empty">원본 시트 기준 자료를 연결한 뒤 대여·상환을 등록할 수 있습니다.</p>:<>
   <div className="intercompany-overview-bar"><div className="intercompany-overview-buttons" role="group" aria-label="대여·상환 현황 보기"><button type="button" aria-pressed={overview==='flows'} onClick={()=>setOverview('flows')}>주고받은 금액</button><button type="button" aria-pressed={overview==='businesses'} onClick={()=>setOverview('businesses')}>사업자별 요약</button></div>{overview==='flows'&&<div className="intercompany-flow-filter"><span>{visiblePairs.length}쌍 표시</span><button type="button" aria-pressed={includeBalanced} onClick={()=>setIncludeBalanced(value=>!value)}><Check size={12} aria-hidden="true"/>차액 0 포함</button></div>}</div>
   {overview==='flows'?<>{visiblePairs.length?<div className="intercompany-flow-grid">{visiblePairs.map(pair=><IntercompanyPairFlow key={pair.key} pair={pair} sourceAdditions={sourceAdditions}/>)}</div>:<p className="intercompany-empty">{pairs.length?'기록상 차액이 있는 사업자 쌍이 없습니다. ‘차액 0 포함’을 누르면 주고받은 누계를 확인할 수 있습니다.':'선택한 사업자에 연결된 자금이동 기록이 없습니다.'}</p>}</>:<>{summaries.length?<div className="intercompany-summary">{summaries.map(item=><article key={item.party.key}><h3><i style={{background:data.businesses.find(b=>b.id===item.party.business_id)?.color||'#8794ac'}}/>{item.party.name}</h3><dl><div><dt>받을 순증감</dt><dd className="intercompany-receive">{digits(item.receivable)}<small>원</small></dd></div><div><dt>보낼 순증감</dt><dd className="intercompany-pay">{digits(item.payable)}<small>원</small></dd></div></dl><p>각 상대 사업자와 주고받은 차이 기준</p>{!!externalBalances.get(item.party.key)?.length&&<ul className="intercompany-external-balances">{externalBalances.get(item.party.key)!.map(balance=><li key={balance.key}><span>{balance.name}{balance.direction==='receive'?'에서 받을 금액':'에 보낼 금액'}</span><strong className={balance.direction==='receive'?'intercompany-receive':'intercompany-pay'}>{digits(balance.amount)}원</strong></li>)}</ul>}</article>)}</div>:<p className="intercompany-empty">선택한 사업자에 연결된 대여·상환 기록이 없습니다.</p>}</>}
   <p className="intercompany-pair-note">보낸 누계에는 대여와 상환이 함께 포함됩니다. 개별 원본 기재는 이미 누계에 포함되며 다시 더하지 않습니다. 원본 추가·수정은 ‘시트 동기화’, 저장 자료 재조회는 ‘새로고침’을 사용하세요.</p>
   {selectedPending.length>0&&<div className="intercompany-pending"><div><Info size={15}/><strong>기록 탭 반영 확인 {selectedPending.length}건</strong><span>대시보드 합계에는 이미 반영했습니다. 시트 재시도는 같은 등록을 갱신합니다.</span></div><ul>{selectedPending.map(entry=><li key={entry.id}><span>{entry.entry_date} · {partyName(entry.from_party)} → {partyName(entry.to_party)} · {digits(entry.amount)}원{entry.voided?' · 취소됨':''}</span><SheetStatus entry={entry} baseline={baseline}/><Button size="sm" variant="outline" disabled={busy||entry.sheet_status==='syncing'} onClick={()=>void syncEntry(entry)}>시트 기록 재시도</Button></li>)}</ul></div>}
   <div className="intercompany-movements-header"><div><h3>개별 기재 내역</h3><p>{allMovements?'원본 추가 기록과 대시보드 등록 전체':`${monthLabel(month)} 원본 추가 기록과 대시보드 등록`} · {movements.length}건 · 누계 전체의 통장 거래내역은 아닙니다.</p></div><div className="intercompany-movement-scope" aria-label="대여·상환 내역 기간"><button type="button" aria-pressed={!allMovements} onClick={()=>{setAllMovements(false);setPage(0);}}>조회 월</button><button type="button" aria-pressed={allMovements} onClick={()=>{setAllMovements(true);setPage(0);}}>전체 기록</button></div></div>
   {visibleMovements.length?<><div className="intercompany-movements">{visibleMovements.map(row=><article key={row.id} className={row.entry?.voided?'is-voided':''}><div className="intercompany-movement-date"><time dateTime={row.entry_date}>{row.entry_date}</time><span className={`intercompany-kind is-${row.entry?row.kind:'source_unspecified'}`}>{row.entry?row.kind==='loan'?'등록 · 대여금 지급':'등록 · 대여금 상환':'원본 기재 자금이동'}</span></div><div className="intercompany-movement-parties"><strong>{partyName(row.from_party)}<ArrowRight size={13}/>{partyName(row.to_party)}</strong>{row.memo&&<p>{row.memo}</p>}<small>{row.entry?row.entry.voided?'등록 취소 · 합계 제외':'대시보드 추가 등록':'시트 원본 · 읽기 전용 · 누계에 반영된 기록'}</small></div><div className="intercompany-movement-amount"><strong>{digits(row.amount)}<small>원</small></strong>{row.entry?<SheetStatus entry={row.entry} baseline={baseline}/>:<a href={sourceMovementUrl(baseline,row)} target="_blank" rel="noopener noreferrer" className="intercompany-sheet-record-link">시트 원본 보기<ExternalLink size={10}/></a>}</div>{row.entry&&<Button size="sm" variant="ghost" disabled={busy||!!loadError} onClick={()=>{setConfirm(row.entry!);setConfirmError('');}}>{row.entry.voided?<><RotateCcw size={12}/>복원</>:'등록 취소'}</Button>}</article>)}</div><div className="intercompany-pagination"><span>{currentPage+1} / {pages}</span>{pages>1&&<div><Button size="sm" variant="outline" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>이전</Button><Button size="sm" variant="outline" disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>다음</Button></div>}</div></>:<p className="intercompany-empty">이 기간에 개별 기재된 이동 내역이 없습니다. 전체 누계는 위 현황에 유지됩니다.</p>}
   <div className="intercompany-footer-note"><span>원본 집계 기준일 {baseline.as_of} · 새 등록 가능일 {minDate} ~ {asOf}</span><p>{minDate>asOf?'원본 집계에 포함된 날짜는 중복 방지를 위해 다시 등록할 수 없습니다.':'원본 기준일 이후 실제 이동만 등록합니다. 잘못 등록한 내역은 취소하고 새로 등록할 수 있습니다.'}</p><p>새 등록은 같은 Google 파일의 <a href={sheetTabUrl(baseline.source_url,baseline.mirror_gid)} target="_blank" rel="noopener noreferrer">{baseline.mirror_sheet_name}<ExternalLink size={10}/></a> 탭에도 기록됩니다.</p>{baseline.notes.length>0&&<details><summary>집계 기준 자세히 보기</summary><ul>{baseline.notes.map(note=><li key={note}>{note}</li>)}</ul></details>}</div>
  </>}
  <Dialog open={draft!==null} onOpenChange={open=>{if(!open&&!busy&&!uncertain){setDraft(null);attemptedCreate.current=null;}}}><DialogContent className="intercompany-dialog" showCloseButton={false} onCloseAutoFocus={event=>{event.preventDefault();createTrigger.current?.focus({preventScroll:true});}} onEscapeKeyDown={event=>{if(busy||uncertain)event.preventDefault();}} onPointerDownOutside={event=>{if(busy||uncertain)event.preventDefault();}}><DialogHeader><div className="intercompany-dialog-heading"><DialogTitle>대여·상환 등록</DialogTitle><DialogClose asChild><Button size="icon" variant="ghost" disabled={busy||uncertain} aria-label="대여·상환 등록 닫기"><X size={18}/></Button></DialogClose></div><DialogDescription>실제로 보낸 사업자와 받은 사업자를 선택하세요. 대시보드에 저장하고, 같은 Google 파일 안의 ‘{baseline?.mirror_sheet_name}’ 별도 기록 탭에 반영합니다.</DialogDescription></DialogHeader>
   {draft&&<form onSubmit={event=>void saveCreate(event)} className="intercompany-form">
    {formError&&<div className="intercompany-message is-error" role="alert">{formError}</div>}
    {uncertain&&<p className="intercompany-uncertain">중복 등록을 막기 위해 입력을 잠갔습니다. 아래 <strong>같은 등록으로 결과 확인</strong>을 누르면 같은 등록번호와 내용으로 저장 여부를 확인합니다.</p>}
    <fieldset disabled={busy||uncertain}><div className="intercompany-form-fields"><label>실제 자금 이동일<Input type="date" min={minDate} max={asOf} required value={draft.entry_date} onChange={event=>changeDraft({entry_date:event.target.value})}/><small>{minDate} ~ {asOf}</small></label><label>이동 구분<select value={draft.kind} onChange={event=>changeDraft({kind:event.target.value as Draft['kind']})}><option value="loan">대여금 지급</option><option value="repayment">대여금 상환</option></select><small>{draft.kind==='repayment'?'돈을 갚는 사업자 → 돌려받는 사업자':'돈을 빌려주는 사업자 → 빌리는 사업자'}</small></label><label>보낸 사업자<select required value={draft.from_party} onChange={event=>changeDraft({from_party:event.target.value,to_party:draft.to_party===event.target.value?'':draft.to_party})}><option value="">보낸 사업자 선택</option>{parties.map(party=><option key={party.key} value={party.key}>{party.name}</option>)}</select></label><label>받은 사업자<select required value={draft.to_party} onChange={event=>changeDraft({to_party:event.target.value})}><option value="">받은 사업자 선택</option>{parties.filter(party=>party.key!==draft.from_party).map(party=><option key={party.key} value={party.key}>{party.name}</option>)}</select></label><label className="intercompany-form-full">이동 금액 (원)<Input inputMode="numeric" placeholder="예: 15,000,000" autoComplete="off" required value={draft.amount} onChange={event=>changeDraft({amount:event.target.value})}/>{draft.amount&&!Number.isSafeInteger(safeAmount)||draft.amount&&safeAmount<=0?<small className="intercompany-invalid">1원 이상 정수 금액을 숫자로 입력하세요.</small>:null}</label><label className="intercompany-form-full">메모<Textarea rows={3} maxLength={2000} placeholder="자금 이동 사유나 확인 내용을 적어주세요." value={draft.memo} onChange={event=>changeDraft({memo:event.target.value})}/></label></div></fieldset>
    {validDraft&&<div className="intercompany-create-preview"><span>{draft.entry_date} · {draft.kind==='loan'?'대여금 지급':'대여금 상환'}</span><strong>{partyName(draft.from_party)}<ArrowRight size={14}/>{partyName(draft.to_party)}</strong><b>{digits(safeAmount)}원</b></div>}
    <p className="intercompany-save-note">시트 저장 위치: 같은 Google 파일의 ‘{baseline?.mirror_sheet_name}’ 별도 기록 탭. 반영 완료 후 각 등록의 ‘시트에서 보기’를 누르면 해당 행을 바로 열 수 있습니다. 기록 탭 반영이 지연되면 대기 상태와 재시도 버튼을 표시합니다. 통장 거래·계좌 잔액은 변경하지 않습니다.</p>
    <div className="intercompany-form-actions"><Button type="button" variant="outline" disabled={busy||uncertain} onClick={()=>{setDraft(null);attemptedCreate.current=null;}}>닫기</Button><Button type="submit" disabled={busy||!uncertain&&!validDraft}>{busy?<><RefreshCw size={14} className="intercompany-spin"/>저장 중…</>:uncertain?'같은 등록으로 결과 확인':'대시보드·시트에 저장'}</Button></div>
   </form>}
  </DialogContent></Dialog>
  <Dialog open={confirm!==null} onOpenChange={open=>{if(!open&&!busy)setConfirm(null);}}><DialogContent className="intercompany-confirm-dialog" showCloseButton={!busy}><DialogHeader><DialogTitle>{confirm?.voided?'취소한 등록을 복원할까요?':'이 등록을 취소할까요?'}</DialogTitle><DialogDescription>{confirm?.voided?'대여·상환 합계에 다시 포함하고 원본 시트의 등록 상태도 갱신합니다.':'대여·상환 합계에서 제외하고 원본 시트에도 취소 상태를 기록합니다. 기록 자체는 삭제하지 않습니다.'}</DialogDescription></DialogHeader>{confirm&&<div className="intercompany-confirm-detail"><time dateTime={confirm.entry_date}>{confirm.entry_date}</time><p>{partyName(confirm.from_party)} → {partyName(confirm.to_party)}</p><strong>{digits(confirm.amount)}원 · {confirm.kind==='loan'?'대여금 지급':'대여금 상환'}</strong>{confirm.memo&&<small>{confirm.memo}</small>}</div>}{confirmError&&<div className="intercompany-message is-error" role="alert">{confirmError}<Button size="sm" variant="outline" disabled={busy} onClick={()=>{setConfirm(null);void refresh(true);}}>최신 기록 조회</Button></div>}<div className="intercompany-form-actions"><Button variant="outline" disabled={busy} onClick={()=>setConfirm(null)}>닫기</Button><Button disabled={busy||!!confirmError} onClick={()=>void saveVoid()}>{busy?'저장 중…':confirm?.voided?'등록 복원':'등록 취소 확인'}</Button></div></DialogContent></Dialog>
 </section>;
}
