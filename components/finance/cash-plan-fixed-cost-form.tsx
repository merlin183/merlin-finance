import {useId,type RefObject} from 'react';
import {Check,LoaderCircle} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import type {Account} from '@/lib/finance/types';
import {parseFinanceDate} from '@/lib/finance/date-range';
import {calendarMonthRange} from '@/lib/finance/transaction-calendar';
import type {FixedCostDraft} from '@/lib/finance/cash-plan-series-edit';

export type FixedCostFormDraft={title:string;amount:string;date:string;accountId:string;memo:string;groupLabel:string};
export type FixedCostFormScope='month'|'following';
export const fixedCostGroups=['급여','사회보험','세금·원천세','임차료','세무기장','통신','은행 정기수수료','정기 서비스·구독','카드대금','기타 고정비'];

export function fixedCostFormError(draft:FixedCostFormDraft,month:string,accounts:readonly Account[]):string{
 const amount=Number(draft.amount.replaceAll(',','').trim());
 if(!draft.title.trim())return '품목·대상을 입력해주세요.';
 if(!draft.amount.trim()||!Number.isSafeInteger(amount)||amount<0)return '금액은 0원 이상의 원 단위 정수로 입력해주세요.';
 if(draft.date&&(!parseFinanceDate(draft.date)||draft.date.slice(0,7)!==month))return '예정일은 선택한 달 안에서 입력해주세요.';
 if(draft.accountId&&!accounts.some(account=>account.id===draft.accountId))return '이 사업자의 출금 계좌를 선택해주세요.';
 if(!draft.groupLabel.trim())return '고정비 분류를 선택해주세요.';
 return '';
}

export function fixedCostFormValues(draft:FixedCostFormDraft):FixedCostDraft{
 return {title:draft.title.trim(),amount:Number(draft.amount.replaceAll(',','').trim()),date:draft.date||null,accountId:draft.accountId||null,memo:draft.memo.trim(),groupLabel:draft.groupLabel};
}

export function CashPlanFixedCostScope({scope,month,pending,onChange,removing=false,allowFollowing=true}:{scope:FixedCostFormScope;month:string;pending:boolean;onChange:(scope:FixedCostFormScope)=>void;removing?:boolean;allowFollowing?:boolean}){
 const name=useId();
 const activeScope=allowFollowing?scope:'month';
 return <fieldset className="cash-series-scope" disabled={pending}><legend>적용 범위 <small>{month.slice(0,4)}년 {Number(month.slice(5,7))}월 기준</small></legend><div><label><input type="radio" name={name} value="month" checked={activeScope==='month'} onChange={()=>onChange('month')}/><span>이번 달만</span></label><label><input type="radio" name={name} value="following" disabled={!allowFollowing} checked={activeScope==='following'} onChange={()=>{if(allowFollowing)onChange('following');}}/><span>이번 달부터 계속</span></label></div><p>{!allowFollowing?'지출계획표에서 연결한 항목은 이 달에만 적용합니다.':activeScope==='month'?`선택한 ${month}에만 ${removing?'제외':'적용'}합니다.`:`선택한 ${month}부터 ${removing?'이후에도 계속 제외합니다.':'매월 반복 적용합니다.'} 이전 달은 바뀌지 않습니다.`}</p></fieldset>;
}

