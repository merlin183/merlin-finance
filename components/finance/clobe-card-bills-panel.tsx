"use client";

import {useEffect,useMemo,useRef,useState} from 'react';
import {CreditCard,LoaderCircle,RefreshCw,TriangleAlert} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import type {ClobeCardBillsResponse} from '@/lib/clobe/card-billing-types';
import type {ClobeImportSettings} from '@/lib/clobe/import-types';
import {buildClobeCardPlanChanges,getClobeCardPlanCandidates} from '@/lib/finance/clobe-card-plan';
import {confirmedClobeCardBusinesses,reviewedClobeCardBill} from '@/lib/finance/clobe-card-display';
import {isValidDateRange,type DateRange} from '@/lib/finance/date-range';
import {won,addDays} from '@/lib/finance/format';
import type {Dataset} from '@/lib/finance/types';
import type {CashPlanEditState} from './use-cash-plan-edits';
import {DateRangeControl} from './date-range-control';
import {FinanceLink} from './common';
import './clobe-card-bills-panel.css';

type Draft={selected:boolean;businessId:string;accountId:string;replacementKeys:string[]};
const kindLabel={REGULAR:'청구',PRE_PAYMENT:'선결제 · 조회만',ADJUSTMENT:'조정 · 조회만'};
const message=(cause:unknown)=>cause instanceof Error?cause.message:'카드 청구자료를 확인하지 못했습니다.';
async function read<T>(url:string,signal?:AbortSignal):Promise<T>{
 const response=await fetch(url,{cache:'no-store',signal});
 const value=await response.json() as T&{error?:string};
 if(!response.ok)throw Error(value.error||'클로브 카드 연결을 확인해주세요.');
 return value;
}
function queryUrl(range:DateRange){return `/api/clobe/card-bills?startDate=${encodeURIComponent(range.from)}&endDate=${encodeURIComponent(range.to)}`;}
function rangeError(range:DateRange){return !isValidDateRange(range)?'시작일과 종료일을 확인해주세요.':range.to>addDays(range.from,92)?'한 번에 93일 이내로 조회해주세요.':'';}

