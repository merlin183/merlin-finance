import {useCallback,useEffect,useId,useRef,useState,type RefObject} from 'react';
import {CreditCard,LoaderCircle,Pencil,Plus,Trash2,X} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Dialog,DialogClose,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import type {CashPlanSeriesBreakdown,CashPlanSeriesBreakdownRow} from '@/lib/finance/cash-plan-series';
import {cashPlanMemoDisplay,cashPlanUserMemo} from '@/lib/finance/cash-plan-memo';
import {buildCashPlanFixedCostAddChange,buildCashPlanFixedCostChange} from '@/lib/finance/cash-plan-series-edit';
import {buildCashPlanFixedCostForwardAddChange,buildCashPlanFixedCostForwardChange,type FixedCostForwardRequest} from '@/lib/finance/cash-plan-series-forward';
import type {CashPlanEdit} from '@/lib/finance/cash-plan-edits';
import type {Dataset} from '@/lib/finance/types';
import type {CashPlanEditState} from './use-cash-plan-edits';
import {CashPlanFixedCostForm,CashPlanFixedCostScope,fixedCostFormError,fixedCostFormValues,type FixedCostFormDraft,type FixedCostFormScope} from './cash-plan-fixed-cost-form';

const amounts=new Intl.NumberFormat('ko-KR',{maximumFractionDigits:0});
const monthLabel=(month:string)=>`${Number(month.slice(0,4))}년 ${Number(month.slice(5,7))}월`;
const allowsFollowing=(row:CashPlanSeriesBreakdownRow|null)=>!row||row.sourceType!=='estimated'||row.seriesVersion>0;

function PlanMemo({memo}:{memo:string}){
 const shown=cashPlanMemoDisplay(memo);
 return shown?<details className="cash-series-row-memo"><summary>메모</summary><p>{shown}</p></details>:<span className="cash-series-detail-muted">—</span>;
}

function ItemTitle({row}:{row:CashPlanSeriesBreakdownRow}){
 return <><span>{row.title}</span>{row.originalTitle!==row.title&&<small className="cash-series-original-title">원래 품목 {row.originalTitle}</small>}</>;
}

function ExclusionReason({row}:{row:CashPlanSeriesBreakdownRow}){
 return <span className="cash-series-exclusion-kind">{row.exclusionReason==='이 달부터 계속 제외'&&row.revisionExcludedFrom?`${monthLabel(row.revisionExcludedFrom)}부터 계속 제외`:row.exclusionReason||'계획에서 제외'}</span>;
}

