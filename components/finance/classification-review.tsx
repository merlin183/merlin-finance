"use client";
import {useFinancialVisibility,FinancialText,FinancialValue} from './financial-visibility';

import {useMemo,useState,useSyncExternalStore} from 'react';
import {CheckCheck,ChevronLeft,ChevronRight,Search,Sparkles,Layers3,Link2,LoaderCircle} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Checkbox} from '@/components/ui/checkbox';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {toast} from 'sonner';
import type {Dataset,Transaction,SourceDetails,MerchantNote} from '@/lib/finance/types';
import type {ClassificationResult} from '@/lib/finance/classification-result';
import {buildReviewGroups,type ReviewGroup,type ReviewSelection} from '@/lib/finance/classification-review';
import {pendingClassificationIds,failedClassificationChoices,type ClassificationQueue} from '@/lib/finance/classification-queue';
import {needsCategoryReview,isHistoricalCompletionCategory} from '@/lib/finance/category-status';
import {won} from '@/lib/finance/format';
import {Panel,Picker,NoData,api,action} from './common';
import './classification-review.css';
import {CategoryPicker} from './category-picker';
import {TransactionTransferFeeDialog} from './transaction-transfer-fee';
import './transaction-transfer-fee.css';
import {MerchantNoteEditor,type useMerchantNotes} from './merchant-note';
import {noteKey,noteSubject} from '@/lib/finance/merchant-notes';
import {getSourceDetailEntries,sourceCounterparty} from '@/lib/finance/source-details';