export function ClobeCardBillsPanel({data,asOf,biz,state,range}:{data:Dataset;asOf:string;biz:string;state:CashPlanEditState;range:DateRange}){
 const [open,setOpen]=useState(false),[period,setPeriod]=useState(range);
 const [response,setResponse]=useState<ClobeCardBillsResponse|null>(null),[drafts,setDrafts]=useState<Record<string,Draft>>({});
 const [companyBusinesses,setCompanyBusinesses]=useState<Map<string,string>>(new Map());
 const [loading,setLoading]=useState(false),[applying,setApplying]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const requestRef=useRef<AbortController|null>(null),generation=useRef(0),mounted=useRef(false),busy=useRef(false),originalIds=useRef<Record<string,string>>({});
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;requestRef.current?.abort();};},[]);
 const entries=useMemo(()=>response?.companies.flatMap(company=>company.bills.map(bill=>({company,bill})))??[],[response]);
 const visibleCompanies=useMemo(()=>response?.companies.filter(company=>biz==='all'||companyBusinesses.get(company.id)===biz)??[],[response,biz,companyBusinesses]);
 const selected=useMemo(()=>entries.filter(({bill,company})=>drafts[bill.key]?.selected&&visibleCompanies.some(row=>row.id===company.id)),[entries,drafts,visibleCompanies]);
 const candidatesByScope=useMemo(()=>{
  const scopes=new Map<string,ReturnType<typeof getClobeCardPlanCandidates>>();
  for(const {bill} of entries){const business=drafts[bill.key]?.businessId;if(!business||!bill.replaceable)continue;const month=bill.date.slice(0,7),key=`${business}/${month}`;if(!scopes.has(key))scopes.set(key,getClobeCardPlanCandidates(data,state.edits??[],business,month,asOf));}
  return scopes;
 },[entries,drafts,data,state.edits,asOf]);
 const ready=selected.length>0&&selected.every(({bill})=>{const draft=drafts[bill.key];return bill.replaceable&&!!draft?.businessId&&!!draft.accountId&&(!!state.edits?.some(edit=>edit.id===bill.key)||draft.replacementKeys.length>0);});
 const selectedOld=useMemo(()=>{
  const unique=new Map<string,{title:string;amount:number}>();
  for(const {bill} of selected){const draft=drafts[bill.key];if(!draft?.businessId)continue;const candidates=candidatesByScope.get(`${draft.businessId}/${bill.date.slice(0,7)}`)??[];for(const item of candidates)if(draft.replacementKeys.includes(item.key))unique.set(item.key,{title:item.title,amount:item.remainingAmount});}
  return [...unique.values()];
 },[selected,drafts,candidatesByScope]);

 async function load(nextPeriod=period){
  if(busy.current)return;
  const invalid=rangeError(nextPeriod);if(invalid){setError(invalid);return;}
  requestRef.current?.abort();const controller=new AbortController();requestRef.current=controller;const run=++generation.current;
  setLoading(true);setError('');setNotice('');setResponse(null);setDrafts({});originalIds.current={};
  try{
   const [bills,settings]=await Promise.all([read<ClobeCardBillsResponse>(queryUrl(nextPeriod),controller.signal),read<ClobeImportSettings>('/api/clobe/import',controller.signal).catch(()=>({mappings:[]}))]);
   if(!mounted.current||run!==generation.current)return;
   const mappings=confirmedClobeCardBusinesses(settings.mappings,data);
   const restored:Record<string,Draft>={};
   for(const company of bills.companies)for(const bill of company.bills){const saved=state.edits?.find(edit=>edit.id===bill.key);restored[bill.key]={selected:false,businessId:saved?.business_id||mappings.get(company.id)||'',accountId:saved?.account_id||'',replacementKeys:[]};}
   setCompanyBusinesses(mappings);setResponse(bills);setDrafts(restored);
  }catch(cause){if(mounted.current&&run===generation.current&&!controller.signal.aborted)setError(message(cause));}
  finally{if(mounted.current&&run===generation.current)setLoading(false);}
 }
 function launch(){const initial=rangeError(range)?{from:range.from,to:addDays(range.from,30)}:range;setPeriod(initial);setOpen(true);void load(initial);}
 function close(value:boolean){if(busy.current)return;setOpen(value);if(!value){generation.current++;requestRef.current?.abort();setLoading(false);}}
 function changeDraft(key:string,patch:Partial<Draft>){if(loading||busy.current)return;setDrafts(current=>({...current,[key]:{...current[key],...patch}}));setNotice('');}
 function changePeriod(next:DateRange){if(busy.current)return;generation.current++;requestRef.current?.abort();setPeriod(next);setResponse(null);setDrafts({});setLoading(false);setError('');setNotice('');}

 async function apply(){
  if(!response||!ready||busy.current||state.saving)return;
  busy.current=true;setApplying(true);setError('');setNotice('');
  try{
   // The source is read again; browser drafts are never accepted as fresh bills.
   const fresh=await read<ClobeCardBillsResponse>(queryUrl(period));
   const selections=selected.map(({company,bill})=>{const current=reviewedClobeCardBill(fresh,company.id,bill);if(!current)throw Error('조회 후 청구자료가 변경되었거나 확인되지 않습니다. 기존 계획은 유지했습니다. 다시 조회하고 검토해주세요.');const draft=drafts[bill.key];return {companyId:company.id,businessId:draft.businessId,accountId:draft.accountId,bill:current,replacementKeys:draft.replacementKeys};});
   for(const selection of selections)for(const key of selection.replacementKeys)originalIds.current[key]??=crypto.randomUUID();
   const changes=buildClobeCardPlanChanges({data,edits:state.edits??[],asOf,selections,newEditIds:originalIds.current});
   if(!changes.length){setNotice('이미 같은 결제일·청구금액으로 반영되어 있습니다. 중복으로 추가하지 않았습니다.');return;}
   await state.save(changes);
   setDrafts(current=>Object.fromEntries(Object.entries(current).map(([key,draft])=>[key,{...draft,selected:false,replacementKeys:[]}])));
   const text='카드대금 계획을 교체했습니다. 지출 후 잔액·필요자금·달력에 반영됩니다.';setNotice(text);toast.success(text);
  }catch(cause){setError(message(cause));}
  finally{busy.current=false;if(mounted.current)setApplying(false);}
 }

 return <><Button type="button" variant="outline" size="sm" onClick={launch} aria-haspopup="dialog" disabled={state.loading||state.saving}><CreditCard size={16}/>카드 청구 동기화</Button>
 <Dialog open={open} onOpenChange={close}><DialogContent className="clobe-card-dialog" onEscapeKeyDown={event=>{if(applying)event.preventDefault();}} onInteractOutside={event=>{if(applying)event.preventDefault();}}>
  <DialogHeader><DialogTitle>카드 결제일·청구금액 동기화</DialogTitle><DialogDescription>클로브 청구자료를 확인하고 기존 카드대금 계획을 교체합니다. 실제 카드 결제나 통장 거래 변경은 실행하지 않습니다.</DialogDescription></DialogHeader>
  <div className="clobe-card-toolbar"><DateRangeControl label="카드 청구" value={period} onChange={changePeriod} validateRange={rangeError}/><Button variant="outline" disabled={loading||applying} onClick={()=>void load()}>{loading?<LoaderCircle size={16} className="animate-spin"/>:<RefreshCw size={16}/>}청구자료 조회</Button></div>
  <div className="clobe-card-body" aria-busy={loading||applying}>
   {loading&&<p role="status">클로브의 카드 청구자료를 확인하고 있습니다…</p>}
   {error&&<p className="clobe-card-error" role="alert"><TriangleAlert size={16}/>{error} {!response&&<FinanceLink href="/upload">클로브 연결 확인</FinanceLink>}</p>}
   {notice&&<p className="clobe-card-success" role="status">{notice}</p>}
   {response&&<p className="clobe-card-note">최신 조회 {new Date(response.fetchedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} · 카드사 재수집은 클로브에서 진행합니다. 조회 결과가 없거나 불명확하면 기존 계획을 유지합니다.</p>}
   {response&&!visibleCompanies.length&&<p>선택한 사업자에 확인된 클로브 연결이 없습니다. 전체 사업자에서 사업자 연결을 확인해주세요.</p>}
   {visibleCompanies.map(company=>{
    const eligible=company.bills.filter(bill=>bill.replaceable).length;
    return <section className="clobe-card-company" key={company.id} aria-label={`${company.name} 카드 청구`}><header><h3>{company.name}</h3><span className={eligible?'clobe-card-badge':'clobe-card-muted'}>{eligible?`교체 가능 ${eligible}건`:'기존 카드대금 계획 유지'}</span></header>
     {company.error&&<p className="clobe-card-error">{company.error}</p>}
     {company.warnings.filter(warning=>warning!==company.scraping.error&&(company.bills.length>0||!warning.startsWith('조회 기간에 수집된 카드 청구가 없습니다.'))).map(warning=><p className="clobe-card-note" key={warning}>{warning}</p>)}
     <p className="clobe-card-note">청구자료 수집 {company.scraping.lastCollectedAt||'시각 확인 필요'}{company.scraping.error?` · ${company.scraping.error}`:''}</p>
     {!company.bills.length&&!company.error&&<p className="clobe-card-empty">이 기간의 청구자료가 없습니다. 기존 카드대금 계획을 유지합니다.</p>}
     {company.bills.map(bill=>{
      const draft=drafts[bill.key],saved=state.edits?.find(edit=>edit.id===bill.key),businessId=draft?.businessId||'';
      const candidates=candidatesByScope.get(`${businessId}/${bill.date.slice(0,7)}`)??[];
      return <article key={bill.key} className={`clobe-card-bill ${draft?.selected?'clobe-card-bill-selected':''}`}>
       <div className="clobe-card-bill-head"><label>{bill.replaceable&&<input type="checkbox" aria-label={`${company.name} ${bill.date} ${bill.maskedCard} 계획 교체 선택`} checked={!!draft?.selected} disabled={loading||applying||!!saved?.excluded} onChange={event=>changeDraft(bill.key,{selected:event.target.checked})}/>}<span><strong>{bill.date}</strong><small>{bill.maskedCard} · {kindLabel[bill.kind]}{saved?' · 계획 반영됨':''}</small></span></label><strong>{bill.amount===null?'금액 확인 필요':won(bill.amount)}</strong></div>
       {!bill.replaceable&&<p className="clobe-card-note">{bill.reason||'기존 계획 교체 대상이 아닙니다.'}</p>}
       {saved?.excluded&&<p className="clobe-card-note">이 청구 일정은 계획에서 제외되어 있습니다. 다시 동기화해도 자동 복원하지 않습니다.</p>}
       {draft?.selected&&<div className="clobe-card-replace-form"><div className="clobe-card-link-fields"><label>멀린 사업자<select aria-label={`${bill.date} ${bill.maskedCard} 멀린 사업자`} value={businessId} disabled={applying||!!saved} onChange={event=>changeDraft(bill.key,{businessId:event.target.value,accountId:'',replacementKeys:[]})}><option value="">사업자 선택</option>{data.businesses.map(business=><option value={business.id} key={business.id}>{business.name}</option>)}</select></label><label>출금계좌<select aria-label={`${bill.date} ${bill.maskedCard} 출금계좌`} value={draft.accountId} disabled={applying||!businessId} onChange={event=>changeDraft(bill.key,{accountId:event.target.value})}><option value="">출금계좌 선택</option>{data.accounts.filter(account=>account.business_id===businessId).map(account=><option value={account.id} key={account.id}>{[account.name,account.bank,account.masked_number].filter(Boolean).join(' · ')}</option>)}</select></label></div>
        {!saved&&<fieldset><legend>교체할 기존 카드대금 계획 · 선택한 항목은 해당 월에 제외됩니다</legend>{candidates.length?candidates.map(item=><label className="clobe-card-old-plan" key={item.key}><input type="checkbox" checked={draft.replacementKeys.includes(item.key)} disabled={applying} onChange={event=>changeDraft(bill.key,{replacementKeys:event.target.checked?[...draft.replacementKeys,item.key]:draft.replacementKeys.filter(key=>key!==item.key)})}/><span>{item.date||'날짜 미정'} · {item.title}<small>남은 계획 {won(item.remainingAmount)} · 전체 예산 {won(item.amount)}</small></span></label>):<p className="clobe-card-note">이 사업자·월에 교체할 카드대금 계획이 없습니다. 다른 계획을 임의로 제외하지 않습니다.</p>}</fieldset>}
       </div>}
      </article>;
     })}
    </section>;
   })}
  </div>
  <footer className="clobe-card-footer"><div>{selected.length?<><strong>선택 청구액 {won(selected.reduce((sum,{bill})=>sum+(bill.amount??0),0))}</strong><small>기존 선택 계획 {selectedOld.length}건 · {won(selectedOld.reduce((sum,item)=>sum+item.amount,0))} 제외</small></>:<span>청구자료를 확인한 뒤 교체할 계획을 선택하세요.</span>}</div><Button disabled={!ready||loading||applying||state.saving||!!state.error} onClick={()=>void apply()}>{applying?<LoaderCircle size={16} className="animate-spin"/>:<RefreshCw size={16}/>}선택한 카드대금 계획 교체</Button></footer>
 </DialogContent></Dialog></>;
}
