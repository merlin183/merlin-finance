"use client";
import {FinancialText,useFinancialVisibility,FinancialValue} from './financial-visibility';


import {useEffect,useMemo,useRef,useState} from 'react';
import {Building2,CheckCircle2,Link2,LoaderCircle,RefreshCw,TriangleAlert} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import type {ClobeConnectionStatus} from '@/lib/clobe/connection';
import type {ClobeAccountsResponse,ClobeBankAccount,ClobeCompany,ClobeTransactionsResponse} from '@/lib/clobe/types';
import type {Dataset} from '@/lib/finance/types';
import type {ClobeDashboardSyncCompletion} from '@/lib/finance/clobe-dashboard-sync-client';
import type {DateRange} from '@/lib/finance/date-range';
import {clobeSyncRange} from '@/lib/finance/clobe-sync-range';
import {Panel,Picker} from './common';
import {DateRangeControl} from './date-range-control';
import {clobeAuthorizationUrl,clobeCollectedAt,clobeMoney,clobePanelRequest,createClobeRequestGate,matchesClobeQuery,mergeClobeRows} from './clobe-panel-model';
import {ClobeImportPanel} from './clobe-import-panel';
import {ClobeDashboardSyncButton,useClobeDashboardSync} from './use-clobe-dashboard-sync';
import './clobe-panel.css';

type QueryResult=ClobeTransactionsResponse;
const errorText=(cause:unknown)=>cause instanceof Error?cause.message:'Clobe 조회를 완료하지 못했습니다. 다시 시도해주세요.';
const accountLabel=(account:ClobeBankAccount)=>[account.bankName,account.name,account.maskedNumber,account.currency,account.isHidden?'숨김 계좌':''].filter(Boolean).join(' · ');
const companyWarning=(company:ClobeCompany)=>company.error||company.scraping.error||(company.scraping.status==='IN_PROGRESS'?'은행 자료 수집 중입니다. 수집 완료 전 자료일 수 있습니다.':!company.scraping.lastCollectedAt?'은행 자료 수집 시각을 확인하지 못했습니다.':null);

