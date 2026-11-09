"use client";
import {FinancialValue,FinancialText,FinancialInput,useFinancialVisibility} from './financial-visibility';

import {useCallback,useEffect,useMemo,useRef,useState,type RefObject} from 'react';
import {Plus,RotateCcw,Save,X} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Dialog,DialogClose,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import type {CashPlanEditorItem} from '@/lib/finance/editable-cash-plan';
import type {CashPlanEdit} from '@/lib/finance/cash-plan-edits';
import {cashPlanMemoDisplay,cashPlanUserMemo,mergeCashPlanUserMemo} from '@/lib/finance/cash-plan-memo';
import type {Account,Business} from '@/lib/finance/types';
import {parseFinanceDate,type DateRange} from '@/lib/finance/date-range';
import {calendarMonthRange} from '@/lib/finance/transaction-calendar';
import type {CashPlanEditChange} from './use-cash-plan-edits';
import './cash-plan-editor.css';

type Props={business:Business|undefined;accounts:Account[];items:CashPlanEditorItem[];edits:CashPlanEdit[];range:DateRange;basis:'estimated'|'registered';saving:boolean;loadError:string;onReload:()=>Promise<void>;onSave:(changes:CashPlanEditChange[])=>Promise<CashPlanEdit[]>;onPreview:(change:Extract<CashPlanEditChange,{action:'save'}>)=>CashPlanEditorItem|undefined;onClose:()=>void;returnFocusRef:RefObject<HTMLButtonElement|null>};
type Draft={key:string|null;id:string;version:number;source_type:CashPlanEdit['source_type'];source_key:string;month:string;title:string;account_id:string;plan_date:string;amount:string;memo:string;source_memo:string;payment_kind:'tax'|'general';payment_status:'pending'|'paid'};
const digits=(value:number)=>value.toLocaleString('ko-KR');
const inputAmount=(value:string)=>Number(value.replaceAll(',','').trim());
const monthLabel=(month:string)=>`${month.slice(0,4)}년 ${Number(month.slice(5))}월`;
const editValues=(item:CashPlanEditorItem):Draft=>({key:item.key,id:item.edit?.id??crypto.randomUUID(),version:item.edit?.version??0,source_type:item.source_type,source_key:item.source_key,month:item.month,title:item.title,account_id:item.accountId??'',plan_date:item.date??'',amount:String(item.amount),memo:cashPlanUserMemo(item.memo),source_memo:item.memo,payment_kind:item.paymentKind??'general',payment_status:item.paymentStatus??'pending'});
const deleteChange=(edit:CashPlanEdit):CashPlanEditChange=>({action:'delete',id:edit.id,version:edit.version});

export function CashPlanEditorDialog(props:Props){
 const closeHandler=useRef<(()=>void)|null>(null);
 const registerClose=useCallback((handler:()=>void)=>{closeHandler.current=handler;},[]);
 // Remount only when the chosen business/period changes, not when shared
 // settings reload: a conflict must not discard the user's draft.
 return <Dialog open={!!props.business} onOpenChange={open=>{if(!open&&!props.saving)closeHandler.current?.();}}>
  <DialogContent className="cash-editor-dialog" showCloseButton={false} onEscapeKeyDown={event=>{if(props.saving)event.preventDefault();}} onInteractOutside={event=>{if(props.saving)event.preventDefault();}} onCloseAutoFocus={event=>{event.preventDefault();props.returnFocusRef.current?.focus({preventScroll:true});}}>
   {props.business&&<EditorBody key={`${props.business.id}:${props.range.from}:${props.range.to}:${props.basis}`} {...props} business={props.business} registerClose={registerClose}/>}
  </DialogContent>
 </Dialog>;
}

