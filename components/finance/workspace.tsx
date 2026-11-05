"use client";
import {useCallback,useEffect,useMemo,useRef,useState,useTransition,useSyncExternalStore,type ReactNode} from 'react';
import dynamic from 'next/dynamic';
import {usePathname,useRouter,useSearchParams} from 'next/navigation';
import {ChartNoAxesCombined,LayoutDashboard,ArrowLeftRight,Wallet,Layers3,Upload,Settings2,LogOut,ChevronRight,CalendarDays,Sun,Moon,RefreshCw,Printer,Building2,FileChartColumn} from 'lucide-react';
import {Sidebar,SidebarProvider,SidebarHeader,SidebarContent,SidebarFooter,SidebarMenu,SidebarMenuItem,SidebarMenuButton,SidebarGroup,SidebarInset,SidebarTrigger} from '@/components/ui/sidebar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Skeleton} from '@/components/ui/skeleton';
import {Toaster} from '@/components/ui/sonner';
import {toast} from 'sonner';
import {emptyDataset,type Dataset} from '@/lib/finance/types';
import {today} from '@/lib/finance/format';
import {businessHref,financeView,navigateAfterSave,isClientFinanceNavigation} from '@/app/(finance)/routes';
import {createDatasetUpdates,mergeClassificationResult,mergeFixedCostResult} from '@/lib/finance/dataset-updates';
import {createDatasetRefreshCoordinator} from '@/lib/finance/dataset-refresh';
import {subscribeDatasetChanges} from '@/lib/finance/dataset-change-signal';
import {createVisibleDatasetInvalidation} from '@/lib/finance/visible-dataset-invalidation';
import {withDatasetReadLock} from '@/lib/finance/dataset-read-lock';
import type {ClassificationResult} from '@/lib/finance/classification-result';
import type {FixedCostForwardRequest,FixedCostSaveResult} from '@/lib/finance/cash-plan-series-forward';
import {FixedCostRequestError} from '@/lib/finance/cash-plan-fixed-request';
import {createClassificationQueue} from '@/lib/finance/classification-queue';
import {FinanceLink,FinanceNavigationProvider,Picker,api,action,type FinanceNavigate} from './common';
import {useMerchantNotes} from './merchant-note';
import {DateRangeControl} from './date-range-control';
import {dateRangeBounds,isValidDateRange} from '@/lib/finance/date-range';
import {calendarMonthRange} from '@/lib/finance/transaction-calendar';
import {TaxPaymentAlert} from './tax-payment-alert';
import {useCashPlanEdits} from './use-cash-plan-edits';
import {useCashPlanPeriod} from './use-cash-plan-period';
import {ClobeDashboardSyncButton,ClobeDashboardSyncProvider} from './use-clobe-dashboard-sync';
import {clobeDashboardSyncCoordinator} from '@/lib/finance/clobe-dashboard-sync-client';
import './clobe-dashboard-sync.css';