/** Full-month composition, sharing the same stored plan as the headline. */
export function CashPlanSeriesBreakdownDetails({breakdown,onEdit,onRemove,disabled=false}:{breakdown:CashPlanSeriesBreakdown;onEdit?:(row:CashPlanSeriesBreakdownRow)=>void;onRemove?:(row:CashPlanSeriesBreakdownRow)=>void;disabled?:boolean}){
 const includedId=useId(),excludedId=useId();
 if(!breakdown.registered)return <p className="cash-series-detail-empty">이 달에 등록된 고정비 계획이 없습니다.</p>;
 const groupOrder=new Map(breakdown.groups.map((group,index)=>[group.label,index]));
 const included=breakdown.includedRows.filter(row=>row.kind==='operating').sort((left,right)=>(groupOrder.get(left.groupLabel)??Number.MAX_SAFE_INTEGER)-(groupOrder.get(right.groupLabel)??Number.MAX_SAFE_INTEGER)||left.title.localeCompare(right.title,'ko')||left.key.localeCompare(right.key));
 const excluded=breakdown.excludedRows.filter(row=>row.kind==='operating');
 return <>
  <dl className="cash-series-detail-totals"><div><dt>월 고정비 합계</dt><dd>{amounts.format(breakdown.operatingAmount)}<small>원</small></dd></div><div><dt>포함</dt><dd>{included.length}<small>건</small></dd></div><div><dt>제외</dt><dd>{excluded.length}<small>건 · 합계에 미포함</small></dd></div></dl>
  {breakdown.groups.length>0&&<section className="cash-series-detail-groups" aria-label="고정비 분류별 소계">{breakdown.groups.map(group=><div key={group.key}><span>{group.label}<small>{group.count}건</small></span><b>{amounts.format(group.amount)}</b></div>)}</section>}
  <section className="cash-series-detail-section" aria-labelledby={includedId}><header><h3 id={includedId}>포함 항목 <small>{included.length}건</small></h3><span>단위: 원</span></header>
   {included.length>0?<div className="cash-series-detail-scroll" tabIndex={0} role="region" aria-label="고정비 포함 항목"><table className={`cash-series-detail-table${onEdit||onRemove?' cash-series-detail-editable':''}`}><caption className="sr-only">이 달의 고정비 합계에 포함된 계획 항목과 출금 계좌</caption><colgroup><col className="cash-series-group-col"/><col className="cash-series-title-col"/><col className="cash-series-amount-col"/><col className="cash-series-date-col"/><col className="cash-series-account-col"/><col/>{(onEdit||onRemove)&&<col className="cash-series-action-col"/>}</colgroup><thead><tr><th scope="col">구분</th><th scope="col">품목·대상</th><th scope="col">계획 금액</th><th scope="col">예정일</th><th scope="col">출금 계좌</th><th scope="col">비고</th>{(onEdit||onRemove)&&<th scope="col">편집</th>}</tr></thead><tbody>{included.map(row=><tr key={row.key}><td>{row.groupLabel}</td><th scope="row"><ItemTitle row={row}/></th><td className="cash-series-detail-money">{amounts.format(row.currentAmount)}</td><td>{row.date?<time dateTime={row.date}>{row.date}</time>:<span className="cash-series-detail-muted">일정 미정</span>}</td><td>{row.accountName||'계좌 미지정'}</td><td><PlanMemo memo={row.effectiveMemo}/></td>{(onEdit||onRemove)&&<td className="cash-series-row-actions">{onEdit&&<Button type="button" variant="ghost" size="icon-xs" aria-label={`${row.title} 이 달 고정비 수정`} title="수정" disabled={disabled} onClick={()=>onEdit(row)}><Pencil size={13}/></Button>}{onRemove&&<Button type="button" variant="ghost" size="icon-xs" aria-label={`${row.title} 이 달 고정비 삭제`} title="삭제" disabled={disabled} onClick={()=>onRemove(row)}><Trash2 size={13}/></Button>}</td>}</tr>)}</tbody></table></div>:<p className="cash-series-detail-empty">이 달에 포함된 고정비 항목이 없습니다.</p>}
  </section>
  {excluded.length>0&&<section className="cash-series-detail-section cash-series-detail-excluded" aria-labelledby={excludedId}><header><h3 id={excludedId}>이번 달 합계에서 제외 <small>{excluded.length}건</small></h3><span>위 합계에 더하지 않습니다.</span></header><div className="cash-series-detail-scroll" tabIndex={0} role="region" aria-label="이번 달 고정비 제외 항목"><table className="cash-series-detail-table"><caption className="sr-only">이 달의 고정비 합계에서 제외한 계획 항목과 제외 사유</caption><colgroup><col className="cash-series-group-col"/><col className="cash-series-title-col"/><col className="cash-series-amount-col"/><col/></colgroup><thead><tr><th scope="col">구분</th><th scope="col">품목·대상</th><th scope="col">기본 계획액</th><th scope="col">제외 사유</th></tr></thead><tbody>{excluded.map(row=><tr key={row.key}><td>{row.groupLabel}</td><th scope="row"><ItemTitle row={row}/></th><td className="cash-series-detail-money">{amounts.format(row.baseAmount)}{row.currentAmount!==row.baseAmount&&<small className="cash-series-excluded-month-amount">해당 월 수정액 {amounts.format(row.currentAmount)}</small>}</td><td><ExclusionReason row={row}/>{cashPlanMemoDisplay(row.globalMemo??row.editMemo??'')&&<p className="cash-series-exclusion-note">{cashPlanMemoDisplay(row.globalMemo??row.editMemo??'')}</p>}</td></tr>)}</tbody></table></div></section>}
 </>;
}

type BreakdownDialogProps={open:boolean;breakdown:CashPlanSeriesBreakdown|undefined;data:Dataset;edits:CashPlanEdit[]|null;saving:boolean;loadError:string;onReload:()=>Promise<void>;onSave:CashPlanEditState['save'];onSaveFixedCosts:(request:FixedCostForwardRequest)=>Promise<unknown>;onClose:()=>void;returnFocusRef:RefObject<HTMLButtonElement|null>};
type FormSession={mode:'add'|'edit';scope:FixedCostFormScope;id:string;row:CashPlanSeriesBreakdownRow|null;initial:FixedCostFormDraft;draft:FixedCostFormDraft};
type Removal={row:CashPlanSeriesBreakdownRow;scope:FixedCostFormScope;id:string};
const rowFingerprint=(row:CashPlanSeriesBreakdownRow|undefined)=>row?JSON.stringify([row.editId,row.version,row.seriesVersion,row.revisionEffectiveMonth,row.revisionExcludedFrom,row.title,row.originalTitle,row.baseAmount,row.currentAmount,row.date,row.nominalDay,row.accountId,row.effectiveMemo,row.memo,row.included]):'';