function EditorBody({business,accounts,items,edits,range,basis,saving,loadError,onReload,onSave,onPreview,onClose,registerClose}:Props&{business:Business;registerClose:(handler:()=>void)=>void}){
 const {privateText}=useFinancialVisibility();
 const [tab,setTab]=useState<'active'|'excluded'>('active');
 const [month,setMonth]=useState(range.from.slice(0,7));
 const [query,setQuery]=useState('');
 const [draft,setDraft]=useState<Draft|null>(null);
 const [error,setError]=useState('');
 const [discardPrompt,setDiscardPrompt]=useState(false);
 const dateInput=useRef<HTMLInputElement|null>(null);
 const businessItems=useMemo(()=>items.filter(item=>item.businessId===business.id&&(item.source_type===basis||item.source_type==='manual'||!!item.seriesId)),[items,business.id,basis]);
 const months=useMemo(()=>{
  const result:string[]=[];
  let value=range.from.slice(0,7);const last=range.to.slice(0,7);
  while(value<=last){result.push(value);if(value===last)break;const [year,number]=value.split('-').map(Number);value=`${number===12?year+1:year}-${String(number===12?1:number+1).padStart(2,'0')}`;}
  return result;
 },[range]);
 const scope=businessItems.filter(item=>item.month===month);
 const shown=scope.filter(item=>item.excluded===(tab==='excluded')&&`${item.title} ${cashPlanMemoDisplay(item.memo)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 const businessAccounts=accounts.filter(account=>account.business_id===business.id);
 const currentItem=draft?.key?businessItems.find(item=>item.key===draft.key):undefined;
 const savedEdit=draft?edits.find(edit=>edit.id===draft.id):undefined;
 const stale=!!draft&&((draft.version>0&&!savedEdit)||(savedEdit&&savedEdit.version!==draft.version)||(currentItem?.edit&&currentItem.edit.id!==draft.id));
 const locked=saving||!!loadError||!!currentItem?.seriesExcludedFrom;
 const numeric=draft?inputAmount(draft.amount):0;
 const previewAmount=Number.isSafeInteger(numeric)&&numeric>=0?numeric:0;
 const preview=useMemo(()=>draft?onPreview({action:'save',id:draft.id,version:draft.version,business_id:business.id,source_type:draft.source_type,source_key:draft.source_key,month:draft.month,title:draft.title||'입력 중',account_id:draft.account_id||null,plan_date:draft.plan_date||null,amount:previewAmount,memo:mergeCashPlanUserMemo(draft.source_memo,draft.memo),excluded:false,payment_kind:draft.payment_kind,payment_status:draft.payment_status}):undefined,[draft,previewAmount,business.id,onPreview]);
 const recorded=preview?.recordedAmount??0;
 const previewRemaining=preview?.remainingAmount??0;
 const activeTotal=scope.filter(item=>!item.excluded).reduce((sum,item)=>sum+item.remainingAmount,0);
 function begin(item:CashPlanEditorItem){if(item.seriesExcludedFrom)return;setDraft(editValues(item));setError('');setDiscardPrompt(false);}
 function add(){const id=crypto.randomUUID();setDraft({key:null,id,version:0,source_type:'manual',source_key:id,month,title:'',account_id:'',plan_date:'',amount:'',memo:'',source_memo:'',payment_kind:'general',payment_status:'pending'});setError('');setDiscardPrompt(false);}
 function change(patch:Partial<Draft>){setDraft(value=>value?{...value,...patch}:null);setError('');}
 async function mutate(changes:CashPlanEditChange[],message:string,closeDraft=false){
  if(locked)return;
  setError('');
  try{await onSave(changes);if(closeDraft)setDraft(null);toast.success(<FinancialText value={String(message)}/>);}
  catch(cause){setError(cause instanceof Error?cause.message:'변경사항을 저장하지 못했습니다. 입력값은 유지했습니다.');}
 }
 function baseChange(item:CashPlanEditorItem,allMonths=false):CashPlanEditChange{
  const edit=allMonths?item.globalEdit:item.edit;
  return {action:'save',id:edit?.id??crypto.randomUUID(),version:edit?.version??0,business_id:business.id,source_type:item.source_type,source_key:item.source_key,month:allMonths?'*':item.month,title:item.title,account_id:item.accountId,plan_date:allMonths?null:item.date,amount:item.amount,memo:item.memo,excluded:true,payment_kind:item.paymentKind??'general',payment_status:item.paymentStatus??'pending'};
 }
 function restore(item:CashPlanEditorItem){
  if(item.seriesExcludedFrom)return;
  const changes:CashPlanEditChange[]=[];
  if(item.globalEdit?.excluded)changes.push(deleteChange(item.globalEdit));
  if(item.edit?.excluded){const edit=item.edit;changes.push({action:'save',id:edit.id,version:edit.version,business_id:edit.business_id,source_type:edit.source_type,source_key:edit.source_key,month:edit.month,title:edit.title,account_id:edit.account_id,plan_date:edit.plan_date,amount:edit.amount,memo:edit.memo,excluded:false,payment_kind:edit.payment_kind??'general',payment_status:edit.payment_status??'pending'});}
  if(changes.length)void mutate(changes,item.globalEdit?'모든 달의 제외 설정을 복원했습니다.':'이 달의 항목을 복원했습니다.',draft?.key===item.key);
 }
 async function saveDraft(){
  if(!draft||locked)return;
  // Native date controls can emit input before React's change event. Read the
  // actual field at commit time as well, so the visible date is what we save.
  const planDate=dateInput.current?.value??draft.plan_date;
  if(planDate!==draft.plan_date)change({plan_date:planDate});
  if(stale){setError('다른 관리자의 최신 설정을 먼저 확인해 주세요. 입력값은 유지되어 있습니다.');return;}
  if(!draft.title.trim()){setError('품목을 입력해 주세요.');return;}
  if(!draft.amount.trim()||!Number.isSafeInteger(numeric)||numeric<0){setError('금액은 0원 이상의 원 단위 정수로 입력해 주세요.');return;}
  if(draft.payment_kind==='tax'&&(!planDate||numeric<=0)){setError('세금 일정은 납부기한과 1원 이상의 고지 금액을 반드시 입력해 주세요.');return;}
  if(dateInput.current?.validity.badInput||(planDate&&(!parseFinanceDate(planDate)||planDate.slice(0,7)!==draft.month))){setError('날짜는 편집 중인 달 안에서 완전하게 입력해 주세요.');return;}
  if(draft.account_id&&!businessAccounts.some(account=>account.id===draft.account_id)){setError('이 사업자의 계좌를 선택해 주세요.');return;}
  await mutate([{action:'save',id:draft.id,version:draft.version,business_id:business.id,source_type:draft.source_type,source_key:draft.source_key,month:draft.month,title:draft.title.trim(),account_id:draft.account_id||null,plan_date:planDate||null,amount:numeric,memo:mergeCashPlanUserMemo(draft.source_memo,draft.memo.trim()),excluded:false,payment_kind:draft.payment_kind,payment_status:draft.payment_status}],'계획을 저장했습니다.',true);
 }
 const accountText=(id:string|null)=>{const account=businessAccounts.find(item=>item.id===id);return account?[account.name,account.bank,account.masked_number].filter(Boolean).join(' · '):'계좌 미지정';};
 const close=useCallback(()=>{if(saving)return;if(draft){setDiscardPrompt(true);return;}onClose();},[saving,draft,onClose]);
 useEffect(()=>registerClose(close),[registerClose,close]);
 return <>
  <DialogHeader className="cash-editor-heading"><div><DialogTitle>{business.name} 계획 편집</DialogTitle><DialogDescription>{range.from} ~ {range.to} · {basis==='estimated'?'반복 출금 추정':'등록된 예정 지출'}<br/>저장한 계획은 모든 관리자가 공유하며 통장 동기화 후에도 유지됩니다.</DialogDescription></div><Button type="button" variant="ghost" size="icon" aria-label="계획 편집 닫기" disabled={saving} onClick={close}><X size={18}/></Button></DialogHeader>
  <div className="cash-editor-body">
   {loadError&&<div className="cash-editor-error" role="alert"><p><FinancialText value={loadError}/> 공동 설정을 확인할 때까지 편집과 저장을 잠시 중단합니다.</p><Button type="button" variant="outline" onClick={()=>void onReload()}>설정 다시 불러오기</Button></div>}
   {discardPrompt&&<div className="cash-editor-error" role="alert"><p>저장하지 않은 입력값이 있습니다.</p><Button type="button" variant="outline" onClick={()=>setDiscardPrompt(false)}>계속 편집</Button><Button type="button" variant="outline" onClick={onClose}>입력 취소하고 닫기</Button></div>}
   <div className="cash-editor-toolbar"><label>편집할 달<select value={month} disabled={saving||!!draft} onChange={event=>setMonth(event.target.value)}>{months.map(value=><option key={value} value={value}>{monthLabel(value)}</option>)}</select></label><Input aria-label="계획 품목 검색" placeholder="품목·비고 검색" value={query} onChange={event=>setQuery(event.target.value)}/><Button type="button" variant="outline" disabled={locked||!!draft} onClick={add}><Plus size={15}/>항목 추가</Button></div>
   <div className="cash-editor-tabbar" role="group" aria-label="편집 항목 구분"><button type="button" aria-pressed={tab==='active'} onClick={()=>setTab('active')}>사용 항목 {scope.filter(item=>!item.excluded).length}</button><button type="button" aria-pressed={tab==='excluded'} onClick={()=>setTab('excluded')}>제외 항목 {scope.filter(item=>item.excluded).length}</button><span>조회 기간 남은 지출 <FinancialValue value={digits(activeTotal)}/>원</span></div>
   <div className="cash-editor-table-wrap" tabIndex={0} role="region" aria-label={privateText(`${business.name} 편집 가능한 지출 항목`)}><table className="cash-editor-table"><caption className="sr-only">품목과 날짜, 월 계획 금액, 반영 출금, 남은 예산, 출금 계좌 및 편집 버튼</caption><thead><tr><th>품목·날짜</th><th>월 계획 금액</th><th>반영 출금</th><th>남은 예산</th><th>계좌·비고</th><th>관리</th></tr></thead><tbody>{shown.map(item=><tr key={item.key} className={draft?.key===item.key?'selected':''}><th scope="row"><strong>{item.paymentKind==='tax'&&<span className="tax-payment-badge">{item.paymentStatus==='paid'?'세금 · 납부 완료':'세금 · 납부기한'}</span>} <FinancialText value={item.title}/></strong><small>{item.date??'날짜 미정'} · {item.source_type==='manual'?'직접 추가':item.edit?'수정됨':item.source_type==='registered'?'등록 일정':'추정'}{!item.inRange?' · 조회 기간 밖':''}{item.seriesExcludedFrom?` · ${monthLabel(item.seriesExcludedFrom)}부터 계속 제외`:item.globalEdit?.excluded?' · 모든 달 제외':''}</small></th><td><FinancialValue value={digits(item.amount)}/></td><td><FinancialValue value={digits(item.recordedAmount)}/></td><td>{item.excluded?'제외':<FinancialValue value={digits(item.remainingAmount)}/>}</td><td><FinancialText value={accountText(item.accountId)}/>{cashPlanMemoDisplay(item.memo)&&<small><FinancialText value={cashPlanMemoDisplay(item.memo)}/></small>}</td><td><div className="cash-editor-row-actions">{item.excluded?<Button type="button" variant="outline" size="sm" disabled={locked||!!draft||!!item.seriesExcludedFrom} title={item.seriesExcludedFrom?privateText('계속 제외한 고정비는 월별 복원으로 다시 포함하지 않습니다.'):undefined} onClick={()=>restore(item)}>{!item.seriesExcludedFrom&&<RotateCcw size={13}/>} {item.seriesExcludedFrom?'계속 제외':'복원'}</Button>:<><Button type="button" variant="ghost" size="sm" disabled={locked||!!draft} onClick={()=>begin(item)}>수정</Button><Button type="button" variant="ghost" size="sm" disabled={locked||!!draft} onClick={()=>void mutate([baseChange(item)],'이 달의 계획에서 제외했습니다.')}>제외</Button></>}</div></td></tr>)}</tbody></table>{shown.length===0&&<p className="cash-editor-empty">{tab==='excluded'?'제외한 항목이 없습니다.':'표시할 항목이 없습니다. 새 지출은 항목 추가로 입력하세요.'}</p>}</div>
   <p className="cash-editor-help">금액은 월 전체 예산입니다. 추정 항목은 같은 원본의 반영 출금을 차감합니다. 직접 추가·등록 항목은 실적과 자동 연결되지 않으므로 실제 지급 후 계획을 수정하거나 제외하세요.</p>
   {draft&&<form className="cash-editor-form" onSubmit={event=>{event.preventDefault();void saveDraft();}}>
    <h3>{draft.payment_kind==='tax'&&<span className="tax-payment-badge">세금 납부 일정</span>} {draft.key?'항목 수정':'항목 추가'} · {monthLabel(draft.month)}</h3>
    {stale&&<div className="cash-editor-error" role="alert"><p>이 항목의 공동 설정이 변경되었습니다. 아래 입력값은 유지했습니다. 최신값을 불러오면 현재 입력은 바뀝니다.</p><Button type="button" variant="outline" disabled={locked} onClick={()=>{if(currentItem)begin(currentItem);else setDraft(null);}}>최신값으로 다시 편집</Button></div>}
    {currentItem?.seriesExcludedFrom&&<p className="cash-editor-error" role="alert">{monthLabel(currentItem.seriesExcludedFrom)}부터 계속 제외된 고정비입니다. 이 달의 수정으로 다시 포함하지 않습니다.</p>}
    <fieldset disabled={locked}><div className="cash-editor-fields">
     {!draft.key&&draft.version===0&&draft.source_type==='manual'&&<label>항목 구분<select value={draft.payment_kind} onChange={event=>change({payment_kind:event.target.value==='tax'?'tax':'general',payment_status:'pending'})}><option value="general">일반 지출</option><option value="tax">세금 납부</option></select></label>}
     <label className="cash-editor-title-field">품목<Input value={privateText(draft.title)} readOnly={privateText(draft.title)!==draft.title} maxLength={200} onChange={event=>change({title:event.target.value})} required/></label><label>{draft.payment_kind==='tax'?'납부기한':'출금일'}<input ref={dateInput} type="date" value={draft.plan_date} min={calendarMonthRange(draft.month).from} max={calendarMonthRange(draft.month).to} onInput={event=>change({plan_date:event.currentTarget.value})} onChange={event=>change({plan_date:event.currentTarget.value})} required={draft.payment_kind==='tax'}/><small>{draft.payment_kind==='tax'?'납부기한 필수':'비워 두면 날짜 미정'}</small></label><label>월 계획 금액 (원)<FinancialInput inputMode="numeric" value={draft.amount} onChange={event=>change({amount:event.target.value})} required/></label><label>출금 계좌<select value={draft.account_id} onChange={event=>change({account_id:event.target.value})}><option value="">계좌 미지정</option>{businessAccounts.map(account=><option key={account.id} value={account.id}>{privateText(accountText(account.id))}</option>)}</select><small>계좌를 지정하면 계좌별 필요자금에 반영합니다.</small></label><label className="cash-editor-memo-field">비고<Textarea rows={2} maxLength={2000} value={privateText(draft.memo)} readOnly={privateText(draft.memo)!==draft.memo} onChange={event=>change({memo:event.target.value})}/></label></div></fieldset>
    <div className="cash-editor-preview"><span>월 계획 금액 <b><FinancialValue value={digits(previewAmount)}/>원</b></span><span>월 반영 출금 <b><FinancialValue value={digits(recorded)}/>원</b></span><span>조회 기간 남은 예산 <b><FinancialValue value={digits(previewRemaining)}/>원</b></span></div>
    <p className="cash-editor-help">날짜 미정 예산은 조회 일수에 맞춰 안분합니다. 조회 기간 밖의 날짜는 합계에서 제외합니다.{draft.source_type==='estimated'&&' 계좌를 바꿔도 반영 실적은 원본 계좌를 기준으로 유지합니다.'}</p>
    {draft.payment_kind==='tax'&&<p className="cash-editor-tax-note">세금 납부일과 금액은 고지서를 기준으로 확인해 주세요. 계획에서 제외해도 미납 알림은 유지하며, 실제 납부 후 화면 상단의 ‘납부 일정 확인’에서 완료로 표시합니다.</p>}
    {currentItem&&!currentItem.inRange&&<p className="cash-editor-help">현재 날짜는 조회 기간 밖입니다. 해당 월 안에서 날짜를 변경할 수 있으며, 조회 기간에 포함된 항목만 합계에 반영됩니다.</p>}
    <div className="cash-editor-form-actions"><div>{currentItem?.edit&&!(currentItem.paymentKind==='tax'&&currentItem.paymentStatus!=='paid')&&<Button type="button" variant="ghost" disabled={locked} onClick={()=>void mutate([deleteChange(currentItem.edit!)],currentItem.source_type==='manual'?'직접 추가 항목을 제거했습니다.':'수정 전 계획으로 되돌렸습니다.',true)}><RotateCcw size={14}/>{currentItem.source_type==='manual'?'추가 항목 삭제':'원래 계획으로'}</Button>}{currentItem&&currentItem.source_type!=='manual'&&<Button type="button" variant="ghost" disabled={locked} onClick={()=>void mutate([baseChange(currentItem,true)],'모든 달의 계획에서 제외했습니다.',true)}>모든 달에서 제외</Button>}</div><div><Button type="button" variant="outline" disabled={saving} onClick={()=>{setDraft(null);setError('');}}>입력 취소</Button><Button type="submit" disabled={locked||stale}><Save size={15}/>{saving?'저장 중…':'계획 저장'}</Button></div></div>
   </form>}
   {error&&<p className="cash-editor-error" role="alert"><FinancialText value={error}/></p>}
  </div>
  <div className="cash-editor-footer"><span>실제 거래·통장 잔액은 변경하지 않습니다. ‘제외’한 항목은 제외 탭에서 복원할 수 있습니다.</span><DialogClose asChild><Button type="button" variant="outline" disabled={saving||!!draft}>닫기</Button></DialogClose></div>
 </>;
}