function subscribeTheme(onChange:()=>void){window.addEventListener('storage',onChange);window.addEventListener('finance-theme',onChange);return()=>{window.removeEventListener('storage',onChange);window.removeEventListener('finance-theme',onChange);};}
const themeSnapshot=()=>localStorage.getItem('finance-theme')==='dark';
function ViewLoading(){return <div role="status" aria-label="화면 불러오는 중"><p className="mb-4 text-sm text-muted-foreground">화면을 불러오는 중…</p><div className="kpi-grid">{[1,2,3,4].map(n=><Skeleton key={n} className="h-36 rounded-xl"/>)}</div></div>;}
const Dashboard=dynamic(()=>import('./dashboard').then(module=>module.Dashboard),{loading:ViewLoading});
const Transactions=dynamic(()=>import('./transactions').then(module=>module.Transactions),{loading:ViewLoading});
const ClassificationReview=dynamic(()=>import('./classification-review').then(module=>module.ClassificationReview),{loading:ViewLoading});
const UploadView=dynamic(()=>import('./upload').then(module=>module.UploadView),{loading:ViewLoading});
const SettingsView=dynamic(()=>import('./settings').then(module=>module.SettingsView),{loading:ViewLoading});
const CashView=dynamic(()=>import('./cash').then(module=>module.CashView),{loading:ViewLoading});
const MonthlyReportView=dynamic(()=>import('./monthly-report').then(module=>module.MonthlyReportView),{loading:ViewLoading});
function preloadView(view:string|null){
 const pending=view==='overview'||view==='consolidated'?import('./dashboard'):view==='transactions'?import('./transactions'):view==='classification'?import('./classification-review'):view==='upload'?import('./upload'):view==='cash-utilization'?import('./cash'):view==='monthly-report'?import('./monthly-report'):view?.startsWith('settings')?import('./settings'):null;
 void pending?.catch(()=>{});
}
const navigation=[{href:'/',key:'overview',label:'자금 현황',icon:LayoutDashboard},{href:'/consolidated',key:'consolidated',label:'통합 분석',icon:Layers3},{href:'/cash-utilization',key:'cash-utilization',label:'가용자금 계획',icon:Wallet},{href:'/monthly-report',key:'monthly-report',label:'월간 보고',icon:FileChartColumn},{href:'/transactions',key:'transactions',label:'거래 내역',icon:ArrowLeftRight},{href:'/classification',key:'classification',label:'미분류 정리',icon:Layers3},{href:'/upload',key:'upload',label:'거래 업로드',icon:Upload},{href:'/settings',key:'settings',label:'설정',icon:Settings2}];
export function FinanceApp({email,userId,url,apiKey,children}:{email:string;userId:string;url:string;apiKey:string;children:ReactNode}){
 const router=useRouter(),pathname=usePathname(),query=useSearchParams();
 const view=financeView(pathname),biz=query.get('biz')||'all',now=today();
 const cashPlanEdits=useCashPlanEdits(),cashPlanPeriod=useCashPlanPeriod();
 useEffect(()=>{preloadView(view);},[view]);
 const [from,setFrom]=useState(now.slice(0,7)+'-01'),[to,setTo]=useState(now),[period,setPeriod]=useState('month');
 const [transactionView,setTransactionView]=useState<'table'|'calendar'>('table');
 const [data,setData]=useState<Dataset>(emptyDataset),[loading,setLoading]=useState(true),[refreshing,setRefreshing]=useState(false),[error,setError]=useState('');
 const [datasetUpdates]=useState(createDatasetUpdates);
 const [refreshCoordinator]=useState(createDatasetRefreshCoordinator);
 const [classificationQueue]=useState(createClassificationQueue);
 const dark=useSyncExternalStore(subscribeTheme,themeSnapshot,()=>false);
 const [setup,setSetup]=useState(false),[sessionInvalid,setSessionInvalid]=useState(false);
 const [savingBeforeNavigation,setSavingBeforeNavigation]=useState(false),[transitionPending,startTransition]=useTransition();
 const notes=useMerchantNotes(data.notes),notesRef=useRef(notes);
 useEffect(()=>{notesRef.current=notes;},[notes]);
 const flushPending=useCallback(async()=>{await Promise.all([notesRef.current.flush(),classificationQueue.flush()]);},[classificationQueue]);
 useEffect(()=>{
  const guard=(event:BeforeUnloadEvent)=>{if(classificationQueue.hasPending())event.preventDefault();};
  window.addEventListener('beforeunload',guard);
  return()=>window.removeEventListener('beforeunload',guard);
 },[classificationQueue]);
 const mounted=useRef(true),sessionActive=useRef(true),lastLoadedAt=useRef(0),navigationSequence=useRef(0);
 const invalidateSession=useCallback((destination='/login')=>{
  sessionActive.current=false;clobeDashboardSyncCoordinator.reset();setData(emptyDataset);setSessionInvalid(true);
  // A document navigation discards the router cache and every in-memory draft.
  window.location.replace(destination);
 },[]);
 const readDataset=useCallback(()=>withDatasetReadLock(async()=>{
  // A queued read may outlive its original login or mounted workspace.
  if(!mounted.current||!sessionActive.current)return;
  // An initial read retry still has no verified dataset. Keep onboarding
  // hidden until that read succeeds; ordinary refreshes retain loaded views.
  if(lastLoadedAt.current===0)setLoading(true);
  setError('');setRefreshing(true);
  const read=datasetUpdates.beginRead();
   try{
    const response=await fetch('/api/data',{cache:'no-store',signal:AbortSignal.timeout(65000)});
    if(!mounted.current||!sessionActive.current)return;
    if(response.status===401||response.status===403){invalidateSession();return;}
    const result=await response.json() as Dataset&{error?:string};
    if(!response.ok)throw Error(result.error||'자료를 불러오지 못했습니다.');
    if(mounted.current&&sessionActive.current){setData(read.apply(result));lastLoadedAt.current=Date.now();}
   }catch(cause){
    const failure=cause instanceof Error?cause:new Error('자료를 불러오지 못했습니다.');
    if(mounted.current&&sessionActive.current)setError(failure.message);
    throw failure;
   }
   finally{read.finish();if(mounted.current){setLoading(false);setRefreshing(false);}}
 }),[invalidateSession,datasetUpdates]);
 const refresh=useCallback(()=>refreshCoordinator.refresh(readDataset),[refreshCoordinator,readDataset]);
 // A mutation may finish while an older read is still in flight. Its caller
 // must wait for that snapshot and then request one that includes the change.
 const refreshAfterChange=useCallback(()=>refreshCoordinator.afterChange(readDataset),[refreshCoordinator,readDataset]);
 const classificationApplied=useCallback(async(result:ClassificationResult)=>{
  if(!mounted.current||!sessionActive.current)return;
  if(result.transactions){
   const update=(current:Dataset)=>mergeClassificationResult(current,result);
   datasetUpdates.record(update);setData(update);
  }
  if(result.needsRefresh||!result.transactions){
   try{await refreshAfterChange();}
   catch{toast.warning('분류 저장은 완료됐습니다. 자료 새로고침으로 최신 내역을 다시 확인해주세요.');}
  }
 },[datasetUpdates,refreshAfterChange]);
 const fixedCostsApplied=useCallback((result:FixedCostSaveResult)=>{
  if(!mounted.current||!sessionActive.current)return;
  const update=(current:Dataset)=>mergeFixedCostResult(current,result);
  datasetUpdates.record(update);setData(update);
 },[datasetUpdates]);
 const saveSharedFixedCosts=cashPlanEdits.saveFixedCosts;
 const saveFixedCosts=useCallback(async(request:FixedCostForwardRequest)=>{
  try{return await saveSharedFixedCosts(request,fixedCostsApplied);}
  catch(cause){
   if(cause instanceof FixedCostRequestError&&cause.status===409){
    try{await refreshAfterChange();}catch{toast.warning('입력은 유지했습니다. 자료 새로고침으로 최신 반복 계획을 확인해주세요.');}
   }
   throw cause;
  }
 },[saveSharedFixedCosts,fixedCostsApplied,refreshAfterChange]);
 const navigate:FinanceNavigate=useCallback(async(href,options)=>{
  const sequence=++navigationSequence.current;setSavingBeforeNavigation(notesRef.current.hasUnsaved()||classificationQueue.hasPending());
  try{await navigateAfterSave(flushPending,()=>startTransition(()=>{
   if(isClientFinanceNavigation(pathname,href)){
    preloadView(financeView(new URL(href,window.location.origin).pathname));
    window.history.pushState(null,'',href);
    if(!options?.shallow&&options?.scroll!==false)window.scrollTo({top:0});
   }
   else router.push(href,{scroll:options?.scroll});
  }),()=>sequence===navigationSequence.current&&sessionActive.current);}
  catch(cause){toast.error(cause instanceof Error?cause.message:'변경사항을 저장한 뒤 다시 이동해주세요.');}
  finally{if(sequence===navigationSequence.current)setSavingBeforeNavigation(false);}
 },[router,pathname,classificationQueue,flushPending]);
 useEffect(()=>{
  mounted.current=true;void refresh().catch(()=>{});
  return()=>{mounted.current=false;};
 },[refresh]);
 useEffect(()=>{document.documentElement.classList.toggle('dark',dark);},[dark]);
 useEffect(()=>{
  let active=true,unsubscribe:(()=>void)|undefined;
  void import('@/lib/supabase/client').then(({browserClient})=>{
   if(!active)return;
   const {data:{subscription}}=browserClient(url,apiKey).auth.onAuthStateChange((event,session)=>{
    if(event==='SIGNED_OUT'||event==='INITIAL_SESSION'&&!session)invalidateSession();
    else if(session&&session.user.id!==userId)invalidateSession('/');
   });
   unsubscribe=()=>subscription.unsubscribe();
  }).catch(()=>{});
  const unauthorized=()=>invalidateSession();window.addEventListener('finance-auth-invalid',unauthorized);
  return()=>{active=false;unsubscribe?.();window.removeEventListener('finance-auth-invalid',unauthorized);};
 },[url,apiKey,userId,invalidateSession]);
 useEffect(()=>{
  const invalidation=createVisibleDatasetInvalidation({
   isVisible:()=>document.visibilityState==='visible'&&mounted.current&&sessionActive.current,
   refreshAfterChange,
  });
  const unsubscribe=subscribeDatasetChanges(()=>{void invalidation.invalidate();});
  const resume=()=>{
   if(document.visibilityState!=='visible'||invalidation.resume())return;
   if(Date.now()-lastLoadedAt.current>5*60*1000)void action(async()=>{await flushPending();await refresh();});
  };
  const backOrForward=()=>{++navigationSequence.current;setSavingBeforeNavigation(false);void action(flushPending);};
  const restore=(event:PageTransitionEvent)=>{if(event.persisted){setData(emptyDataset);setLoading(true);void refresh().catch(()=>{});}};
  window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);window.addEventListener('popstate',backOrForward);window.addEventListener('pageshow',restore);
  return()=>{invalidation.dispose();unsubscribe();window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);window.removeEventListener('popstate',backOrForward);window.removeEventListener('pageshow',restore);};
 },[refresh,refreshAfterChange,flushPending]);
 const viewTaxDate=(date:string)=>{cashPlanPeriod.applyRange(calendarMonthRange(date.slice(0,7)));void navigate('/cash-utilization?biz='+encodeURIComponent(biz)+'&tax_due='+encodeURIComponent(date));};
 const changeBiz=(value:string)=>{void navigate(businessHref(pathname,query.toString(),value),{shallow:true});};
 const selected=data.businesses.find(b=>b.id===biz),title=view?.startsWith('settings')?'설정':navigation.find(n=>n.key===view)?.label||'자금 현황';
 const analysisBounds=useMemo(()=>dateRangeBounds(data.transactions,now),[data.transactions,now]);
 const tx=useMemo(()=>data.transactions.filter(t=>(biz==='all'||t.business_id===biz)&&t.txn_date>=from&&t.txn_date<=to),[data.transactions,biz,from,to]);
 function setRange(value:string){setPeriod(value);const d=new Date(now+'T00:00:00Z');if(value==='month')setFrom(now.slice(0,7)+'-01');if(value==='quarter')setFrom(`${d.getUTCFullYear()}-${String(Math.floor(d.getUTCMonth()/3)*3+1).padStart(2,'0')}-01`);if(value==='year')setFrom(now.slice(0,4)+'-01-01');if(value==='all')setFrom(data.transactions.reduce((min,t)=>t.txn_date<min?t.txn_date:min,now));setTo(now)}