export function CashPlanSeriesBreakdownDialog(props:BreakdownDialogProps){
 const closeHandler=useRef<(()=>void)|null>(null);
 const registerClose=useCallback((handler:()=>void)=>{closeHandler.current=handler;},[]);
 return <Dialog open={props.open} onOpenChange={next=>{if(!next)(closeHandler.current??props.onClose)();}}><DialogContent className="cash-series-breakdown-dialog" showCloseButton={false} onEscapeKeyDown={event=>{if(props.saving)event.preventDefault();}} onInteractOutside={event=>{if(props.saving)event.preventDefault();}} onCloseAutoFocus={event=>{event.preventDefault();props.returnFocusRef.current?.focus({preventScroll:true});}}>
  {props.breakdown?<CashPlanSeriesEditorBody key={`${props.breakdown.businessId}:${props.breakdown.month}`} {...props} breakdown={props.breakdown} registerClose={registerClose}/>:<><DialogHeader className="cash-series-breakdown-heading"><div><DialogTitle>기본 고정비 내역</DialogTitle><DialogDescription>저장된 월 계획을 확인합니다.</DialogDescription></div><DialogClose asChild><Button type="button" variant="ghost" size="icon-sm" aria-label="고정비 내역 닫기"><X size={17}/></Button></DialogClose></DialogHeader><div className="cash-series-breakdown-body"><p className="cash-series-detail-empty" role={props.loadError?'alert':'status'}>{props.loadError||'계획 내역을 불러오고 있습니다…'}</p></div></>}
 </DialogContent></Dialog>;
}