export function ClassificationReview({data,biz,refresh,notes,onApplied,queue}:{data:Dataset;biz:string;refresh:()=>Promise<void>;notes:ReturnType<typeof useMerchantNotes>;onApplied:(result:ClassificationResult)=>Promise<void>;queue:ClassificationQueue}){
 const {privateText,amountsVisible}=useFinancialVisibility();
 const groups=useMemo(()=>buildReviewGroups(data,biz),[data,biz]);
 const queueState=useSyncExternalStore(queue.subscribe,queue.getSnapshot,queue.getSnapshot);
 const pendingIds=useMemo(()=>pendingClassificationIds(queueState),[queueState]);
 const failedChoices=useMemo(()=>failedClassificationChoices(queueState),[queueState]);
 const pendingCount=queueState.pending.flatMap(entry=>entry.groups).reduce((total,group)=>total+group.rows.filter(row=>biz==='all'||row.business_id===biz).length,0);
 const failures=queueState.failed.filter(entry=>entry.groups.some(group=>group.rows.some(row=>biz==='all'||row.business_id===biz)));
 const [noteLibrary,setNoteLibrary]=useState(false);
 const [libraryNotes,setLibraryNotes]=useState<MerchantNote[]>([]);
 const [sourceRepair,setSourceRepair]=useState(false);
 const [transferFee,setTransferFee]=useState<Transaction|null>(null);
 const savedNotes=libraryNotes.filter(n=>n.memo&&(biz==='all'||data.accounts.find(a=>a.id===n.account_id)?.business_id===biz));
 const [search,setSearch]=useState(''),[account,setAccount]=useState('all'),[filter,setFilter]=useState('all');
 const [choices,setChoices]=useState<Record<string,string>>({}),[selected,setSelected]=useState<Set<string>>(new Set());
 const [batch,setBatch]=useState(''),[remember,setRemember]=useState(true),[page,setPage]=useState(0);
 const [detail,setDetail]=useState<ReviewGroup|null>(null),[detailPage,setDetailPage]=useState(0);
 const options=useMemo(()=>data.categories.filter(c=>!needsCategoryReview(c.name)),[data.categories]);
 const unmapped=(g:ReviewGroup)=>g.rows.some(t=>!t.category_id||!data.categories.some(c=>c.id===t.category_id)||data.categories.find(c=>c.id===t.category_id)?.name==="미매핑");
 const accountName=(id:string)=>{const a=data.accounts.find(a=>a.id===id);return a?`${data.businesses.find(b=>b.id===a.business_id)?.name} · ${a.name}`:'계좌 확인 필요'};
 const filtered=groups.filter(g=>!g.rows.some(row=>pendingIds.has(row.id))&&(account==='all'||g.account_id===account)&&(!search||g.label.toLowerCase().includes(search.toLowerCase())||g.rows.some(t=>[t.description,...getSourceDetailEntries(t).map(entry=>entry.value)].some(value=>value.toLowerCase().includes(search.toLowerCase()))))&&(filter==='all'||(filter==='recommended'?!!g.suggestedCategoryId:!g.suggestedCategoryId)));
 const recommended=filtered.filter(g=>{const choice=choices[g.key]??failedChoices.get(g.key);return g.suggestedCategoryId&&(!choice||choice===g.suggestedCategoryId);});
 const chosen=filtered.filter(g=>selected.has(g.key));
 const count=(list:ReviewGroup[])=>list.reduce((n,g)=>n+g.rows.length,0);
 const pages=Math.max(1,Math.ceil(filtered.length/20)),current=Math.min(page,pages-1),visible=filtered.slice(current*20,current*20+20);
 const selectionCategory=(g:ReviewGroup)=>choices[g.key]??failedChoices.get(g.key)??g.suggestedCategoryId??'';
 const resetSelection=()=>{setSelected(new Set());setPage(0);setBatch('');};
 function toggle(key:string,checked:boolean){setSelected(old=>{const next=new Set(old);if(checked)next.add(key);else next.delete(key);return next;});}
 async function apply(list:ReviewGroup[],categoryOverride=''){
  if(transferFee)return;
  const currentlyPending=pendingClassificationIds(queue.getSnapshot());
  list=list.filter(group=>!group.rows.some(row=>currentlyPending.has(row.id)));
  if(!list.length)return;
  const selections:ReviewSelection[]=list.map(g=>({key:g.key,category_id:categoryOverride||selectionCategory(g),remember:remember&&g.canLearn&&!isHistoricalCompletionCategory(data.categories.find(c=>c.id===(categoryOverride||selectionCategory(g)))?.name),transactions:g.rows.map(t=>({id:t.id,category_id:t.category_id,manually_classified:t.manually_classified}))}));
  if(selections.some(g=>!g.category_id)){toast.error('적용할 과목을 선택해주세요.');return;}
  // Preserve the submitted choices for a failed request, including batch overrides.
  setChoices(old=>({...old,...Object.fromEntries(selections.map(selection=>[selection.key,selection.category_id]))}));
  if(detail&&list.some(group=>group.key===detail.key))setDetail(null);
  const applied=await queue.run({groups:list,selections},async()=>{
   await notes.flush();const result=await api<ClassificationResult>('/api/classification',{groups:selections});await onApplied(result);
   toast.success(<FinancialText value={String(`${result.updated.toLocaleString()}건을 정리했습니다.`)}/>);
  });
  if(applied){const keys=new Set(list.map(group=>group.key));setSelected(old=>new Set([...old].filter(key=>!keys.has(key))));setChoices(old=>Object.fromEntries(Object.entries(old).filter(([key])=>!keys.has(key))));}
 }
 const unresolvedCount=count(groups),recommendedCount=count(groups.filter(g=>g.suggestedCategoryId));
 return <div className="classification-workspace">
  {data.categories.some(c=>isHistoricalCompletionCategory(c.name))&&<p className="text-xs text-muted-foreground">2026년부터 정리 · 이전 미분류는 과거완료</p>}
  <div className="classification-summary">
   <div><span>정리할 거래</span><strong>{unresolvedCount.toLocaleString()}<small>건</small></strong></div>
   <div><span>거래처별 묶음</span><strong>{groups.length.toLocaleString()}<small>개</small></strong></div>
   <div className="recommendation-total"><span>한 번에 적용할 추천</span><strong>{recommendedCount.toLocaleString()}<small>건</small></strong></div>
  </div>
  <Panel title="거래처별 분류" subtitle={privateText(String(`${biz==='all'?'전체 사업자':data.businesses.find(b=>b.id===biz)?.name} · 전체 기간`))}>
   <div className="classification-toolbar">
    <Button variant="outline" onClick={()=>void action(async()=>{await notes.flush();setLibraryNotes(notes.savedNotes());setNoteLibrary(true);})}>저장 메모 보기</Button>
    <Button variant="outline" disabled={queueState.pending.length>0||!!transferFee} onClick={()=>setSourceRepair(true)}><Link2 size={15}/>시트 원본 내역 보완</Button>
    <div className="search-field"><Search size={16}/><Input aria-label="정리할 거래처 검색" placeholder="거래처·적요·원본 내역 검색" value={privateText(String((search)??''))} onChange={e=>{setSearch(e.target.value);resetSelection();}} readOnly={!amountsVisible&&privateText(String((search)??''))!==String((search)??'')}/></div>
    <Picker label="정리할 계좌" value={account} onChange={v=>{setAccount(v);resetSelection();}} options={[{value:'all',label:'모든 계좌'},...data.accounts.filter(a=>biz==='all'||a.business_id===biz).map(a=>({value:a.id,label:accountName(a.id)}))]}/>
    <Picker label="추천 여부" value={filter} onChange={v=>{setFilter(v);resetSelection();}} options={[{value:'all',label:'모든 묶음'},{value:'recommended',label:'추천 있는 묶음'},{value:'choose',label:'과목 선택 필요'}]}/>
   </div>
   <div className="classification-actions">
    <label><Checkbox checked={remember} onCheckedChange={v=>setRemember(v===true)}/><span>다음 거래에도 자동 적용<small>거래처·용도가 확인된 묶음만 저장</small></span></label>
    <Button disabled={!!transferFee||!recommended.length||count(recommended)>10000} onClick={()=>void action(()=>apply(recommended))}><Sparkles size={16}/>목록의 추천 {count(recommended).toLocaleString()}건 한 번에 적용</Button>
   </div>
   {pendingCount>0&&<div className="classification-save-progress" role="status"><LoaderCircle size={16} className="animate-spin"/><strong>저장 중 {pendingCount.toLocaleString()}건</strong><span>다음 거래를 계속 정리할 수 있습니다.</span></div>}
   {failures.length>0&&<div className="classification-save-error" role="alert"><strong>저장하지 못한 거래를 목록에 다시 표시했습니다.</strong><span><FinancialText value={String((failures[failures.length-1].error)||'')}/> 선택한 과목을 확인하고 다시 적용해주세요.</span></div>}
   {chosen.length>0&&<div className="classification-batch"><strong>{chosen.length}묶음 · {count(chosen).toLocaleString()}건 선택</strong><CategoryPicker label="선택 묶음에 적용할 과목" value={batch} onChange={setBatch} categories={options} aliases={data.aliases} individual/><Button disabled={!!transferFee||count(chosen)>10000||((!batch||batch==='individual')&&chosen.some(g=>!selectionCategory(g)))} onClick={()=>void action(()=>apply(chosen,batch==='individual'?'':batch))}><CheckCheck size={16}/>선택한 거래 적용</Button><Button variant="ghost" onClick={()=>setSelected(new Set())}>선택 해제</Button></div>}
   {filtered.length?<>
    <div className="classification-list-summary"><span>{filtered.length}묶음 · {count(filtered).toLocaleString()}건</span><Button variant="ghost" size="sm" onClick={()=>setSelected(new Set(filtered.map(g=>g.key)))}>현재 목록 전체 선택</Button></div>
    <Table><TableHeader><TableRow><TableHead><Checkbox aria-label="현재 페이지 묶음 전체 선택" checked={visible.length>0&&visible.every(g=>selected.has(g.key))} onCheckedChange={v=>setSelected(old=>{const next=new Set(old);for(const g of visible){if(v)next.add(g.key);else next.delete(g.key);}return next;})}/></TableHead><TableHead>거래처 / 계좌</TableHead><TableHead>묶인 거래</TableHead><TableHead>적용할 계정과목</TableHead><TableHead>적용</TableHead></TableRow></TableHeader><TableBody>{visible.map(g=><TableRow key={g.key} className={unmapped(g)?"classification-unmapped":undefined}>
     <TableCell><Checkbox aria-label={privateText(String(`${g.label} ${g.rows.length}건 선택`))} checked={selected.has(g.key)} onCheckedChange={v=>toggle(g.key,v===true)}/></TableCell>
     <TableCell className="classification-merchant"><strong><FinancialText value={String((g.label)||'')}/>{unmapped(g)&&<span className="unmapped-badge">미매핑</span>}</strong><small><FinancialText value={String((accountName(g.account_id))||'')}/> · {g.direction==='in'?'입금':'출금'}</small><GroupSourceDetails group={g} onOpen={()=>{setDetail(g);setDetailPage(0);}}/><span className={g.suggestedCategoryId?'classification-tag suggested':'classification-tag'}>{g.suggestedCategoryId?'추천 있음':g.ambiguous?'용도 확인':'과목 선택'}</span><MerchantNoteEditor transaction={g.rows[0]} notes={notes}/></TableCell>
     <TableCell><Button className="classification-count" variant="ghost" onClick={()=>{setDetail(g);setDetailPage(0);}}><Layers3 size={15}/>{g.rows.length.toLocaleString()}건 보기</Button><strong className="block money"><FinancialValue value={won(g.total)}/></strong><small className="block muted">{g.from}{g.to!==g.from?` ~ ${g.to}`:''}</small></TableCell>
     <TableCell className="classification-category"><CategoryPicker label={privateText(String(`${g.label} 적용 과목`))} value={selectionCategory(g)} onChange={v=>setChoices(old=>({...old,[g.key]:v}))} categories={options} aliases={data.aliases} disabled={!!transferFee}/><details className="classification-reason"><summary>분류 참고</summary><p><FinancialText value={String((g.reason)||'')}/></p></details>{!g.canLearn&&<small>이번 내역만 적용</small>}{g.direction==='out'&&g.rows.length===1&&<Button type="button" variant="ghost" size="sm" className="transfer-fee-category-action" disabled={queueState.pending.length>0||!!transferFee} onClick={()=>setTransferFee(g.rows[0])}>이체 수수료 분리</Button>}</TableCell>
     <TableCell><Button variant={g.suggestedCategoryId?'default':'outline'} size="sm" disabled={!!transferFee||!selectionCategory(g)||g.rows.length>10000} onClick={()=>void action(()=>apply([g]))}>{g.rows.length.toLocaleString()}건 적용</Button></TableCell>
    </TableRow>)}</TableBody></Table>
    <div className="pagination"><span>페이지 {current+1} / {pages}</span><div><Button aria-label="이전 묶음 페이지" variant="outline" size="icon" disabled={!current} onClick={()=>setPage(current-1)}><ChevronLeft size={17}/></Button><Button aria-label="다음 묶음 페이지" variant="outline" size="icon" disabled={current+1===pages} onClick={()=>setPage(current+1)}><ChevronRight size={17}/></Button></div></div>
   </>:<NoData title={privateText(String(pendingCount?'분류 내용을 저장하고 있습니다':groups.length?'조건에 맞는 묶음이 없습니다':'미분류 정리를 마쳤습니다'))} text={pendingCount?'저장이 끝나면 결과를 알려드립니다.':groups.length?'검색이나 계좌 조건을 바꿔보세요.':'새 거래를 올리면 저장한 분류 기준을 자동 적용합니다.'} href=""/>}
  </Panel>
  <Dialog open={!!detail} onOpenChange={v=>{if(!v)setDetail(null);}}><DialogContent className="classification-detail"><DialogHeader><DialogTitle><FinancialText value={String((detail?.label)||'')}/> · {detail?.rows.length.toLocaleString()}건</DialogTitle><DialogDescription><FinancialText value={String((detail&&`${accountName(detail.account_id)} · ${detail.direction==='in'?'입금':'출금'}`)||'')}/> · 전체 기간의 거래입니다.</DialogDescription></DialogHeader>{detail&&<><div className="classification-detail-table"><Table><TableHeader><TableRow><TableHead>날짜</TableHead><TableHead>원본 적요 / 상세내역</TableHead><TableHead>현재 과목</TableHead><TableHead>금액</TableHead></TableRow></TableHeader><TableBody>{detail.rows.slice(detailPage*50,detailPage*50+50).map(t=><TableRow key={t.id}><TableCell>{t.txn_date}</TableCell><TableCell className="source-detail-cell"><strong><FinancialText value={String((t.description||'적요 없음')||'')}/></strong><TransactionSourceDetails transaction={t}/></TableCell><TableCell>{data.categories.find(c=>c.id===t.category_id)?.name||'미매핑'}</TableCell><TableCell className="money"><FinancialValue value={won(t.amount)}/></TableCell></TableRow>)}</TableBody></Table></div><div className="pagination"><span>{detailPage+1} / {Math.ceil(detail.rows.length/50)}</span><div><Button aria-label="이전 상세 페이지" variant="outline" size="sm" disabled={!detailPage} onClick={()=>setDetailPage(detailPage-1)}>이전</Button><Button aria-label="다음 상세 페이지" variant="outline" size="sm" disabled={(detailPage+1)*50>=detail.rows.length} onClick={()=>setDetailPage(detailPage+1)}>다음</Button></div></div><Button variant="outline" onClick={()=>setDetail(null)}>닫기</Button></>}</DialogContent></Dialog>
  <Dialog open={noteLibrary} onOpenChange={setNoteLibrary}><DialogContent className="classification-detail"><DialogHeader><DialogTitle>저장된 거래처 메모</DialogTitle><DialogDescription>분류를 완료한 거래처의 메모도 남아 있습니다. 같은 계좌와 입출금 방향에서 함께 사용합니다.</DialogDescription></DialogHeader><div className="saved-note-list">{savedNotes.map(n=>{const transaction=data.transactions.find(t=>noteKey(noteSubject(t))===noteKey(n));return <article key={n.id}><strong><FinancialText value={String((n.label)||'')}/></strong><small className="block muted"><FinancialText value={String((accountName(n.account_id))||'')}/> · {n.direction==='in'?'입금':'출금'}</small>{transaction?<MerchantNoteEditor transaction={transaction} notes={notes}/>:<p className="whitespace-pre-wrap"><FinancialText value={String((n.memo)||'')}/></p>}</article>;})}{!savedNotes.length&&<p>거래처 이름 아래에 메모를 적으면 이곳에서도 확인할 수 있습니다.</p>}</div></DialogContent></Dialog>
  {transferFee&&<TransactionTransferFeeDialog key={transferFee.id} data={data} transaction={transferFee} onClose={()=>setTransferFee(null)} refresh={refresh} beforeSave={async()=>{await queue.flush();await notes.flush();}}/>}
  <SourceDetailsRepair open={sourceRepair} onOpenChange={setSourceRepair} refresh={refresh} notes={notes}/>
 </div>;
}