useEffect(()=>{const ctx=(document as Document & {modelContext?:{registerTool:(tool:unknown,opts:{signal:AbortSignal})=>Promise<void>}}).modelContext;if(!ctx)return;const lifecycle=new AbortController();void Promise.resolve(ctx.registerTool({name:'read_finance_summary',description:'현재 화면에 선택된 사업자와 기간의 거래 건수, 유입·유출을 읽습니다.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:(input:unknown)=>{if(input===null||typeof input!=='object'||Object.keys(input).length)throw Error('빈 객체를 입력하세요.');return {business:selected?.name||'전체 통합',from,to,count:tx.length,income:tx.filter(t=>t.direction==='in').reduce((s,t)=>s+t.amount,0),expense:tx.filter(t=>t.direction==='out').reduce((s,t)=>s+t.amount,0)}}},{signal:lifecycle.signal})).catch(()=>{});return()=>lifecycle.abort()},[tx,selected,from,to]);
if(sessionInvalid)return <main className="min-h-screen flex items-center justify-center"><p role="status">로그인 화면으로 이동하고 있습니다…</p></main>;
if(!view)return <>{children}</>;
return <FinanceNavigationProvider value={navigate}><ClobeDashboardSyncProvider actorKey={userId} refresh={refreshAfterChange} accounts={data.accounts} businesses={data.businesses}><SidebarProvider style={{'--sidebar-width':'15rem'} as React.CSSProperties}><Sidebar className="finance-sidebar"><SidebarHeader className="px-6 py-5"><FinanceLink href={businessHref('/','',biz)} className="brand"><span className="brand-mark"><ChartNoAxesCombined size={24}/></span><span>멀린<span className="brand-sub">FINANCE DESK</span></span></FinanceLink></SidebarHeader><SidebarContent><SidebarGroup className="px-4 pt-2"><SidebarMenu>{navigation.map(n=><SidebarMenuItem key={n.key}><SidebarMenuButton asChild isActive={view===n.key||(n.key==='settings'&&view.startsWith('settings'))} className="nav-item"><FinanceLink href={businessHref(n.href,'',biz)} onMouseEnter={()=>preloadView(n.key)} onFocus={()=>preloadView(n.key)}><n.icon size={19}/><span>{n.label}</span></FinanceLink></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup><div className="sidebar-businesses"><p className="nav-caption">사업자</p>{data.businesses.map(b=><button key={b.id} aria-pressed={biz===b.id} onClick={()=>changeBiz(b.id)}><span style={{background:b.color}}/>{b.name}</button>)}</div></SidebarContent><SidebarFooter className="p-5"><button className="profile" onClick={()=>void navigate(businessHref('/settings/account','',biz))}><span className="avatar">M</span><span><strong>계정 설정</strong><small>{email}</small></span><ChevronRight size={16}/></button></SidebarFooter></Sidebar><SidebarInset className="app-main"><header className="topbar"><div className="flex items-center gap-3"><SidebarTrigger className="md:hidden"/><strong>{title}</strong></div><div className="topbar-actions"><ClobeDashboardSyncButton compact showStatus disabled={loading||!data.accounts.length}/>{(savingBeforeNavigation||transitionPending)&&<span role="status" className="text-xs text-muted-foreground">{savingBeforeNavigation?'변경사항 저장 확인 중…':'화면 이동 중…'}</span>}<Button variant="ghost" size="icon" aria-label="자료 새로고침" disabled={refreshing} onClick={()=>void action(async()=>{await flushPending();await refreshAfterChange();})}><RefreshCw size={17} className={refreshing?'animate-spin':''}/></Button><button aria-label={dark?'라이트 모드':'다크 모드'} className="icon-button" onClick={()=>{localStorage.setItem('finance-theme',!dark?'dark':'light');window.dispatchEvent(new Event('finance-theme'))}}>{dark?<Sun size={18}/>:<Moon size={18}/>}</button><Button variant="outline" size="sm" onClick={()=>void action(async()=>{await flushPending();await api('/api/account',{action:'logout'});invalidateSession()})}><LogOut size={15}/><span className="mobile-hide">로그아웃</span></Button></div></header><main className="page-content" aria-busy={transitionPending}>{children}<div className="page-heading"><div><h1>{title}</h1></div><div className="heading-actions">{!view.startsWith('settings')&&view!=='upload'&&<Button variant="outline" onClick={()=>window.print()}><Printer size={16}/>인쇄</Button>}{view!=='upload'&&<Button asChild><FinanceLink href={businessHref('/upload','',biz)}><Upload size={16}/>거래 업로드</FinanceLink></Button>}</div></div>{!view.startsWith('settings')&&view!=='upload'&&<div className={view==='consolidated'?'filterbar analysis-filterbar':'filterbar'}><div className="flex items-center gap-2"><Building2 size={18} className="muted"/><Picker label="사업자" value={biz} onChange={changeBiz} options={[{value:'all',label:'전체 사업자'},...data.businesses.map(b=>({value:b.id,label:b.name}))]}/></div>{view==='consolidated'?<DateRangeControl label="전체 분석" value={{from,to}} bounds={analysisBounds} onChange={range=>{setFrom(range.from);setTo(range.to);setPeriod('custom');}}/>:view!=='classification'&&view!=='cash-utilization'&&view!=='monthly-report'&&<div className="date-filters"><CalendarDays size={17} className="muted"/><Picker label="기간" value={period} onChange={setRange} options={[{value:'month',label:'이번 달'},{value:'quarter',label:'이번 분기'},{value:'year',label:'올해'},{value:'all',label:'전체 기간'},{value:'custom',label:'직접 선택'}]}/><Input aria-label="시작일" type="date" value={from} onChange={e=>{setPeriod('custom');setFrom(e.target.value)}}/><span>–</span><Input aria-label="종료일" type="date" value={to} onChange={e=>{setPeriod('custom');setTo(e.target.value)}}/></div>}</div>}{!loading&&data.businesses.length>0&&<TaxPaymentAlert data={data} biz={biz} asOf={now} state={cashPlanEdits} onViewDate={viewTaxDate}/>} {error&&data.businesses.length>0&&<div className="info-line" role="alert"><span>재조회 실패 · 마지막 저장 자료를 표시합니다. {error}</span><Button disabled={refreshing} size="sm" variant="outline" onClick={()=>void action(async()=>{await flushPending();await refreshAfterChange();})}><RefreshCw size={16}/>자료 다시 불러오기</Button></div>} {error&&data.businesses.length===0?<div className="error-state" role="alert"><h2>자료를 불러오지 못했습니다</h2><p>{error}</p><Button onClick={()=>void action(async()=>{await flushPending();await refreshAfterChange();})} variant="outline"><RefreshCw size={16}/>다시 시도</Button></div>:loading?<div className="kpi-grid">{[1,2,3,4].map(n=><Skeleton key={n} className="h-36 rounded-xl"/>)}</div>:view.startsWith('settings')?<SettingsView data={data} section={view.split('/')[1]||'businesses'} refresh={refreshAfterChange} email={email}/>:!data.businesses.length?<section className="onboard panel"><Building2 size={40}/><h2>우리 사업의 자금관리를 시작하세요</h2><p>빈 작업공간에서 표준 계정과목을 준비합니다.<br/>설정에서 내 사업자와 통장을 등록한 뒤 거래내역을 업로드하세요.</p><Button disabled={setup} onClick={()=>void action(async()=>{setSetup(true);try{await api('/api/setup',{});await refreshAfterChange();await navigate('/settings/businesses');toast.success('표준 계정과목을 준비했습니다. 사업자와 통장을 등록하세요.')}finally{setSetup(false)}})}>{setup?'준비하는 중…':'기본 과목 준비하고 사업자 등록'}</Button></section>:view==='classification'?<ClassificationReview key={biz} data={data} biz={biz} refresh={refreshAfterChange} notes={notes} onApplied={classificationApplied} queue={classificationQueue}/>:((view==='consolidated'&&!isValidDateRange({from,to}))||((view==='overview'||view==='transactions')&&from>to))?<div className="error-state" role="alert">유효한 시작일과 종료일을 선택해주세요. 시작일은 종료일보다 늦을 수 없습니다.</div>:view==='overview'||view==='consolidated'?<Dashboard key={view==='consolidated'?view:`${view}:${biz}`} data={data} tx={tx} biz={biz} asOf={to||now} from={from} consolidated={view==='consolidated'} refresh={refreshAfterChange}/>:view==='transactions'?<Transactions key={biz} data={data} tx={tx} biz={biz} refresh={refreshAfterChange} viewMode={transactionView} onViewModeChange={setTransactionView} range={{from,to}} onRangeChange={range=>{setFrom(range.from);setTo(range.to);setPeriod('custom');}}/>:view==='monthly-report'?<MonthlyReportView data={data} biz={biz} asOf={now} editState={cashPlanEdits}/>:view==='upload'?<UploadView key={biz} data={data} biz={biz} refresh={refreshAfterChange}/>:view==='cash-utilization'?<CashView key={biz} data={data} asOf={now} biz={biz} editState={cashPlanEdits} onSaveFixedCosts={saveFixedCosts} refresh={refreshAfterChange} focusDate={query.get('tax_due')??''}/>:<SettingsView data={data} section={view.split('/')[1]||'businesses'} refresh={refreshAfterChange} email={email}/>}<footer className="page-footer"><span>단위: 원 · 서울 기준</span></footer></main></SidebarInset><Toaster richColors position="bottom-right"/></SidebarProvider></ClobeDashboardSyncProvider></FinanceNavigationProvider>}