export function ClobePanel({data,refresh}:{data?:Dataset;refresh?:()=>Promise<void>}={}){
 const {privateText}=useFinancialVisibility();
 const [status,setStatus]=useState<ClobeConnectionStatus|null>(null);
 const [statusLoading,setStatusLoading]=useState(true),[statusError,setStatusError]=useState('');
 const [connecting,setConnecting]=useState(false),[callback,setCallback]=useState('');
 const [accounts,setAccounts]=useState<ClobeAccountsResponse|null>(null);
 const [accountsLoading,setAccountsLoading]=useState(false),[accountsError,setAccountsError]=useState('');
 const sync=useClobeDashboardSync(),syncLoading=sync?.busy??false;
 const observedSyncResult=useRef<ClobeDashboardSyncCompletion|null>(null);
 const [companyId,setCompanyId]=useState(''),[accountId,setAccountId]=useState('');
 const [range,setRange]=useState<DateRange>(()=>{const {from,to}=clobeSyncRange();return {from,to};});
 const [result,setResult]=useState<QueryResult|null>(null);
 const [queryLoading,setQueryLoading]=useState(false),[loadingMore,setLoadingMore]=useState(false),[queryError,setQueryError]=useState('');
 const statusGate=useRef(createClobeRequestGate()),accountsGate=useRef(createClobeRequestGate()),queryGate=useRef(createClobeRequestGate());
 const accountBusy=useRef(false),connectBusy=useRef(false),queryBusy=useRef(false);
 const company=accounts?.companies.find(item=>item.id===companyId);
 const account=company?.accounts.find(item=>String(item.id)===accountId);
 const accountsVisible=accounts!==null;
 const warnings=useMemo(()=>accounts?.companies.flatMap(item=>{const warning=companyWarning(item);return warning?[`${item.name}: ${warning}`]:[];})||[],[accounts]);

 function clearQuery(){queryGate.current.cancel();queryBusy.current=false;setResult(null);setQueryError('');setQueryLoading(false);setLoadingMore(false);}
 async function loadStatus(){
  const request=statusGate.current.begin();setStatusLoading(true);setStatusError('');
  try{
   const value=await clobePanelRequest<ClobeConnectionStatus>('/api/clobe/status',{signal:request.signal});
   if(!statusGate.current.current(request.version))return;
   setStatus(value);
   if(!value.connected){accountsGate.current.cancel();accountBusy.current=false;setAccountsLoading(false);setAccounts(null);clearQuery();}
  }catch(cause){if(statusGate.current.current(request.version))setStatusError(errorText(cause));}
  finally{if(statusGate.current.current(request.version))setStatusLoading(false);}
 }
 useEffect(()=>{
  let active=true;
  const mountedStatusGate=statusGate.current,mountedAccountsGate=accountsGate.current,mountedQueryGate=queryGate.current;
  void Promise.resolve().then(()=>{
   if(!active)return;
   const callbackValue=new URLSearchParams(window.location.search).get('clobe');
   if(callbackValue==='connected'||callbackValue==='error')setCallback(callbackValue);
   void loadStatus();
  });
  return()=>{active=false;mountedStatusGate.cancel();mountedAccountsGate.cancel();mountedQueryGate.cancel();};
  // Fetch once when this upload panel mounts; retries are explicit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);

 const completedSync=sync?.snapshot.result,completedSyncPhase=sync?.snapshot.phase;
 useEffect(()=>{
  if(!completedSync||(completedSyncPhase!=='done'&&completedSyncPhase!=='refresh-needed')||observedSyncResult.current===completedSync)return;
  observedSyncResult.current=completedSync;
  if(!accountsVisible)return;
  // The shared dataset refresh cannot update this optional provider preview.
  // Re-read it without remounting the import form or discarding its choices.
  const request=accountsGate.current.begin();accountBusy.current=true;
  void clobePanelRequest<ClobeAccountsResponse>('/api/clobe/accounts',{signal:request.signal}).then(value=>{
   if(accountsGate.current.current(request.version)){setAccounts(value);setAccountsError('');}
  }).catch(cause=>{
   if(accountsGate.current.current(request.version))setAccountsError(`대시보드 동기화 결과와 별도로 통장 조회 표를 갱신하지 못했습니다. ${errorText(cause)}`);
  }).finally(()=>{if(accountsGate.current.current(request.version)){accountBusy.current=false;setAccountsLoading(false);}});
 },[completedSync,completedSyncPhase,accountsVisible]);

 async function connect(){
  if(connectBusy.current)return;connectBusy.current=true;setConnecting(true);setStatusError('');
  const request=statusGate.current.begin();
  try{
   const value=await clobePanelRequest<{authorizationUrl:string}>('/api/clobe/connect',{method:'POST',signal:request.signal});
   if(!statusGate.current.current(request.version))return;
   const url=clobeAuthorizationUrl(value.authorizationUrl);
   if(!url)throw Error('Clobe 연결 주소를 확인하지 못했습니다. 다시 연결해주세요.');
   window.location.assign(url);
  }catch(cause){if(statusGate.current.current(request.version))setStatusError(errorText(cause));}
  finally{connectBusy.current=false;if(statusGate.current.current(request.version))setConnecting(false);}
 }
 async function loadAccounts(){
  if(accountBusy.current||syncLoading)return;accountBusy.current=true;
  const request=accountsGate.current.begin();clearQuery();setAccounts(null);setAccountsLoading(true);setAccountsError('');
  try{
   const value=await clobePanelRequest<ClobeAccountsResponse>('/api/clobe/accounts',{signal:request.signal});
   if(!accountsGate.current.current(request.version))return;
   const selected=value.companies.find(item=>item.id===companyId&&item.accounts.length)||value.companies.find(item=>item.accounts.length);
   const selectedAccount=selected?.accounts.find(item=>String(item.id)===accountId)||selected?.accounts.find(item=>item.currency==='KRW')||selected?.accounts[0];
   setAccounts(value);setCompanyId(selected?.id||'');setAccountId(selectedAccount?String(selectedAccount.id):'');
  }catch(cause){if(accountsGate.current.current(request.version))setAccountsError(errorText(cause));}
  finally{if(accountsGate.current.current(request.version)){accountBusy.current=false;setAccountsLoading(false);}}
 }
 function selectCompany(value:string){clearQuery();setCompanyId(value);const bankAccounts=accounts?.companies.find(item=>item.id===value)?.accounts;setAccountId(String((bankAccounts?.find(item=>item.currency==='KRW')||bankAccounts?.[0])?.id||''));}
 function selectAccount(value:string){clearQuery();setAccountId(value);}
 function selectFromOverview(business:string,bankAccount:string){clearQuery();setCompanyId(business);setAccountId(bankAccount);}
 function selectRange(value:DateRange){clearQuery();setRange(value);}
 async function loadTransactions(more=false){
  if(!account||account.currency!=='KRW'||!company||queryBusy.current)return;
  const cursor=more?result?.nextCursor:undefined;
  if(more&&(!result?.hasNext||!cursor))return;
  queryBusy.current=true;const request=queryGate.current.begin();
  const scope={companyId:company.id,bankAccountId:account.id,startDate:range.from,endDate:range.to};
  setQueryError('');setQueryLoading(!more);setLoadingMore(more);if(!more)setResult(null);
  try{
   const value=await clobePanelRequest<ClobeTransactionsResponse>('/api/clobe/transactions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,...(cursor?{cursor}:{}),size:100}),signal:request.signal});
   if(!queryGate.current.current(request.version))return;
   if(!matchesClobeQuery(value,scope))throw Error('선택한 통장의 조회 결과가 일치하지 않습니다. 다시 조회해주세요.');
   if(value.hasNext&&(!value.nextCursor||value.nextCursor===cursor))throw Error('다음 거래의 조회 위치를 확인하지 못했습니다. 다시 조회해주세요.');
   setResult(current=>({...value,rows:mergeClobeRows(more?current?.rows||[]:[],value.rows)}));
  }catch(cause){if(queryGate.current.current(request.version))setQueryError(errorText(cause));}
  finally{if(queryGate.current.current(request.version)){queryBusy.current=false;setQueryLoading(false);setLoadingMore(false);}}
 }
 const authBusy=statusLoading||connecting;
 const needsReconnect=status?.state==='reconnect_required';
 const connectionPending=status?.state==='connecting'||status?.state==='refreshing';
 const ready=status?.connected&&!connectionPending;
 const connectLabel=connecting?'Clobe 연결 화면 여는 중…':needsReconnect?'Clobe 다시 연결':'Clobe 연결';

 return <Panel title="Clobe 은행" subtitle="최근 2개월 거래 · 현재 잔액" className="clobe-panel" action={<div className="clobe-header-actions">
  {authBusy?<Button type="button" variant="outline" disabled><LoaderCircle size={16} className="animate-spin"/>{connecting?connectLabel:'연결 확인 중…'}</Button>:ready?<>{data&&refresh&&<ClobeDashboardSyncButton disabled={accountsLoading} showStatus/>}<Button type="button" variant="outline" disabled={accountsLoading||syncLoading} onClick={()=>void loadAccounts()}>{accountsLoading?<LoaderCircle size={16} className="animate-spin"/>:<RefreshCw size={16}/>} {accountsLoading?'통장 조회 중…':'통장·거래 조회'}</Button></>:status?.configured&&!connectionPending?<Button type="button" onClick={()=>void connect()}><Link2 size={16}/>{connectLabel}</Button>:<Button type="button" variant="outline" onClick={()=>void loadStatus()}><RefreshCw size={16}/>연결 상태 다시 확인</Button>}
 </div>}>
  <div className="clobe-connection-line" aria-live="polite">
   <span className={`clobe-state ${ready?'clobe-state-connected':''}`}>{ready?<CheckCircle2 size={14}/>:<Link2 size={14}/>} {statusLoading?'연결 상태 확인 중':ready?'Clobe 연결됨':status?.configured===false?'연결 준비 필요':connectionPending?'연결 처리 중':needsReconnect?'인증 갱신 필요':'Clobe 연결 필요'}</span>
   <p>{data&&refresh?'전체 사업자 동기화 · 기존 분류·메모 유지 · 미확인 거래는 미분류':'Clobe의 마지막 수집 자료를 조회합니다.'}</p>
  </div>
  {status?.configured===false&&<p className="clobe-muted">대시보드의 Clobe 연결 준비가 필요합니다. 준비가 끝난 후 연결 상태를 다시 확인해주세요.</p>}
  {callback==='connected'&&ready&&<p className="clobe-notice" role="status"><CheckCircle2 size={16}/>연결 완료 · ‘Clobe 최신 동기화’로 거래와 잔액을 반영하세요.</p>}
  {callback==='error'&&<p className="clobe-warning" role="alert"><TriangleAlert size={16}/>연결 승인을 완료하지 못했습니다. Clobe 연결을 다시 진행해주세요.</p>}
  {(statusError||status?.error)&&<div className="clobe-warning" role="alert"><TriangleAlert size={16}/><span><FinancialText value={String((statusError||status?.error)||'')}/></span><Button type="button" size="sm" variant="outline" disabled={authBusy} onClick={()=>void loadStatus()}>다시 확인</Button></div>}
  {ready&&<div className="clobe-auth-actions"><Button type="button" variant="ghost" size="sm" disabled={authBusy} onClick={()=>void connect()}>연결 계정 변경</Button></div>}
  {accountsLoading&&<div className="clobe-loading" role="status"><LoaderCircle size={20} className="animate-spin"/><strong>사업자별 통장 조회 중…</strong></div>}
  {accountsError&&<div className="clobe-warning" role="alert"><TriangleAlert size={16}/><span><FinancialText value={accountsError}/></span><Button type="button" size="sm" variant="outline" onClick={()=>void loadAccounts()}>다시 조회</Button></div>}
  {accounts&&<>
   <div className="clobe-section-heading"><h3><Building2 size={16}/>사업자·통장별 잔액</h3><span>조회 {clobeCollectedAt(accounts.fetchedAt)}</span></div>
   {warnings.length>0&&<div className="clobe-warning" role="alert"><TriangleAlert size={16}/><div><strong>일부 자료를 확인해주세요.</strong><ul>{warnings.map(warning=><li key={warning}><FinancialText value={String((warning)||'')}/></li>)}</ul></div></div>}
   <div className="clobe-account-table"><Table><TableHeader><TableRow><TableHead>사업자</TableHead><TableHead>은행·계좌</TableHead><TableHead className="clobe-number">마지막 수집 잔액</TableHead><TableHead>은행 자료 수집 시각</TableHead></TableRow></TableHeader><TableBody>
    {accounts.companies.map(item=>item.accounts.length?item.accounts.map(bankAccount=><TableRow key={`${item.id}:${bankAccount.id}`} data-selected={item.id===companyId&&String(bankAccount.id)===accountId}><TableCell>{item.name}</TableCell><TableCell><button type="button" className="clobe-account-select" onClick={()=>selectFromOverview(item.id,String(bankAccount.id))} aria-label={privateText(String(`${item.name} ${accountLabel(bankAccount)} 거래 조회 선택`))}><FinancialText value={String((accountLabel(bankAccount))||'')}/></button></TableCell><TableCell className="clobe-number"><FinancialValue value={clobeMoney(bankAccount.balance,bankAccount.currency)}/></TableCell><TableCell>{clobeCollectedAt(item.scraping.lastCollectedAt)}{item.scraping.error&&<small className="cell-secondary negative">수집 상태 확인 필요</small>}</TableCell></TableRow>):<TableRow key={item.id}><TableCell>{item.name}</TableCell><TableCell colSpan={3}><FinancialText value={String(item.error?'통장 조회 실패':'조회 가능한 통장이 없습니다.')}/></TableCell></TableRow>)}
   </TableBody></Table></div>
   {!accounts.companies.length&&<p className="clobe-empty">Clobe에서 조회 가능한 사업자를 찾지 못했습니다. 연결한 Clobe 계정의 사업자 접근 권한을 확인해주세요.</p>}
   <p className="clobe-caption">Clobe 마지막 수집 기준 · 오래된 자료는 Clobe에서 재수집 · 외화 별도</p>
   {accounts.companies.some(item=>item.accounts.length)&&<>
    <div className="clobe-query-controls"><div><label>사업자</label><Picker label="Clobe 조회 사업자" value={companyId} onChange={selectCompany} options={accounts.companies.map(item=>({value:item.id,label:item.name}))}/></div><div className="clobe-account-control"><label>통장</label><Picker label="Clobe 조회 통장" value={accountId} onChange={selectAccount} options={company?.accounts.map(item=>({value:String(item.id),label:accountLabel(item)}))||[]}/></div><DateRangeControl label="Clobe 거래 조회" value={range} onChange={selectRange} compact validateRange={value=>value.from<'1900-01-01'||value.to>'2100-12-31'?'1900년부터 2100년까지 조회할 수 있습니다.':''}/><Button type="button" disabled={!account||account.currency!=='KRW'||queryLoading||loadingMore} onClick={()=>void loadTransactions()}>{queryLoading?<LoaderCircle size={16} className="animate-spin"/>:<RefreshCw size={16}/>} {queryLoading?'거래 조회 중…':'선택한 통장 거래 조회'}</Button></div>
    {account&&<p className="clobe-selection"><strong>{company?.name} · <FinancialText value={String((accountLabel(account))||'')}/></strong><span>잔액 <FinancialValue value={clobeMoney(account.balance,account.currency)}/></span></p>}
    {account&&account.currency!=='KRW'&&<p className="clobe-muted" role="status">외화 통장은 잔액만 조회할 수 있습니다. 거래 내역은 원화 통장을 선택해주세요.</p>}
    {queryLoading&&<div className="clobe-loading" role="status"><LoaderCircle size={20} className="animate-spin"/><span>{range.from} ~ {range.to} 거래를 조회하고 있습니다.</span></div>}
    {queryError&&<div className="clobe-warning" role="alert"><TriangleAlert size={16}/><span><FinancialText value={String((queryError)||'')}/></span><Button type="button" size="sm" variant="outline" onClick={()=>void loadTransactions(!!result)}>다시 조회</Button></div>}
    {result&&<div className="clobe-transactions" aria-live="polite">
     <div className="clobe-section-heading"><h3>조회 거래 · {result.startDate} ~ {result.endDate}</h3><span>수집 {clobeCollectedAt(result.scraping.lastCollectedAt)}</span></div>
     {result.scraping.error&&<p className="clobe-warning" role="alert"><TriangleAlert size={16}/><FinancialText value={String((result.scraping.error)||'')}/></p>}
     {account?.currency==='KRW'&&result.inAmountSum!==null&&result.outAmountSum!==null&&<div className="clobe-totals"><span>조회 기간 전체 합계</span><p>입금 <strong className="positive"><FinancialValue value={clobeMoney(result.inAmountSum,'KRW')}/></strong></p><p>출금 <strong className="negative"><FinancialValue value={clobeMoney(result.outAmountSum,'KRW')}/></strong></p></div>}
     {result.rows.length?<Table><TableHeader><TableRow><TableHead>거래일시</TableHead><TableHead>구분</TableHead><TableHead>거래처·적요</TableHead><TableHead>Clobe 계정과목</TableHead><TableHead className="clobe-number">금액</TableHead><TableHead className="clobe-number">거래 후 잔액</TableHead></TableRow></TableHeader><TableBody>{result.rows.map(row=><TableRow key={row.id}><TableCell>{row.date}<small className="cell-secondary">{row.time||'시간 미확인'}</small></TableCell><TableCell><span className={row.direction==='in'?'direction-badge positive':'direction-badge negative'}>{row.direction==='in'?'입금':'출금'}</span></TableCell><TableCell className="clobe-description">{row.party&&<strong><FinancialText value={String((row.party)||'')}/></strong>}<span><FinancialText value={String((row.description||'적요 없음')||'')}/></span>{row.memo&&<small className="cell-secondary">메모: <FinancialText value={String((row.memo)||'')}/></small>}</TableCell><TableCell>{row.category||'미분류'}</TableCell><TableCell className={`clobe-number ${row.direction==='in'?'positive':'negative'}`}><FinancialValue value={clobeMoney(row.amount,row.currency)}/></TableCell><TableCell className="clobe-number"><FinancialValue value={clobeMoney(row.balance,row.currency)}/></TableCell></TableRow>)}</TableBody></Table>:<p className="clobe-empty">선택한 통장에 {result.startDate} ~ {result.endDate} 거래가 없습니다.</p>}
     <div className="clobe-pagination"><p>{result.rows.length.toLocaleString('ko-KR')}{result.totalElements===null?'건 표시 · 전체 건수 미확인':` / ${result.totalElements.toLocaleString('ko-KR')}건 표시`} · 조회 결과 · 거래 저장 없음</p>{result.hasNext&&<Button type="button" variant="outline" disabled={loadingMore} onClick={()=>void loadTransactions(true)}>{loadingMore&&<LoaderCircle size={15} className="animate-spin"/>}{loadingMore?'다음 거래 조회 중…':'다음 거래 더 보기'}</Button>}</div>
    </div>}
   </>}
   {data&&refresh&&<ClobeImportPanel accounts={accounts} data={data} refresh={refresh}/>}
  </>}
 </Panel>;
}