function sourceEntries(transaction:Pick<Transaction,'source_details'|'direction'>){
 const counterparty=sourceCounterparty(transaction);
 return [...(counterparty?[{label:'거래 상대방',value:counterparty}]:[]),...getSourceDetailEntries(transaction).filter(entry=>entry.label!=='거래 상대방')];
}
function SourceEntryList({entries}:{entries:{label:string;value:string}[]}){
 return <dl className="source-detail-list">{entries.map((entry,index)=><div key={`${entry.label}:${index}`}><dt><FinancialText value={String((entry.label)||'')}/></dt><dd><FinancialText value={String((entry.value)||'')}/></dd></div>)}</dl>;
}
function TransactionSourceDetails({transaction}:{transaction:Pick<Transaction,'source_details'|'direction'>}){
 const entries=sourceEntries(transaction),provenance=transaction.source_details?.provenance;
 if(!entries.length)return null;
 return <div className="source-detail-block"><SourceEntryList entries={entries}/>{provenance&&<small className="source-detail-origin">원본 · <FinancialText value={String((provenance.sheet)??'')}/> · {provenance.row}행</small>}</div>;
}
function GroupSourceDetails({group,onOpen}:{group:ReviewGroup;onOpen:()=>void}){
 const entries=[...new Map(group.rows.flatMap(sourceEntries).map(entry=>[JSON.stringify([entry.label,entry.value]),entry])).values()];
 if(!entries.length)return null;
 return <div className="source-detail-block"><SourceEntryList entries={entries.slice(0,4)}/>{entries.length>4&&<Button variant="link" size="sm" className="source-detail-more" onClick={onOpen}>원본 내역 {entries.length.toLocaleString()}개 · 모두 보기</Button>}</div>;
}