function CashPlanSeriesEditorBody({breakdown,data,edits,saving,loadError,onReload,onSave,onSaveFixedCosts,onClose,registerClose}:BreakdownDialogProps&{breakdown:CashPlanSeriesBreakdown;registerClose:(handler:()=>void)=>void}){
 const [session,setSession]=useState<FormSession|null>(null);
 const [removal,setRemoval]=useState<Removal|null>(null);
 const [error,setError]=useState(''),[success,setSuccess]=useState(''),[submitting,setSubmitting]=useState(false),[discardPrompt,setDiscardPrompt]=useState(false);
 const dateInput=useRef<HTMLInputElement|null>(null),busy=useRef(false);
 const pending=saving||submitting,locked=pending||!!loadError||edits===null;
 const accounts=data.accounts.filter(account=>account.business_id===breakdown.businessId);
 const findRow=(id:string)=>[...breakdown.includedRows,...breakdown.excludedRows].find(row=>row.id===id);
 const stale=!!session&&(session.mode==='edit'?rowFingerprint(findRow(session.row!.id))!==rowFingerprint(session.row!):(edits??[]).some(edit=>edit.id===session.id||edit.source_type==='manual'&&edit.source_key===session.id)||(data.cash_plan_series??[]).some(item=>item.id===session.id||item.source_key===session.id));
 const removalStale=!!removal&&rowFingerprint(findRow(removal.row.id))!==rowFingerprint(removal.row);
 const dirty=!!session&&(session.scope!=='month'||JSON.stringify(session.draft)!==JSON.stringify(session.initial));
 const close=useCallback(()=>{
  if(busy.current||saving)return;
  if(session&&(dirty||(dateInput.current?.value??session.draft.date)!==session.initial.date)){setDiscardPrompt(true);return;}
  onClose();
 },[saving,session,dirty,onClose]);
 useEffect(()=>registerClose(close),[registerClose,close]);
 function begin(row:CashPlanSeriesBreakdownRow){
  if(locked||session||removal||!row.included||row.kind!=='operating')return;
  const draft={title:row.title,amount:String(row.currentAmount),date:row.date??'',accountId:row.accountId??'',memo:cashPlanUserMemo(row.effectiveMemo),groupLabel:row.groupLabel};
  setSession({mode:'edit',scope:'month',id:row.editId??crypto.randomUUID(),row,initial:draft,draft});setError('');setSuccess('');setDiscardPrompt(false);
 }
 function add(groupLabel='기타 고정비'){
  if(locked||session||removal)return;
  const draft={title:'',amount:'',date:'',accountId:'',memo:'',groupLabel};
  setSession({mode:'add',scope:'month',id:crypto.randomUUID(),row:null,initial:draft,draft});setError('');setSuccess('');setDiscardPrompt(false);
 }
 function change(patch:Partial<FixedCostFormDraft>){setSession(current=>current?{...current,draft:{...current.draft,...patch}}:current);setError('');setDiscardPrompt(false);}
 function changeScope(scope:FixedCostFormScope){setSession(current=>current?{...current,scope:allowsFollowing(current.row)?scope:'month'}:current);setError('');setDiscardPrompt(false);}
 async function reload(){try{await onReload();}catch(cause){setError(cause instanceof Error?cause.message:'최신 고정비 설정을 불러오지 못했습니다. 입력은 유지했습니다.');}}
 function cancel(){if(pending)return;setSession(null);setRemoval(null);setError('');setDiscardPrompt(false);}
 function reviewRemoval(row:CashPlanSeriesBreakdownRow){
  if(locked||session||removal||!row.included||row.kind!=='operating')return;
  setRemoval({row,scope:'month',id:row.editId??crypto.randomUUID()});setError('');setSuccess('');setDiscardPrompt(false);
 }
 async function save(){
  if(!session||locked||busy.current||stale)return;
  const draft={...session.draft,date:dateInput.current?.value??session.draft.date};
  const invalid=dateInput.current?.validity.badInput?'예정일을 완전하게 입력해주세요.':fixedCostFormError(draft,breakdown.month,accounts);
  if(invalid){setError(invalid);return;}
  busy.current=true;setSubmitting(true);setError('');
  try{
   const values=fixedCostFormValues(draft);
   if(session.scope==='following'){
    const request=session.mode==='add'?buildCashPlanFixedCostForwardAddChange({data,edits:edits!,businessId:breakdown.businessId,month:breakdown.month,id:session.id,draft:values}):buildCashPlanFixedCostForwardChange({data,edits:edits!,businessId:breakdown.businessId,month:breakdown.month,rowId:session.row!.id,expectedVersion:session.row!.version,expectedEditId:session.row!.editId,expectedSeriesVersion:session.row!.seriesVersion,action:'save',draft:values,newEditId:session.id});
    await onSaveFixedCosts(request);
   }else{
    const change=session.mode==='add'?buildCashPlanFixedCostAddChange({data,edits:edits!,businessId:breakdown.businessId,month:breakdown.month,id:session.id,draft:values}):buildCashPlanFixedCostChange({data,edits:edits!,businessId:breakdown.businessId,month:breakdown.month,rowId:session.row!.id,expectedVersion:session.row!.version,expectedEditId:session.row!.editId,action:'save',draft:values,newEditId:session.id});
    await onSave([change]);
   }
   const message=session.scope==='following'?`${monthLabel(breakdown.month)}부터 반복할 고정비 계획을 저장했습니다.`:`${monthLabel(breakdown.month)} 고정비 계획을 저장했습니다.`;
   setSession(null);setDiscardPrompt(false);setSuccess(message);toast.success(message);
  }catch(cause){setError(cause instanceof Error?cause.message:'저장하지 못했습니다. 입력값을 유지했습니다.');}
  finally{busy.current=false;setSubmitting(false);}
 }
 async function remove(){
  if(!removal||locked||busy.current||removalStale)return;
  busy.current=true;setSubmitting(true);setError('');
  try{
   if(removal.scope==='following'){
    const request=buildCashPlanFixedCostForwardChange({data,edits:edits!,businessId:breakdown.businessId,month:breakdown.month,rowId:removal.row.id,expectedVersion:removal.row.version,expectedEditId:removal.row.editId,expectedSeriesVersion:removal.row.seriesVersion,action:'remove',newEditId:removal.id});
    await onSaveFixedCosts(request);
   }else{
    const change=buildCashPlanFixedCostChange({data,edits:edits!,businessId:breakdown.businessId,month:breakdown.month,rowId:removal.row.id,expectedVersion:removal.row.version,expectedEditId:removal.row.editId,action:'remove',newEditId:removal.id});
    await onSave([change]);
   }
   const message=removal.scope==='following'?`${monthLabel(breakdown.month)}부터 고정비 합계에서 계속 제외했습니다.`:`${monthLabel(breakdown.month)} 고정비 합계에서 제외했습니다.`;
   setRemoval(null);setSuccess(message);toast.success(message);
  }catch(cause){setError(cause instanceof Error?cause.message:'삭제하지 못했습니다. 확인 내용을 유지했습니다.');}
  finally{busy.current=false;setSubmitting(false);}
 }
 return <>
  <DialogHeader className="cash-series-breakdown-heading"><div><DialogTitle>{breakdown.businessName} 기본 고정비</DialogTitle><DialogDescription>{monthLabel(breakdown.month)} 기준 · 이번 달만 또는 이번 달부터 계속 적용할 수 있습니다.</DialogDescription></div><Button type="button" variant="ghost" size="icon-sm" aria-label="고정비 내역 닫기" disabled={pending} onClick={close}><X size={17}/></Button></DialogHeader>
  <div className="cash-series-breakdown-body" aria-busy={pending}>
   {loadError&&<div className="cash-series-fixed-error" role="alert"><p>{loadError} 입력은 유지했습니다.</p><Button type="button" variant="outline" size="sm" disabled={pending} onClick={()=>void reload()}>최신 설정 불러오기</Button></div>}
   <div className="cash-series-fixed-toolbar"><span>{monthLabel(breakdown.month)} 계획 편집</span><div className="cash-series-fixed-toolbar-actions"><Button type="button" variant="outline" size="sm" disabled={locked||!!session||!!removal} onClick={()=>add('카드대금')}><CreditCard size={14}/>카드대금 입력</Button><Button type="button" variant="outline" size="sm" disabled={locked||!!session||!!removal} onClick={()=>add()}><Plus size={14}/>고정비 추가</Button></div></div>
   {success&&<p className="cash-series-fixed-success" role="status">{success}</p>}
   {!session&&!removal&&error&&<p className="cash-series-fixed-error" role="alert">{error}</p>}
   {session&&<CashPlanFixedCostForm draft={session.draft} month={breakdown.month} mode={session.mode} scope={session.scope} allowFollowing={allowsFollowing(session.row)} nominalDay={session.row?.nominalDay} originalDate={session.row?.date} accounts={accounts} pending={pending} stale={stale} saveDisabled={!!loadError||edits===null} error={error} dateInput={dateInput} onChange={change} onScopeChange={changeScope} onSave={()=>void save()} onCancel={cancel}/>}
   {removal&&<div className="cash-series-removal-review" role="alert"><h3>고정비 계획에서 삭제할까요?</h3><p><strong>{removal.row.title}</strong> · {amounts.format(removal.row.currentAmount)}원</p><CashPlanFixedCostScope scope={removal.scope} month={breakdown.month} pending={pending} allowFollowing={allowsFollowing(removal.row)} removing onChange={scope=>{setRemoval(current=>current?{...current,scope:allowsFollowing(current.row)?scope:'month'}:current);setError('');}}/><small>{removal.scope==='following'?`${monthLabel(breakdown.month)}부터 이후에도 계속 제외하며 이전 달과 기존 거래는 유지됩니다.`:`${monthLabel(breakdown.month)} 합계에서만 제외하며 다른 달과 기존 거래는 유지됩니다.`}</small>{removalStale&&<p className="cash-series-fixed-error">다른 관리자가 이 항목을 변경했습니다. 취소 후 최신 항목에서 다시 확인해주세요.</p>}{error&&<p className="cash-series-fixed-error">{error}</p>}<div><Button type="button" variant="outline" size="sm" disabled={pending} onClick={cancel}>취소</Button><Button type="button" variant="destructive" size="sm" disabled={locked||removalStale} onClick={()=>void remove()}>{pending?<LoaderCircle size={14} className="animate-spin"/>:<Trash2 size={14}/>} {removal.scope==='following'?'이 달부터 계속 삭제':'이 달에서 삭제'}</Button></div></div>}
   <CashPlanSeriesBreakdownDetails breakdown={breakdown} onEdit={begin} onRemove={reviewRemoval} disabled={locked||!!session||!!removal}/>
  </div>
  <footer className="cash-series-breakdown-footer">{discardPrompt?<div className="cash-series-discard-review" role="alert"><p>저장하지 않은 변경사항이 있습니다.</p><div><Button type="button" variant="outline" size="sm" onClick={()=>setDiscardPrompt(false)}>계속 입력</Button><Button type="button" variant="outline" size="sm" onClick={onClose}>저장 안 하고 닫기</Button></div></div>:<><p>실제 거래·출금 확인과 기존 제외 상태는 유지됩니다.<br/>지출계획표에는 조회기간에 포함된 항목이 표시됩니다.</p><Button type="button" variant="outline" size="sm" disabled={pending} onClick={close}>닫기</Button></>}</footer>
 </>;
}