export function CashPlanFixedCostForm({draft,month,mode,scope,nominalDay,originalDate,accounts,pending,stale,saveDisabled=false,allowFollowing=true,error,dateInput,onChange,onScopeChange,onSave,onCancel}:{
 draft:FixedCostFormDraft;month:string;mode:'add'|'edit';scope:FixedCostFormScope;nominalDay?:number|null;originalDate?:string|null;accounts:readonly Account[];pending:boolean;stale:boolean;saveDisabled?:boolean;allowFollowing?:boolean;error:string;
 dateInput:RefObject<HTMLInputElement|null>;onChange:(patch:Partial<FixedCostFormDraft>)=>void;onScopeChange:(scope:FixedCostFormScope)=>void;onSave:()=>void;onCancel:()=>void;
}){
 const range=calendarMonthRange(month),locked=pending||stale||saveDisabled,isCardBill=draft.groupLabel==='카드대금';
 const activeScope=allowFollowing?scope:'month';
 const repeatingDay=draft.date?(draft.date===originalDate&&nominalDay!=null?nominalDay:parseFinanceDate(draft.date)?Number(draft.date.slice(-2)):null):null;
 return <form className="cash-series-fixed-form" noValidate onSubmit={event=>{event.preventDefault();onSave();}} aria-label={isCardBill?mode==='add'?'이 달 카드대금 입력':'이 달 카드대금 수정':mode==='add'?'이 달 고정비 추가':'이 달 고정비 수정'}>
  <header><h3>{isCardBill?mode==='add'?'카드대금 입력':'카드대금 수정':mode==='add'?'고정비 추가':'고정비 수정'}</h3><span>{month}{activeScope==='following'?'부터 계속':'에만 적용'}</span></header>
  {isCardBill&&<p className="cash-series-fixed-guidance">카드사 청구서의 결제 예정 금액과 결제일을 직접 입력해주세요. 기본 적용 범위는 이번 달만입니다. 기존 카드 청구·구독·할부 계획에 포함된 금액인지 확인해주세요.</p>}
  <CashPlanFixedCostScope scope={activeScope} month={month} pending={pending} allowFollowing={allowFollowing} onChange={onScopeChange}/>
  <div className="cash-series-fixed-fields">
   <label className="cash-series-fixed-wide">품목·대상<Input autoFocus value={draft.title} maxLength={500} disabled={pending} onChange={event=>onChange({title:event.target.value})} placeholder={isCardBill?'카드사·결제월 또는 품목':'거래처·이름 또는 품목'}/></label>
   <label>{isCardBill?'청구 금액 (원)':'계획 금액 (원)'}<Input type="text" inputMode="numeric" value={draft.amount} disabled={pending} onChange={event=>onChange({amount:event.target.value})} placeholder="0"/></label>
   <label>예정일<Input ref={dateInput} type="date" min={range.from} max={range.to} value={draft.date} disabled={pending} onChange={event=>onChange({date:event.target.value})}/><small>{activeScope==='following'?draft.date?`매월 ${repeatingDay??'선택한'}일에 적용합니다. 짧은 달은 말일로 계산합니다.`:'빈 날짜는 날짜 미정 월 예산으로 반복합니다.':'일정이 없으면 비워두세요.'}</small></label>
   <label>출금 계좌<select value={draft.accountId} disabled={pending} onChange={event=>onChange({accountId:event.target.value})}><option value="">계좌 미지정</option>{accounts.map(account=><option key={account.id} value={account.id}>{[account.bank,account.name,account.masked_number].filter(Boolean).join(' · ')}</option>)}</select></label>
   <label>고정비 분류{mode==='add'?<select value={draft.groupLabel} disabled={pending} onChange={event=>onChange({groupLabel:event.target.value})}>{fixedCostGroups.map(group=><option key={group} value={group}>{group}</option>)}</select>:<Input value={draft.groupLabel} disabled={pending} readOnly/>}</label>
   <label className="cash-series-fixed-wide">메모<Textarea value={draft.memo} maxLength={1500} disabled={pending} onChange={event=>onChange({memo:event.target.value})} placeholder="계획에 필요한 메모" rows={2}/></label>
  </div>
  {stale&&<p className="cash-series-fixed-error" role="alert">다른 관리자가 이 항목을 변경했습니다. 입력은 유지했습니다. 취소한 뒤 최신 항목에서 다시 편집해주세요.</p>}
  {error&&<p className="cash-series-fixed-error" role="alert">{error}</p>}
  <footer><Button type="button" variant="outline" size="sm" disabled={pending} onClick={onCancel}>입력 취소</Button><Button type="submit" size="sm" disabled={locked}>{pending?<LoaderCircle size={14} className="animate-spin"/>:<Check size={14}/>} {pending?'저장 중…':activeScope==='following'?'이 달부터 계속 저장':'이 달 계획 저장'}</Button></footer>
 </form>;
}