type SourceRepairPreview={sourceUrl:string;sourceHash:string;planHash:string;summary:{updated:number;unchanged:number;unmatched:number;ambiguous:number};sample:{id:string;date:string;direction:'in'|'out';description:string;source_details:SourceDetails|null}[]};
async function sourceRepairRequest<T>(body:unknown){
 const response=await fetch('/api/transaction-source-details',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const result=await response.json() as T&{error?:string};
 if(!response.ok)throw Error(response.status===401?'Google 계정으로 다시 로그인해주세요.':result.error||'원본 내역을 확인하지 못했습니다.');
 return result;
}
function SourceDetailsRepair({open,onOpenChange,refresh,notes}:{open:boolean;onOpenChange:(open:boolean)=>void;refresh:()=>Promise<void>;notes:ReturnType<typeof useMerchantNotes>}){
 const [url,setUrl]=useState(''),[preview,setPreview]=useState<SourceRepairPreview|null>(null),[busy,setBusy]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[completed,setCompleted]=useState<number|null>(null);
 async function inspect(){
  if(busy||!url.trim())return;
  setBusy(true);setError('');setPreview(null);setCompleted(null);
  try{setPreview(await sourceRepairRequest<SourceRepairPreview>({action:'preview',url:url.trim()}));}
  catch(cause){setError(cause instanceof Error?cause.message:'원본 내역을 확인하지 못했습니다.');}
  finally{setBusy(false);}
 }
 async function apply(){
  if(busy||!preview||!preview.summary.updated||completed!==null)return;
  setBusy(true);setSaving(true);setError('');
  try{await notes.flush();const result=await sourceRepairRequest<{updated:number}>({action:'apply',url:url.trim(),sourceHash:preview.sourceHash,planHash:preview.planHash});setCompleted(result.updated);toast.success(<FinancialText value={String(`거래 ${result.updated.toLocaleString()}건의 원본 내역을 보완했습니다.`)}/>);try{await refresh();}catch{toast.warning('보완은 완료됐습니다. 새로고침하면 최신 내역을 볼 수 있습니다.');}}
  catch(cause){setError(cause instanceof Error?cause.message:'원본 내역을 보완하지 못했습니다.');}
  finally{setSaving(false);setBusy(false);}
 }
 return <Dialog open={open} onOpenChange={value=>{if(!busy)onOpenChange(value);}}><DialogContent className="source-repair-dialog"><DialogHeader><DialogTitle>시트 원본 내역 보완</DialogTitle><DialogDescription>이미 등록된 거래의 원본 내역만 보완합니다. 날짜·금액·계정과목은 유지됩니다.</DialogDescription></DialogHeader><label className="source-repair-label" htmlFor="source-repair-url">Google 스프레드시트 공유 링크</label><div className="source-repair-input"><Input id="source-repair-url" type="url" autoComplete="off" placeholder="https://docs.google.com/spreadsheets/d/…" disabled={busy} value={url} onChange={event=>{setUrl(event.target.value);setPreview(null);setCompleted(null);setError('');}}/><Button variant="outline" disabled={busy||!url.trim()} onClick={()=>void inspect()}>{busy&&!saving?<LoaderCircle className="animate-spin" size={16}/>:<Search size={16}/>}확인하기</Button></div>{error&&<p role="alert" className="source-repair-error"><FinancialText value={String((error)||'')}/></p>}{preview&&<><div className="source-repair-summary">{[{label:'보완할 거래',value:preview.summary.updated},{label:'이미 반영됨',value:preview.summary.unchanged},{label:'일치 거래 없음',value:preview.summary.unmatched},{label:'확인 필요',value:preview.summary.ambiguous}].map(item=><div key={item.label}><span>{item.label}</span><strong>{item.value.toLocaleString()}<small>건</small></strong></div>)}</div><p className="source-repair-hint">일치하는 거래가 없거나 여러 거래와 겹치는 행은 보완하지 않습니다.</p>{!!preview.sample.length&&<div className="source-repair-samples" aria-label="보완할 원본 내역 미리보기">{preview.sample.map((sample,index)=><article key={`${sample.id}:${index}`}><div><strong><FinancialText value={String((sample.description||'적요 없음')||'')}/></strong><small>{sample.date} · {sample.direction==='in'?'입금':'출금'}</small></div><TransactionSourceDetails transaction={sample}/></article>)}</div>}{completed!==null&&<p className="source-repair-complete" role="status">원본 내역 {completed.toLocaleString()}건을 보완했습니다.</p>}<div className="source-repair-actions"><Button variant="outline" disabled={busy} onClick={()=>onOpenChange(false)}>닫기</Button><Button disabled={busy||!preview.summary.updated||completed!==null} onClick={()=>void apply()}>{saving&&<LoaderCircle size={16} className="animate-spin"/>}{completed!==null?'보완 완료':`원본 내역 ${preview.summary.updated.toLocaleString()}건 보완`}</Button></div></>}</DialogContent></Dialog>;
}
