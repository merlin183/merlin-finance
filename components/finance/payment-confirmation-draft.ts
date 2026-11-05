import {parseFinanceDate} from '@/lib/finance/date-range';
import {cashPlanUserMemo} from '@/lib/finance/cash-plan-memo';

export type PaymentConfirmationDraft={amount:string;date:string;complete:boolean;memo:string};
export type PlannedPaymentDraft={amount:string;date:string;memo:string};
export type PaymentConfirmationMode='planned'|'actual';
export type PaymentConfirmationDrafts={planned:PlannedPaymentDraft;actual:PaymentConfirmationDraft};
type Confirmation={amount:number;date:string;complete:boolean;memo?:string}|null;

/** A future plan edits its budget, not a payment. Existing direct confirmation
 * always opens in actual mode, including when the plan date later changes. */
export function initialPaymentConfirmationMode({confirmation,date}:{confirmation:Confirmation;date:string|null},asOf:string):PaymentConfirmationMode{
 return !confirmation&&date!==null&&!!parseFinanceDate(date)&&date>asOf?'planned':'actual';
}

export function initialPlannedPaymentDraft({amount,date,memo}:{amount:number;date:string|null;memo:string}):PlannedPaymentDraft{
 return {amount:String(amount),date:date&&parseFinanceDate(date)?date:'',memo:cashPlanUserMemo(memo)};
}

/** Switching modes does not discard either input. A hidden actual completion
 * value is deliberately ignored when changing a planned amount. */
export function updatePaymentConfirmationDraft(drafts:PaymentConfirmationDrafts,mode:PaymentConfirmationMode,patch:Partial<PaymentConfirmationDraft>):PaymentConfirmationDrafts{
 if(mode==='actual')return {...drafts,actual:{...drafts.actual,...patch}};
 const planned={...drafts.planned};
 if(patch.amount!==undefined)planned.amount=patch.amount;
 if(patch.date!==undefined)planned.date=patch.date;
 if(patch.memo!==undefined)planned.memo=patch.memo;
 return {...drafts,planned};
}

export function paymentConfirmationDraftsDirty(original:PaymentConfirmationDrafts,current:PaymentConfirmationDrafts):boolean{
 return (['amount','date','memo'] as const).some(key=>original.planned[key]!==current.planned[key])
  ||(['amount','date','memo','complete'] as const).some(key=>original.actual[key]!==current.actual[key]);
}

/** The saved actual date takes priority over a valid suggested plan date.
 * Suggestions do not establish a payment or automatically mark it complete. */
export function initialPaymentConfirmationDraft({confirmation,recordedAmount,originalAmount,date:planDate}:{confirmation:Confirmation;recordedAmount:number|null;originalAmount:number;date?:string|null}):PaymentConfirmationDraft{
 const suggestedDate=planDate&&parseFinanceDate(planDate)?planDate:'';
 return {amount:String(confirmation?.amount??(recordedAmount!==null&&recordedAmount>0?recordedAmount:originalAmount)),date:confirmation?.date??suggestedDate,complete:confirmation?.complete??false,memo:confirmation?.memo??''};
}

export function paymentConfirmationDraftError(draft:PaymentConfirmationDraft,month:string,asOf:string):string{
 const amount=draft.amount.replaceAll(',','').trim();
 if(!/^\d+$/.test(amount)||!Number.isSafeInteger(Number(amount))||Number(amount)<=0)return '실제 출금액은 1원 이상의 원 단위 정수로 입력해 주세요.';
 if(!parseFinanceDate(draft.date)||draft.date.slice(0,7)!==month)return '실제 출금일은 이 계획의 달 안에서 선택해 주세요.';
 if(draft.date>asOf)return '아직 지나지 않은 날짜를 실제 출금일로 확인할 수 없습니다. 예정일·금액은 ‘예정 금액 수정’에서 저장해 주세요.';
 if(draft.memo.length>2000)return '확인 메모는 2,000자 이내로 입력해 주세요.';
 return '';
}

export function paymentConfirmationDraftValues(draft:PaymentConfirmationDraft){
 return {amount:Number(draft.amount.replaceAll(',','').trim()),date:draft.date,complete:draft.complete,memo:draft.memo.trim()};
}

export function plannedPaymentDraftError(draft:PlannedPaymentDraft,month:string):string{
 const amount=draft.amount.replaceAll(',','').trim();
 if(!/^\d+$/.test(amount)||!Number.isSafeInteger(Number(amount)))return '예정 출금액은 0원 이상의 원 단위 정수로 입력해 주세요.';
 if(draft.date&&(!parseFinanceDate(draft.date)||draft.date.slice(0,7)!==month))return '예정 출금일은 이 계획의 달 안에서 선택해 주세요.';
 if(draft.memo.length>2000)return '계획 메모는 2,000자 이내로 입력해 주세요.';
 return '';
}

export function plannedPaymentDraftValues(draft:PlannedPaymentDraft){
 return {amount:Number(draft.amount.replaceAll(',','').trim()),date:draft.date||null,memo:draft.memo.trim()};
}
