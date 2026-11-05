"use client";

import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowRight,CheckCircle2,CheckCheck,ChevronLeft,ChevronRight,LoaderCircle,RefreshCw,Search,TriangleAlert} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import {Input} from '@/components/ui/input';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import type {ClobeAccountsResponse} from '@/lib/clobe/types';
import type {ClobeImportInput,ClobeImportPreview,ClobeImportResult,ClobeImportSettings} from '@/lib/clobe/import-types';
import type {Dataset} from '@/lib/finance/types';
import {isValidDateRange,type DateRange} from '@/lib/finance/date-range';
import {settleDatasetMutation} from '@/lib/finance/dataset-refresh';
import {clobeDashboardSyncCoordinator} from '@/lib/finance/clobe-dashboard-sync-client';
import {clobeSyncRange} from '@/lib/finance/clobe-sync-range';
import {CategoryPicker} from './category-picker';
import {DateRangeControl} from './date-range-control';
import {Picker} from './common';
import {clobeMoney,clobePanelRequest,createClobeRequestGate} from './clobe-panel-model';
import {chosenClobeCategory,clobeImportAccountOptions,clobeImportBankKey,clobeImportBanks,clobeImportLinkError,clobeImportNeedsCategoryReview,clobeImportSearchMatches,restoreClobeImportLinks,setSelectedClobeCategories,type ClobeImportLink} from './clobe-import-model';
import {useClobeDashboardSync} from './use-clobe-dashboard-sync';
import {clobeManualImportSyncBlocked} from './clobe-import-ui';

const count=(value:number)=>`${value.toLocaleString('ko-KR')}건`;
const errorText=(cause:unknown)=>cause instanceof Error?cause.message:'Clobe 거래 반영을 완료하지 못했습니다. 다시 시도해주세요.';
const pageSize=50;
const sharedSyncBlocksImport=()=>clobeManualImportSyncBlocked(clobeDashboardSyncCoordinator.getSnapshot().phase);

