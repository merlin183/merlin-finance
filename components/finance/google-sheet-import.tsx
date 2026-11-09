"use client";
import {FinancialText,useFinancialVisibility,FinancialValue} from './financial-visibility';


import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowRight,CheckCircle2,ChevronDown,Download,FileSpreadsheet,History,Link2,LoaderCircle,RefreshCw,TriangleAlert} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Checkbox} from '@/components/ui/checkbox';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {Panel,Picker} from './common';
import type {Dataset} from '@/lib/finance/types';
import {settleDatasetMutation} from '@/lib/finance/dataset-refresh';
import './google-sheet-import.css';

type SheetMapping={sheet:string;account_id:string|null;selected:boolean};
type ImportSummary={inserted:number;updated:number;removed:number;unchanged:number;sourceDuplicates:number;blocked:number};
type CategoryStatus='mapped'|'unregistered'|'needs_review'|'blank';
type CategoryIssue={rawName:string;count:number;status:'unregistered'|'needs_review'};
type SheetPreview={name:string;account_id:string|null;selected:boolean;count:number;from?:string;to?:string;income:number;expense:number;errors:{row:number;message:string}[];categoryIssues?:CategoryIssue[];sample:{txn_date:string;description:string;amount:number;direction:'in'|'out';category_name:string;raw_category?:string;category_status?:CategoryStatus;balance:number|null}[]};
type ImportPreview={sourceUrl:string;sourceHash:string;planHash:string;sheets:SheetPreview[];summary:ImportSummary;conflicts:{sheet:string;row:number;message:string}[]};
type ImportResult=ImportSummary&{run_id:string};
type ImportHistory={id:string;source_url:string;created_at:string;result:{inserted:number;updated:number;removed:number}};
type ImportSettings={history:ImportHistory[];defaultSourceUrl:string|null;syncAvailable:boolean;syncUnavailableReason:string|null};
type SyncResult=ImportResult&{sourceUrl?:string;sheets?:SheetPreview[];conflicts?:ImportPreview['conflicts']};

const money=(value:number)=>value.toLocaleString('ko-KR')+'원';
const count=(value:number)=>value.toLocaleString('ko-KR')+'건';
function safeSheetUrl(value:string){
 try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='docs.google.com'&&!url.username&&!url.password&&/^\/spreadsheets\/d\/[^/]+/.test(url.pathname)?url.href:null;}catch{return null;}
}
async function request<T>(body?:unknown):Promise<T>{
 const response=await fetch('/api/sheet-import',body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});
 let result:T&{error?:string};
 try{result=await response.json() as T&{error?:string};}catch{throw Error('응답을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.');}
 if(!response.ok)throw Error(response.status===401?'로그인 시간이 만료되었습니다. Google 계정으로 다시 로그인해주세요.':result.error||'시트 데이터를 가져오지 못했습니다. 링크의 공유 설정을 확인해주세요.');
 return result;
}