export function ClobeImportPanel({accounts,data,refresh}:{accounts:ClobeAccountsResponse;data:Dataset;refresh:()=>Promise<void>}){
 const sharedSync=useClobeDashboardSync(),syncBlocked=clobeManualImportSyncBlocked(sharedSync?.snapshot.phase);
 const banks=useMemo(()=>clobeImportBanks(accounts),[accounts]);
 const [links,setLinks]=useState<ClobeImportLink[]>(()=>restoreClobeImportLinks(banks,[],data));
 const [settingsLoading,setSettingsLoading]=useState(true),[settingsError,setSettingsError]=useState('');
 const [range,setRange]=useState<DateRange>(()=>{const {from,to}=clobeSyncRange();return {from,to};});
 const [preview,setPreview]=useState<ClobeImportPreview|null>(null),[result,setResult]=useState<ClobeImportResult|null>(null);
 const [choices,setChoices]=useState<Record<string,string|null>>({}),[selected,setSelected]=useState<Set<string>>(new Set());
 const [batch,setBatch]=useState(''),[search,setSearch]=useState(''),[kind,setKind]=useState('insert'),[page,setPage]=useState(0);
 const [loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[refreshing,setRefreshing]=useState(false);
 const [error,setError]=useState(''),[refreshFailed,setRefreshFailed]=useState(false),[expired,setExpired]=useState(false);
 const [allowUnclassified,setAllowUnclassified]=useState(false),[allowPartial,setAllowPartial]=useState(false),[issueLimit,setIssueLimit]=useState(40);
 const gate=useRef(createClobeRequestGate()),settingsGate=useRef(createClobeRequestGate());
 const requestBusy=useRef(false),applying=useRef(false),mounted=useRef(true),mappingEdited=useRef(false);
 const attemptedApply=useRef<Extract<ClobeImportInput,{action:'apply'}>|null>(null);
 const [applyAttempted,setApplyAttempted]=useState(false);
 const busy=settingsLoading||loading||saving||refreshing||syncBlocked;
 const editLocked=busy||applyAttempted||!!result;
 const linkError=clobeImportLinkError(links,data);
 const mappingOptions=useMemo(()=>clobeImportAccountOptions(data),[data]);
 const newRows=useMemo(()=>preview?.rows.filter(row=>row.kind==='insert')||[],[preview]);
 const unclassified=newRows.filter(row=>clobeImportNeedsCategoryReview(row,choices,data.categories)).length;
 const visibleRows=useMemo(()=>preview?.rows.filter(row=>(kind==='all'||row.kind===kind)&&clobeImportSearchMatches([row.description,row.source_details?.counterparty,row.source_details?.detail,row.source_details?.memo,data.businesses.find(business=>business.id===data.accounts.find(account=>account.id===row.account_id)?.business_id)?.name],search))||[],[preview,kind,search,data]);
 const pages=Math.max(1,Math.ceil(visibleRows.length/pageSize)),currentPage=Math.min(page,pages-1),paged=visibleRows.slice(currentPage*pageSize,(currentPage+1)*pageSize);
 const filteredNew=useMemo(()=>visibleRows.filter(row=>row.kind==='insert'),[visibleRows]);
 const selectablePage=paged.filter(row=>row.kind==='insert');
 const selectedNew=newRows.filter(row=>selected.has(row.key));
 const blocked=preview?.summary.blocked||0;
 const hasChanges=!!preview&&(preview.summary.inserted+preview.summary.referenced>0);
 const canApply=hasChanges&&!busy&&!result&&(!expired||applyAttempted)&&(!unclassified||allowUnclassified)&&(!blocked||allowPartial);

 async function loadSettings(){
  const request=settingsGate.current.begin();setSettingsLoading(true);setSettingsError('');
  try{
   const value=await clobePanelRequest<ClobeImportSettings>('/api/clobe/import',{signal:request.signal});
   if(!settingsGate.current.current(request.version)||!mounted.current)return;
   if(!mappingEdited.current)setLinks(restoreClobeImportLinks(banks,value.mappings,data));
  }catch(cause){if(settingsGate.current.current(request.version)&&mounted.current)setSettingsError(errorText(cause));}
  finally{if(settingsGate.current.current(request.version)&&mounted.current)setSettingsLoading(false);}
 }
 useEffect(()=>{
  mounted.current=true;let active=true;const mountedGate=gate.current,mountedSettingsGate=settingsGate.current;
  void Promise.resolve().then(()=>{if(active)void loadSettings();});
  return()=>{active=false;mounted.current=false;mountedGate.cancel();mountedSettingsGate.cancel();};
  // This panel is mounted only after a successful Clobe accounts query.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 useEffect(()=>{
  if(!preview)return;
  const delay=Math.max(0,new Date(preview.expiresAt).getTime()-Date.now());
  const timer=setTimeout(()=>setExpired(true),Math.min(delay,2147483647));
  return()=>clearTimeout(timer);
 },[preview]);

 function clearPreview(){
  gate.current.cancel();requestBusy.current=false;setPreview(null);setResult(null);setChoices({});setSelected(new Set());
  setLoading(false);setError('');setRefreshFailed(false);setExpired(false);setAllowUnclassified(false);setAllowPartial(false);setApplyAttempted(false);attemptedApply.current=null;setPage(0);setIssueLimit(40);
 }
 function changeLink(key:string,patch:Partial<Pick<ClobeImportLink,'selected'|'account_id'>>){
  if(editLocked||applying.current||sharedSyncBlocksImport())return;mappingEdited.current=true;clearPreview();setLinks(current=>current.map(link=>clobeImportBankKey(link)===key?{...link,...patch}:link));
 }
 function changeRange(value:DateRange){if(editLocked||applying.current||sharedSyncBlocksImport())return;clearPreview();setRange(value);}
 async function inspect(){
  if(busy||requestBusy.current||applying.current||sharedSyncBlocksImport())return;
  if(linkError){setError(linkError);return;}
  if(!isValidDateRange(range)||range.from<'1900-01-01'||range.to>'2100-12-31'){setError('거래를 가져올 날짜 범위를 확인해주세요.');return;}
  clearPreview();requestBusy.current=true;const request=gate.current.begin();setLoading(true);
  const body:ClobeImportInput={action:'preview',start_date:range.from,end_date:range.to,mappings:links.filter(link=>link.selected&&link.account_id).map(link=>({company_id:link.company_id,external_account_id:link.external_account_id,account_id:link.account_id!}))};
  try{
   const next=await clobePanelRequest<ClobeImportPreview>('/api/clobe/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:request.signal});
   if(!gate.current.current(request.version)||!mounted.current)return;
   setPreview(next);setChoices({});setKind('insert');setSearch('');setBatch('');
  }catch(cause){if(gate.current.current(request.version)&&mounted.current)setError(errorText(cause));}
  finally{if(gate.current.current(request.version)&&mounted.current){requestBusy.current=false;setLoading(false);}}
 }
 function changeCategory(key:string,category_id:string){if(editLocked||applying.current||sharedSyncBlocksImport())return;setChoices(current=>({...current,[key]:category_id}));setAllowUnclassified(false);}
 function toggleSelection(keys:string[],checked:boolean){
  if(editLocked||applying.current||sharedSyncBlocksImport())return;setSelected(current=>{const next=new Set(current);for(const key of keys){if(checked)next.add(key);else next.delete(key);}return next;});
 }
 function applyBatch(){if(editLocked||applying.current||sharedSyncBlocksImport()||!batch||!selectedNew.length)return;setChoices(current=>setSelectedClobeCategories(newRows,selected,current,batch,data.categories));setAllowUnclassified(false);}
 async function apply(){
  if(applying.current||!canApply||!preview||sharedSyncBlocksImport())return;
  applying.current=true;setSaving(true);setError('');setApplyAttempted(true);setRefreshFailed(false);
  attemptedApply.current??={action:'apply',previewId:preview.previewId,choices:newRows.map(row=>({key:row.key,category_id:chosenClobeCategory(row,choices)}))};
  const body=attemptedApply.current;
  try{
   const completion=await settleDatasetMutation(clobePanelRequest<ClobeImportResult>('/api/clobe/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),refresh);
   if(!completion.refreshed)toast.warning('Clobe 거래 저장은 완료됐지만 화면 자료를 갱신하지 못했습니다. 자료를 다시 불러와주세요.');
   if(!mounted.current)return;
   setResult(completion.result);setRefreshFailed(!completion.refreshed);
   if(completion.refreshed)toast.success(`Clobe 신규 ${count(completion.result.inserted)}을 저장하고 거래·잔액·분석 자료를 갱신했습니다.`);
  }catch(cause){if(mounted.current)setError(`${errorText(cause)} 같은 적용 버튼으로 결과를 다시 확인할 수 있습니다.`);}
  finally{applying.current=false;if(mounted.current)setSaving(false);}
 }
 async function retryRefresh(){
  if(busy)return;setRefreshing(true);
  try{await refresh();if(mounted.current){setRefreshFailed(false);toast.success('저장된 거래·잔액·분석 자료를 다시 불러왔습니다.');}}
  catch{if(mounted.current)setError('거래 저장은 완료됐습니다. 화면 자료를 다시 불러오지 못했으니 자료 새로고침으로 재시도해주세요.');}
  finally{if(mounted.current)setRefreshing(false);}
 }
 function startAgain(){if(busy||applying.current||sharedSyncBlocksImport())return;clearPreview();}
 const storedAccountLabel=(accountId:string)=>mappingOptions.find(option=>option.value===accountId)?.label||'저장 계좌 확인 필요';

 return <div className="clobe-import" aria-label="Clobe 거래를 대시보드에 반영">
  <div className="clobe-section-heading"><div><h3>통장 연결·직접 가져오기</h3><p className="clobe-caption">통장·기간 선택 → 분류 확인 → 적용</p></div></div>
  {syncBlocked&&<p className="clobe-caption" role="status">{sharedSync?.snapshot.phase==='refresh-needed'?'최신 동기화의 화면 자료 재조회가 필요합니다. 상단 재조회가 끝나면 개별 가져오기를 계속할 수 있습니다.':'최신 동기화 중에는 개별 미리보기·적용을 잠시 중지합니다. 선택한 통장·기간·분류는 유지됩니다.'}</p>}
  <ol className="clobe-import-steps" aria-label="Clobe 거래 반영 단계"><li data-active={!preview}><span>1</span>통장·기간 선택</li><li data-active={!!preview&&!result}><span>2</span>계정과목 분류</li><li data-active={!!result}><span>3</span>대시보드 적용</li></ol>
  <div className="clobe-import-step"><div className="clobe-import-step-head"><h4>1. 가져올 통장과 저장 계좌</h4>{(preview||result)&&<Button type="button" size="sm" variant="outline" disabled={busy} onClick={startAgain}>통장·기간 다시 선택</Button>}</div><p className="clobe-caption">Clobe 통장과 멀린 저장 계좌를 연결하세요.</p>
   {settingsLoading&&<p className="clobe-caption" role="status"><LoaderCircle size={14} className="animate-spin"/> 저장한 통장 연결을 확인하고 있습니다.</p>}
   {settingsError&&<div className="clobe-warning" role="alert"><TriangleAlert size={16}/><span>저장한 연결을 불러오지 못했습니다. 직접 선택하거나 다시 확인해주세요. {settingsError}</span><Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>void loadSettings()}>연결 다시 확인</Button></div>}
   <fieldset disabled={editLocked} className="clobe-import-mappings"><Table><TableHeader><TableRow><TableHead>가져오기</TableHead><TableHead>Clobe 사업자·은행·통장</TableHead><TableHead>멀린 사업자·저장 계좌</TableHead></TableRow></TableHeader><TableBody>{banks.map(bank=>{const key=clobeImportBankKey(bank),link=links.find(item=>clobeImportBankKey(item)===key);return <TableRow key={key}><TableCell><Checkbox aria-label={`${bank.company_name} ${bank.name} 가져오기`} checked={link?.selected||false} disabled={editLocked} onCheckedChange={value=>changeLink(key,{selected:value===true})}/></TableCell><TableCell><strong>{bank.company_name}</strong><small className="cell-secondary">{[bank.bank_name,bank.name,bank.masked_number,bank.is_hidden?'숨김 계좌':''].filter(Boolean).join(' · ')}</small></TableCell><TableCell className="clobe-import-account"><Picker label={`${bank.company_name} ${bank.name} 멀린 저장 계좌`} value={link?.account_id||'none'} onChange={value=>changeLink(key,{account_id:value==='none'?null:value})} options={mappingOptions}/></TableCell></TableRow>;})}</TableBody></Table></fieldset>
   {!banks.length&&<p className="clobe-empty">동기화할 원화 통장이 없습니다. 외화 통장은 위 잔액 조회에서 확인할 수 있습니다.</p>}
   <fieldset disabled={editLocked} className="clobe-import-controls"><DateRangeControl label="Clobe 가져오기 기간" value={range} onChange={changeRange} compact validateRange={value=>value.from<'1900-01-01'||value.to>'2100-12-31'?'1900년부터 2100년까지 조회할 수 있습니다.':''}/><span>{links.filter(link=>link.selected).length}개 통장 선택</span></fieldset>
   {!preview&&<div className="clobe-import-inspect"><p className="clobe-caption">{linkError||'선택한 기간의 신규 거래를 확인합니다.'}</p><Button type="button" disabled={busy||!!linkError||!banks.length} onClick={()=>void inspect()}>{loading?<LoaderCircle className="animate-spin" size={16}/>:<RefreshCw size={16}/>} {loading?'전체 통장 내역 확인 중…':'Clobe 동기화 미리보기'}</Button></div>}
  </div>
  {loading&&<div className="clobe-loading" role="status"><LoaderCircle size={20} className="animate-spin"/><span>선택한 {links.filter(link=>link.selected).length}개 통장의 {range.from} ~ {range.to} 전체 거래를 확인하고 있습니다. 모든 조회가 끝나면 분류할 내역이 표시됩니다.</span></div>}
  {error&&<div className="clobe-warning" role="alert"><TriangleAlert size={16}/><span>{error}</span></div>}
  {preview&&<>
   <div className="clobe-import-step"><div className="clobe-import-step-head"><h4>2. 신규 거래 계정과목 분류</h4><span>{preview.scope.start_date} ~ {preview.scope.end_date}</span></div>
    <div className="clobe-import-summary" aria-label={result?'실제 반영 결과':'반영 전 예상 결과'}>{[{label:'신규 추가',value:(result||preview.summary).inserted,tone:'positive'},{label:'기존 거래 유지',value:(result||preview.summary).unchanged+(result||preview.summary).referenced,tone:''},{label:'원본 중복',value:(result||preview.summary).sourceDuplicates,tone:''},{label:'확인 필요·보류',value:(result||preview.summary).blocked,tone:'negative'}].map(item=><div key={item.label}><span>{item.label}</span><strong className={item.tone}>{count(item.value)}</strong></div>)}</div>
    <p className="clobe-caption">{result?'실제 저장 결과입니다.':'저장 전 미리보기입니다.'} 기존 분류·메모 유지 · 멀린 분류 규칙 적용</p>
    <div className="clobe-import-filters"><div className="search-field"><Search size={16}/><Input aria-label="Clobe 미리보기 거래 검색" placeholder="사업자·거래처·적요 검색" value={search} onChange={event=>{setSearch(event.target.value);setPage(0);}}/></div><Picker label="Clobe 미리보기 거래 종류" value={kind} onChange={value=>{setKind(value);setPage(0);}} options={[{value:'insert',label:'신규 거래'},{value:'reference',label:'기존 분류 유지'},{value:'all',label:'반영 내역 전체'}]}/><span>{count(visibleRows.length)} 표시</span>{filteredNew.length>0&&<Button type="button" variant="outline" size="sm" disabled={editLocked} onClick={()=>toggleSelection(filteredNew.map(row=>row.key),true)}>{search.trim()?'검색 결과 신규':'신규'} {count(filteredNew.length)} 전체 분류 선택</Button>}</div>
    {selectedNew.length>0&&<div className="clobe-import-batch"><strong>선택한 신규 {count(selectedNew.length)}</strong><CategoryPicker label="선택한 Clobe 신규 거래 계정과목" value={batch} onChange={setBatch} categories={data.categories} aliases={data.aliases} disabled={editLocked}/><Button type="button" size="sm" disabled={editLocked||!batch} onClick={applyBatch}><CheckCheck size={16}/>선택 거래 분류</Button><Button type="button" size="sm" variant="ghost" disabled={editLocked} onClick={()=>setSelected(new Set())}>선택 해제</Button><p>선택한 신규 거래만 분류합니다.</p></div>}
    {paged.length?<Table><TableHeader><TableRow><TableHead><Checkbox aria-label="현재 페이지 신규 거래 전체 분류 선택" checked={selectablePage.length>0&&selectablePage.every(row=>selected.has(row.key))} disabled={editLocked||!selectablePage.length} onCheckedChange={value=>toggleSelection(selectablePage.map(row=>row.key),value===true)}/></TableHead><TableHead>날짜·저장 계좌</TableHead><TableHead>입출금</TableHead><TableHead>거래처·원본 적요</TableHead><TableHead>멀린 계정과목</TableHead><TableHead className="clobe-number">금액</TableHead><TableHead className="clobe-number">거래 후 잔액</TableHead></TableRow></TableHeader><TableBody>{paged.map(row=>{const categoryId=chosenClobeCategory(row,choices);return <TableRow key={row.key}><TableCell>{row.kind==='insert'?<Checkbox aria-label={`${row.txn_date} ${row.description} 분류 선택`} checked={selected.has(row.key)} disabled={editLocked} onCheckedChange={value=>toggleSelection([row.key],value===true)}/>:null}</TableCell><TableCell>{row.txn_date}<small className="cell-secondary">{row.txn_time||'시간 미확인'}</small><small className="cell-secondary clobe-import-account-label">{storedAccountLabel(row.account_id)}</small></TableCell><TableCell className={row.direction==='in'?'positive':'negative'}>{row.direction==='in'?'입금':'출금'}</TableCell><TableCell className="clobe-description">{row.source_details?.counterparty&&<strong>{row.source_details.counterparty}</strong>}<span>{row.description||'적요 없음'}</span>{row.source_details?.detail&&row.source_details.detail!==row.description&&<small className="cell-secondary">원본: {row.source_details.detail}</small>}{row.source_details?.memo&&<small className="cell-secondary">메모: {row.source_details.memo}</small>}</TableCell><TableCell className="clobe-import-category">{row.kind==='insert'?<CategoryPicker label={`${row.txn_date} ${row.description} 신규 거래 계정과목`} value={categoryId||''} onChange={value=>changeCategory(row.key,value)} categories={data.categories} aliases={data.aliases} disabled={editLocked}/>:<><strong>{data.categories.find(category=>category.id===row.category_id)?.name||'미분류'}</strong><small className="cell-secondary">기존 분류 유지</small></>}{row.kind==='insert'&&clobeImportNeedsCategoryReview(row,choices,data.categories)&&<small className="cell-secondary negative">분류를 선택해주세요</small>}</TableCell><TableCell className={`clobe-number ${row.direction==='in'?'positive':'negative'}`}>{clobeMoney(row.amount,'KRW')}</TableCell><TableCell className="clobe-number">{clobeMoney(row.balance,'KRW')}</TableCell></TableRow>;})}</TableBody></Table>:<p className="clobe-empty">{kind==='insert'?'새로 추가할 거래가 없습니다. 기존 거래는 유지합니다.':'조건에 맞는 반영 내역이 없습니다.'}</p>}
    <div className="clobe-pagination"><p>페이지 {currentPage+1} / {pages} · 적용 시 모든 신규 거래 저장</p><div><Button type="button" size="icon" variant="outline" aria-label="Clobe 미리보기 이전 페이지" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}><ChevronLeft size={16}/></Button><Button type="button" size="icon" variant="outline" aria-label="Clobe 미리보기 다음 페이지" disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}><ChevronRight size={16}/></Button></div></div>
    {blocked>0&&<div className="clobe-warning clobe-import-conflicts"><TriangleAlert size={16}/><div><strong>확인 필요 {count(blocked)}은 추가하지 않습니다.</strong><p>기존 거래와 대조되지 않거나 원본 금액이 달라 보류했습니다.</p><details><summary>보류 내역과 사유 보기</summary><ul>{preview.conflicts.slice(0,issueLimit).map((conflict,index)=><li key={`${conflict.external_transaction_id}:${index}`}><strong>{conflict.date} · {storedAccountLabel(conflict.account_id)}</strong><span>{conflict.message}</span></li>)}</ul>{preview.conflicts.length>issueLimit&&<Button type="button" size="sm" variant="outline" onClick={()=>setIssueLimit(limit=>limit+40)}>보류 다음 {Math.min(40,preview.conflicts.length-issueLimit)}건 보기</Button>}</details></div></div>}
   </div>
   <div className="clobe-import-step clobe-import-apply"><h4>3. 분류 확인 후 대시보드 적용</h4>
    {!result&&<><p>신규 {count(preview.summary.inserted)} 추가 · 기존 거래 연결 {count(preview.summary.referenced)} · 기존 거래 수정·삭제 0건</p>{unclassified>0&&<label className="clobe-import-consent"><Checkbox checked={allowUnclassified} disabled={editLocked} onCheckedChange={value=>setAllowUnclassified(value===true)}/><span>분류 확인이 필요한 신규 {count(unclassified)}은 미분류로 저장하고, 미분류 정리에서 나중에 분류</span></label>}{blocked>0&&<label className="clobe-import-consent"><Checkbox checked={allowPartial} disabled={editLocked} onCheckedChange={value=>setAllowPartial(value===true)}/><span>확인 필요 {count(blocked)}은 보류하고 표시된 정상 내역만 반영</span></label>}{expired&&!applyAttempted&&<p className="negative" role="status">미리보기의 유효 시간이 지났습니다. 통장·기간 다시 선택 후 새 미리보기를 확인해주세요.</p>}{applyAttempted&&!saving&&error&&<p className="clobe-caption">결과 재확인을 위해 통장과 분류 선택을 유지했습니다. 같은 적용 버튼을 누르면 중복 저장 없이 결과를 다시 확인합니다.</p>}<div className="clobe-import-inspect"><p className="clobe-caption">적용 후 모든 탭의 자료를 갱신합니다.</p><Button type="button" disabled={!canApply} onClick={()=>void apply()}>{saving?<LoaderCircle size={16} className="animate-spin"/>:<ArrowRight size={16}/>} {saving?'거래 저장·자료 갱신 중…':applyAttempted?'같은 적용 결과 다시 확인':'분류 확인 · 대시보드 적용'}</Button></div>{!hasChanges&&<p className="clobe-caption">새로 저장할 거래나 연결할 기존 거래가 없습니다.</p>}</>}
    {result&&<div className={refreshFailed?'clobe-warning':'clobe-notice'} role="status">{refreshFailed?<TriangleAlert size={19}/>:<CheckCircle2 size={19}/>}<div><strong>{refreshFailed?'거래 저장 완료 · 화면 자료 갱신 필요':'대시보드 반영 완료'}</strong><p>신규 추가 {count(result.inserted)} · 기존 유지 {count(result.unchanged+result.referenced)} · 보류 {count(result.blocked)} · 원본 중복 {count(result.sourceDuplicates)}</p><p>기존 거래·계정과목·메모는 유지했습니다.</p>{refreshFailed?<><p>거래를 다시 추가할 필요 없이 자료만 새로 불러오세요.</p><Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>void retryRefresh()}>{refreshing?<LoaderCircle className="animate-spin" size={15}/>:<RefreshCw size={15}/>}화면 자료 다시 불러오기</Button></>:<p>거래·잔액·분석 자료를 새로 불러왔습니다.</p>}</div></div>}
   </div>
  </>}
 </div>;
}