export function GoogleSheetImport({data,refresh}:{data:Dataset;refresh:()=>Promise<void>}){
 const {privateText,amountsVisible}=useFinancialVisibility();
 const [url,setUrl]=useState('');
 const [linkOptionsOpen,setLinkOptionsOpen]=useState(false);
 const [preview,setPreview]=useState<ImportPreview|null>(null);
 const [mappings,setMappings]=useState<SheetMapping[]>([]);
 const [allowPartial,setAllowPartial]=useState(false);
 const [stale,setStale]=useState(false);
 const [loading,setLoading]=useState(false);
 const [saving,setSaving]=useState(false);
 const [syncing,setSyncing]=useState(false);
 const [syncSettings,setSyncSettings]=useState<Pick<ImportSettings,'defaultSourceUrl'|'syncAvailable'|'syncUnavailableReason'>|null>(null);
 const [syncResult,setSyncResult]=useState<SyncResult|null>(null);
 const [syncError,setSyncError]=useState('');
 const [syncRefreshFailed,setSyncRefreshFailed]=useState(false);
 const [importRefreshFailed,setImportRefreshFailed]=useState(false);
 const [refreshingData,setRefreshingData]=useState(false);
 const [syncIssueLimit,setSyncIssueLimit]=useState(40);
 const [result,setResult]=useState<ImportResult|null>(null);
 const [error,setError]=useState('');
 const [history,setHistory]=useState<ImportHistory[]>([]);
 const [historyError,setHistoryError]=useState(false);
 const [issueLimit,setIssueLimit]=useState(40);
 const runId=useRef<string|null>(null);
 const syncRunId=useRef<string|null>(null);
 const applying=useRef(false);
 const mounted=useRef(true);
 const urlEdited=useRef(false);
 const busy=loading||saving||syncing||refreshingData;
 useEffect(()=>{
  mounted.current=true;
  let active=true;
  void request<ImportSettings>().then(value=>{
   if(!mounted.current||!active)return;
   setHistory(value.history);
   setSyncSettings(value);
   if(!value.syncAvailable)setLinkOptionsOpen(true);
   setUrl(current=>urlEdited.current?current:current||value.defaultSourceUrl||value.history[0]?.source_url||'');
  }).catch(cause=>{if(mounted.current&&active){setHistoryError(true);setError(current=>current||(cause instanceof Error?cause.message:'등록된 시트 설정을 읽지 못했습니다.'));}});
  return()=>{active=false;mounted.current=false;};
 },[]);
 async function loadHistory(){
  try{const value=await request<ImportSettings>();if(mounted.current){setHistory(value.history);setSyncSettings(value);setHistoryError(false);}}
  catch{if(mounted.current)setHistoryError(true);}
 }
 const accountOptions=[{value:'none',label:'계좌를 선택하세요'},...data.accounts.map(account=>({value:account.id,label:[data.businesses.find(b=>b.id===account.business_id)?.name||'사업자 미확인',account.name,account.bank,account.masked_number].filter(Boolean).join(' · ')}))];
 const selected=mappings.filter(sheet=>sheet.selected);
 const missingAccount=selected.some(sheet=>!sheet.account_id);
 const issues=useMemo(()=>{
  if(!preview)return [];
  const selectedNames=new Set(mappings.filter(sheet=>sheet.selected).map(sheet=>sheet.sheet));
  const all=[...preview.sheets.filter(sheet=>selectedNames.has(sheet.name)).flatMap(sheet=>sheet.errors.map(item=>({...item,sheet:sheet.name}))),...preview.conflicts];
  return [...new Map(all.map(item=>[JSON.stringify([item.sheet,item.row,item.message]),item])).values()];
 },[preview,mappings]);
 const hasIssues=issues.length>0||(preview?.summary.blocked||0)>0;
 const hasChanges=!!preview&&(preview.summary.inserted+preview.summary.updated+preview.summary.removed>0);
 const canApply=!!preview&&!stale&&!busy&&!result&&selected.length>0&&!missingAccount&&hasChanges&&(!hasIssues||allowPartial);
 const applyMessage=result?importRefreshFailed?'저장 완료 · 화면 자료를 다시 불러와주세요.':'신규 거래를 반영했습니다.':stale?'변경 내용을 다시 확인해주세요.':missingAccount?'선택한 시트에 저장 계좌를 지정해주세요.':!selected.length?'가져올 시트를 선택해주세요.':!hasChanges?'추가할 신규 거래가 없습니다.':hasIssues&&!allowPartial?'확인 필요 행을 검토해주세요.':'계좌·계정과목 확인 후 신규 거래만 추가하세요.';
 const applyLabel=saving?'신규 거래 추가 중…':result?importRefreshFailed?'저장 완료':'반영 완료':'신규 거래만 추가';
 const categoryCounts=(preview?.sheets||[]).filter(sheet=>selected.some(mapping=>mapping.sheet===sheet.name)).flatMap(sheet=>sheet.categoryIssues||[]).reduce((counts,issue)=>({...counts,[issue.status]:counts[issue.status]+issue.count}),{unregistered:0,needs_review:0});
 function changeMapping(sheet:string,patch:Partial<SheetMapping>){
  if(busy)return;
  setMappings(current=>current.map(item=>item.sheet===sheet?{...item,...patch}:item));setStale(true);setResult(null);setError('');setAllowPartial(false);
 }
 function downloadIssues(){
  if(!amountsVisible)return;
  if(busy||!issues.length)return;
  const cell=(value:string|number)=>{
   const text=String(value);
   const safe=/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(text)?"'"+text:text;
   return '"'+safe.replace(/"/g,'""')+'"';
  };
  const rows=[['시트','원본행','확인사항'],...issues.map(issue=>[issue.sheet,issue.row,issue.message])];
  const csv='\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n');
  const objectUrl=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  const link=document.createElement('a');link.href=objectUrl;link.download='구글시트_확인필요_전체.csv';
  try{document.body.appendChild(link);link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);}
 }
 async function retryDatasetRefresh(){
  if(busy)return;
  setRefreshingData(true);
  try{
   await refresh();
   if(mounted.current){setSyncRefreshFailed(false);setImportRefreshFailed(false);toast.success('저장된 거래와 잔액을 다시 불러왔습니다.');}
  }catch{toast.warning('저장된 거래는 유지됩니다. 화면 자료를 아직 불러오지 못했습니다. 다시 시도해주세요.');}
  finally{if(mounted.current)setRefreshingData(false);}
 }
 function refreshNotice(){
  return <div className="gs-warning" role="alert"><TriangleAlert size={17}/><div><strong>저장 완료 · 화면 갱신 필요</strong><p>재저장 없이 화면 자료만 다시 불러옵니다.</p><Button variant="outline" size="sm" disabled={busy} onClick={()=>void retryDatasetRefresh()}>{refreshingData?<LoaderCircle className="animate-spin" size={15}/>:<RefreshCw size={15}/>} 화면 자료 다시 불러오기</Button></div></div>;
 }
 async function inspect(){
  if(busy||applying.current)return;
  if(!safeSheetUrl(url.trim())){setError('Google 스프레드시트의 공유 링크를 입력해주세요.');return;}
  setLoading(true);setError('');setResult(null);
  try{
   const next=await request<ImportPreview>({action:'preview',url:url.trim(),...(preview?{mappings}:{}),allowPartial});
   if(!mounted.current)return;
   setPreview(next);setMappings(next.sheets.map(sheet=>({sheet:sheet.name,account_id:sheet.account_id,selected:sheet.selected})));setAllowPartial(false);setStale(false);setIssueLimit(40);runId.current=crypto.randomUUID();
  }catch(cause){if(mounted.current){const message=cause instanceof Error?cause.message:'시트를 확인하지 못했습니다.';setError(message);setStale(true);toast.error(<FinancialText value={String(message)}/>);}}
  finally{if(mounted.current)setLoading(false);}
 }
 async function apply(){
  if(applying.current||!canApply||!preview||!runId.current)return;
  applying.current=true;
  setSaving(true);setError('');setImportRefreshFailed(false);
  try{
   const completion=await settleDatasetMutation(request<ImportResult>({action:'apply',url:url.trim(),mappings,sourceHash:preview.sourceHash,planHash:preview.planHash,runId:runId.current,allowPartial}),refresh);
   if(!completion.refreshed)toast.warning('저장은 완료됐지만 화면 자료를 갱신하지 못했습니다. 자료 새로고침으로 다시 확인해주세요.');
   if(!mounted.current)return;
   setResult(completion.result);setImportRefreshFailed(!completion.refreshed);
   if(completion.refreshed)toast.success(<FinancialText value={String(`신규 ${count(completion.result.inserted)}을 추가하고 화면 자료를 갱신했습니다. 기존 거래는 유지했습니다.`)}/>);
   void loadHistory();
  }catch(cause){if(mounted.current){const message=cause instanceof Error?cause.message:'반영 결과를 확인하지 못했습니다. 같은 버튼으로 다시 확인해주세요.';setError(message);toast.error(<FinancialText value={String(message)}/>);}}
  finally{applying.current=false;if(mounted.current)setSaving(false);}
 }
 async function syncLatest(){
  if(busy||applying.current||!syncSettings?.syncAvailable)return;
  applying.current=true;
  syncRunId.current??=crypto.randomUUID();
  setSyncing(true);setSyncError('');setSyncResult(null);setSyncRefreshFailed(false);setSyncIssueLimit(40);
  try{
   const completion=await settleDatasetMutation(request<SyncResult>({action:'sync',runId:syncRunId.current}),refresh);
   syncRunId.current=null;
   if(!completion.refreshed)toast.warning('동기화 저장은 완료됐지만 화면 자료를 갱신하지 못했습니다. 자료 새로고침으로 다시 확인해주세요.');
   if(!mounted.current)return;
   const value=completion.result;
   setSyncResult(value);setSyncRefreshFailed(!completion.refreshed);
   if(preview){setStale(true);setResult(null);}
   const message=value.inserted?`신규 거래 ${count(value.inserted)}을 추가했습니다.`:'추가할 신규 거래가 없습니다.';
   if(completion.refreshed){if(value.blocked)toast.warning(<FinancialText value={String(`${message} 화면 자료를 갱신했고, 확인이 필요한 ${count(value.blocked)}는 보류했습니다.`)}/>);else toast.success(<FinancialText value={String(`${message} 화면 자료를 갱신했습니다.`)}/>);}
   void loadHistory();
  }catch(cause){if(mounted.current){const message=cause instanceof Error?cause.message:'동기화 결과를 확인하지 못했습니다. 같은 버튼으로 다시 확인해주세요.';setSyncError(message);toast.error(<FinancialText value={String(message)}/>);}}
  finally{applying.current=false;if(mounted.current)setSyncing(false);}
 }
 const syncIssues=[...new Map([...(syncResult?.sheets||[]).filter(sheet=>sheet.selected).flatMap(sheet=>sheet.errors.map(item=>({...item,sheet:sheet.name}))),...(syncResult?.conflicts||[])].map(issue=>[JSON.stringify([issue.sheet,issue.row,issue.message]),issue])).values()];
 return <Panel title="Google 스프레드시트" subtitle="계정관리봇이 정리한 신규 거래 가져오기" className="gs-import">
  <div className="gs-latest-sync">
   <div><strong>연결된 통장 전체</strong><p>신규 거래만 추가 · 기존 거래·분류·메모 유지</p>{syncSettings?.defaultSourceUrl&&safeSheetUrl(syncSettings.defaultSourceUrl)&&<a href={safeSheetUrl(syncSettings.defaultSourceUrl)!} target="_blank" rel="noopener noreferrer">원본 시트 <ArrowRight size={12}/></a>}</div>
   <Button onClick={()=>void syncLatest()} disabled={busy||!syncSettings?.syncAvailable}>{syncing?<LoaderCircle className="animate-spin" size={16}/>:<RefreshCw size={16}/>} {syncing?'동기화 중…':'구글 시트 최신 동기화'}</Button>
  </div>
  {syncing&&<p className="gs-caption" role="status">전체 통장 내역을 읽고 기존 거래와 비교하고 있습니다.</p>}
  {syncSettings&&!syncSettings.syncAvailable&&<p className="gs-caption">{syncSettings.syncUnavailableReason||'전체 통장을 동기화하려면 시트와 계좌 연결을 먼저 설정해주세요.'}</p>}
  {syncError&&<div className="gs-warning" role="alert"><TriangleAlert size={17}/><span><FinancialText value={String((syncError)??'')}/> 최신 동기화를 다시 누르면 같은 실행 결과를 확인합니다.</span></div>}
  {syncRefreshFailed&&refreshNotice()}
  {syncResult&&<div className={syncRefreshFailed?'gs-policy':'gs-success'} role="status"><div>{syncRefreshFailed?<TriangleAlert size={20}/>:<CheckCircle2 size={20}/>}<strong>{syncRefreshFailed?'거래 저장 완료 · 화면 자료 미갱신':syncResult.blocked?'동기화 완료 · 일부 확인 필요':syncResult.inserted?'최신 동기화 완료':'최신 내역입니다'}</strong></div><p>신규 추가 {count(syncResult.inserted)} · 기존 유지 {count(syncResult.unchanged)} · 시트 중복 건너뜀 {count(syncResult.sourceDuplicates)} · 확인 필요 {count(syncResult.blocked)}</p><p>기존 거래 수정 {count(syncResult.updated)} · 삭제 {count(syncResult.removed)}{syncResult.sheets?` · ${syncResult.sheets.filter(sheet=>sheet.selected).length}개 통장 시트 확인`:''}</p>{syncResult.blocked>0&&<p>확인 필요 거래는 추가하지 않았습니다. 원본과 계좌 연결을 확인한 뒤 다시 동기화해주세요.</p>}{!!syncIssues.length&&<details className="gs-sync-issues"><summary>보류된 거래의 원본 위치와 사유 보기</summary><ul>{syncIssues.slice(0,syncIssueLimit).map((issue,index)=><li key={`${issue.sheet}:${issue.row}:${index}`}><strong><FinancialText value={String((issue.sheet)??'')}/> · {issue.row}행</strong> <FinancialText value={String((issue.message)||'')}/></li>)}</ul><p>전체 {syncIssues.length.toLocaleString()}개 중 {Math.min(syncIssueLimit,syncIssues.length).toLocaleString()}개 표시</p>{syncIssues.length>syncIssueLimit&&<Button className="mt-3" variant="outline" size="sm" disabled={busy} onClick={()=>setSyncIssueLimit(limit=>limit+40)}>다음 {Math.min(40,syncIssues.length-syncIssueLimit)}개 보기<ChevronDown size={15}/></Button>}</details>}</div>}
  <details className="gs-link-options" open={linkOptionsOpen} onToggle={event=>setLinkOptionsOpen(event.currentTarget.open)}>
   <summary><Link2 size={15}/>링크 미리보기·계좌 연결<ChevronDown size={15}/></summary>
  <div className="gs-source">
   <div className="gs-source-icon"><FileSpreadsheet size={24}/></div>
   <div className="gs-source-field"><label htmlFor="finance-sheet-url">스프레드시트 공유 링크</label><Input id="finance-sheet-url" type="url" autoComplete="off" spellCheck={false} placeholder="https://docs.google.com/spreadsheets/d/…" value={url} disabled={busy} onChange={event=>{urlEdited.current=true;setUrl(event.target.value);setPreview(null);setMappings([]);setStale(false);setAllowPartial(false);setResult(null);setError('');setIssueLimit(40);runId.current=null;}}/></div>
   <Button variant="outline" onClick={()=>void inspect()} disabled={busy||!url.trim()}>{loading?<LoaderCircle className="animate-spin" size={16}/>:preview?<RefreshCw size={16}/>:<Link2 size={16}/>} {loading?'시트 확인 중…':preview?'변경 내용 다시 확인':'시트 미리보기'}</Button>
  </div>
  <p className="gs-caption">선택한 시트의 전체 기간을 확인하고 동일 거래는 중복 제외합니다.</p>
  </details>
  {error&&<div className="gs-warning" role="alert"><TriangleAlert size={17}/><span><FinancialText value={String((error)||'')}/></span></div>}
  {preview&&<div className="gs-preview">
   {importRefreshFailed&&refreshNotice()}
   <div className={'gs-preview-status '+(result&&!importRefreshFailed?'gs-preview-saved':'')} role="status">
    {importRefreshFailed?<TriangleAlert size={21}/>:result?<CheckCircle2 size={21}/>:<FileSpreadsheet size={21}/>}
    <div><strong>{result?importRefreshFailed?'저장 완료 · 화면 갱신 필요':'반영 완료':'미리보기 · 아직 저장되지 않음'}</strong><p>{result?`신규 ${count(result.inserted)} 저장`:'계좌와 계정과목을 확인한 뒤 추가하세요.'}</p></div>
   </div>
   <div className={'gs-plan '+(stale?'gs-plan-stale':'')} aria-label={privateText(String(result?'실제 반영 결과':'시트 반영 예상 결과'))}><Summary value={result||preview.summary}/></div>
   <div className="gs-apply gs-apply-top"><div><p>{applyMessage}</p>{hasIssues&&!allowPartial&&!result&&<a href="#gs-import-review">확인 필요 행 검토하기 <ArrowRight size={13}/></a>}</div><Button disabled={!canApply} onClick={()=>void apply()}>{saving?<LoaderCircle size={16} className="animate-spin"/>:result?<CheckCircle2 size={16}/>:<ArrowRight size={16}/>} {applyLabel}</Button></div>
   <p className="gs-caption">{result?'저장 결과':'저장 전 예상'} · 시트 중복 {count(preview.summary.sourceDuplicates)} 제외{stale?' · 변경 내용 재확인 필요':''}</p>
   {(categoryCounts.unregistered>0||categoryCounts.needs_review>0)&&<div className="gs-category-notice"><TriangleAlert size={17}/><div><strong>선택한 시트의 계정과목 확인이 필요합니다</strong><p>{categoryCounts.unregistered>0?`미등록 과목 ${count(categoryCounts.unregistered)}`:''}{categoryCounts.unregistered>0&&categoryCounts.needs_review>0?' · ':''}{categoryCounts.needs_review>0?`원본도 세부 분류 필요 ${count(categoryCounts.needs_review)}`:''}. 아래에서 원본 과목과 대시보드 인식 과목을 비교하세요.</p><p>미등록·세부 분류 필요 과목은 자동으로 추정하지 않습니다. 기존 거래에 유효한 분류가 있으면 유지합니다.</p></div></div>}
   <div className="gs-section-heading"><div><h3>가져올 시트와 계좌</h3></div><span>{selected.length} / {preview.sheets.length}개 선택</span></div>
   {!preview.sheets.length&&<p className="gs-empty">거래로 인식할 수 있는 시트가 없습니다. 거래일자·입금·출금 열이 있는지 확인해주세요.</p>}
   <fieldset disabled={busy||!!result} className="gs-sheet-list">
    {preview.sheets.map(sheet=>{const mapping=mappings.find(item=>item.sheet===sheet.name);return <div key={sheet.name} className={'gs-sheet '+(!mapping?.selected?'gs-sheet-excluded':'')}>
     <div className="gs-sheet-top"><label className="gs-sheet-check"><Checkbox checked={mapping?.selected||false} disabled={busy||!!result} onCheckedChange={checked=>changeMapping(sheet.name,{selected:checked===true})}/><strong><FinancialText value={sheet.name}/></strong><span>{count(sheet.count)}</span></label><div className="gs-sheet-account"><span>저장 계좌</span><Picker label={privateText(String(`${sheet.name} 저장 계좌`))} value={mapping?.account_id||'none'} onChange={value=>{if(!busy&&!result)changeMapping(sheet.name,{account_id:value==='none'?null:value});}} options={accountOptions}/></div></div>
     <div className="gs-sheet-meta"><span>{sheet.from?`${sheet.from} ~ ${sheet.to||sheet.from}`:'인식한 거래일자 없음'}</span><span>원본 입금 <b className="positive"><FinancialValue value={money(sheet.income)}/></b></span><span>원본 출금 <b className="negative"><FinancialValue value={money(sheet.expense)}/></b></span>{!!sheet.errors.length&&<span className="negative">확인 필요 {sheet.errors.length}행</span>}{mapping?.selected&&!mapping.account_id&&<span className="negative">계좌 선택 필요</span>}</div>
     {!!sheet.categoryIssues?.length&&<div className="gs-category-issues"><strong>원본 계정과목 확인</strong><ul>{sheet.categoryIssues.map(issue=><li key={`${issue.status}:${issue.rawName}`}><span>{issue.rawName||'빈 과목'} <small className={issue.status==='unregistered'?'gs-category-unregistered':'gs-category-review'}>{issue.status==='unregistered'?'미등록':'원본도 세부 분류 필요'}</small></span><b>{count(issue.count)}</b></li>)}</ul></div>}
     {!!sheet.sample.length&&<details className="gs-samples"><summary><ChevronDown size={15}/>거래·계정과목 미리보기 <small>{sheet.sample.length}건</small></summary><Table><TableHeader><TableRow><TableHead>거래일자</TableHead><TableHead>구분</TableHead><TableHead>거래내용</TableHead><TableHead>시트 원본 계정과목</TableHead><TableHead>대시보드 인식 과목</TableHead><TableHead className="gs-number">금액</TableHead><TableHead className="gs-number">거래 후 잔액</TableHead></TableRow></TableHeader><TableBody>{sheet.sample.map((transaction,index)=><TableRow key={index}><TableCell>{transaction.txn_date}</TableCell><TableCell className={transaction.direction==='in'?'positive':'negative'}>{transaction.direction==='in'?'입금':'출금'}</TableCell><TableCell><FinancialText value={String((transaction.description||'—')||'')}/></TableCell><TableCell className="gs-category-cell"><span>{transaction.raw_category||'—'}</span>{transaction.category_status==='unregistered'&&<small className="gs-category-unregistered">미등록</small>}{transaction.category_status==='needs_review'&&<small className="gs-category-review">원본도 세부 분류 필요</small>}{transaction.category_status==='blank'&&<small>원본 비어 있음</small>}</TableCell><TableCell className="gs-category-cell"><span>{transaction.category_name||'미매핑'}</span>{transaction.category_status==='blank'&&<small>기존 거래는 기존 분류 유지</small>}</TableCell><TableCell className="gs-number"><FinancialValue value={money(transaction.amount)}/></TableCell><TableCell className="gs-number"><FinancialValue value={transaction.balance===null?'—':money(transaction.balance)}/></TableCell></TableRow>)}</TableBody></Table></details>}
    </div>;})}
   </fieldset>
   {stale&&<div className="gs-warning" role="status"><RefreshCw size={17}/><span>선택한 시트 또는 계좌가 바뀌었습니다. 위의 <strong>변경 내용 다시 확인</strong>을 눌러 반영할 거래를 다시 확인해주세요.</span></div>}
   <p className="gs-caption">시트별 금액은 중복·보류 제외 전 합계입니다. 동일 거래만 중복 제외합니다.</p>
   {hasIssues&&<div className="gs-review" id="gs-import-review"><div className="gs-review-heading"><TriangleAlert size={18}/><strong>확인이 필요한 거래가 있습니다.</strong></div><p>확인 필요 거래는 자동으로 바꾸지 않습니다. 원본을 수정한 후 다시 확인하거나, 정상 거래만 먼저 반영할 수 있습니다.</p>{!!issues.length&&<><Button className="mt-3" variant="outline" size="sm" disabled={busy||!amountsVisible} title={!amountsVisible?'금액 표시를 켜면 내려받을 수 있습니다':undefined} onClick={downloadIssues}><Download size={15}/>확인 필요 전체 {issues.length.toLocaleString()}개 다운로드 · CSV</Button><details><summary>확인 사항 {issues.length.toLocaleString()}개 보기</summary><ul>{issues.slice(0,issueLimit).map((issue,index)=><li key={`${issue.sheet}:${issue.row}:${index}`}><strong><FinancialText value={String((issue.sheet)??'')}/> · {issue.row}행</strong><span><FinancialText value={String((issue.message)||'')}/></span></li>)}</ul><p aria-live="polite">전체 {issues.length.toLocaleString()}개 중 {Math.min(issueLimit,issues.length).toLocaleString()}개 표시{issues.length>issueLimit?` · 남은 ${ (issues.length-issueLimit).toLocaleString()}개`:''}</p>{issues.length>issueLimit&&<Button className="mt-3" variant="outline" size="sm" disabled={busy} onClick={()=>setIssueLimit(limit=>limit+40)}>다음 {Math.min(40,issues.length-issueLimit)}개 보기<ChevronDown size={15}/></Button>}</details></>}<label className="gs-partial"><Checkbox checked={allowPartial} disabled={busy||!!result||stale} onCheckedChange={checked=>setAllowPartial(checked===true)}/><span>확인 필요 행을 제외하고 정상 거래만 반영</span></label></div>}
   <div className="gs-apply"><p>{applyMessage}</p><Button disabled={!canApply} onClick={()=>void apply()}>{saving?<LoaderCircle size={16} className="animate-spin"/>:result?<CheckCircle2 size={16}/>:<ArrowRight size={16}/>} {applyLabel}</Button></div>
   {result&&<div className="gs-success" role="status"><div><CheckCircle2 size={20}/><strong>거래에 반영했습니다</strong></div><p>신규 {count(result.inserted)} · 기존 유지 {count(result.unchanged)} · 기존 거래 수정 0건 · 삭제 0건</p>{result.blocked>0&&<p>확인 필요 {count(result.blocked)}는 제외했습니다.</p>}</div>}
  </div>}
  <details className="gs-history"><summary><History size={16}/>링크 가져오기 기록 <span>{history.length}건</span></summary>{historyError?<div className="gs-history-error"><p>가져오기 기록을 읽지 못했습니다.</p><Button variant="outline" size="sm" disabled={busy} onClick={()=>void loadHistory()}>다시 확인</Button></div>:history.length?<Table><TableHeader><TableRow><TableHead>원본 링크</TableHead><TableHead>반영일</TableHead><TableHead>신규 / 업데이트 / 중복 정리</TableHead></TableRow></TableHeader><TableBody>{history.map(item=><TableRow key={item.id}><TableCell>{safeSheetUrl(item.source_url)?<a href={safeSheetUrl(item.source_url)!} target="_blank" rel="noopener noreferrer">Google 스프레드시트 <ArrowRight size={12}/></a>:<span>스프레드시트</span>}</TableCell><TableCell>{new Date(item.created_at).toLocaleString('ko-KR')}</TableCell><TableCell>{item.result.inserted.toLocaleString()} / {item.result.updated.toLocaleString()} / {item.result.removed.toLocaleString()}</TableCell></TableRow>)}</TableBody></Table>:<p className="gs-empty">아직 링크로 가져온 거래가 없습니다.</p>}</details>
 </Panel>;
}

function Summary({value}:{value:ImportSummary}){
 return <>{[{label:'새로 추가',value:value.inserted,tone:'positive'},{label:'기존 거래 수정',value:value.updated,tone:''},{label:'기존 거래 삭제',value:value.removed,tone:''},{label:'기존 유지',value:value.unchanged,tone:'muted'},{label:'확인 필요 · 보류',value:value.blocked,tone:value.blocked?'negative':'muted'}].map(item=><div key={item.label}><span>{item.label}</span><strong className={item.tone}>{item.value.toLocaleString()}<small>건</small></strong></div>)}</>;
}
