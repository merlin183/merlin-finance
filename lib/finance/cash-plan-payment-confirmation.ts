import type {CashPlanChange,CashPlanEdit} from './cash-plan-edits';
import type {CashPlanEditorItem} from './editable-cash-plan';
import {parseFinanceDate} from './date-range';

export type CashPlanPaymentConfirmation={amount:number;date:string;complete:boolean;memo:string};

/** Invalid or future evidence is ignored, even if an old client supplied it.
 * The explicit confirmation is cumulative for one plan/month. Never add it to
 * later matching bank actuals; both can describe the same payment. */
export function cashPlanPaymentConfirmation(edit:CashPlanEdit|undefined,asOf:string):CashPlanPaymentConfirmation|null{
 if(!edit||edit.payment_kind==='tax'||!Number.isSafeInteger(edit.confirmed_amount)||edit.confirmed_amount!<=0
  ||typeof edit.confirmed_date!=='string'||!parseFinanceDate(edit.confirmed_date)||!edit.confirmed_date.startsWith(`${edit.month}-`)
  ||edit.confirmed_date>asOf||typeof edit.confirmation_complete!=='boolean')return null;
 return {amount:edit.confirmed_amount!,date:edit.confirmed_date,complete:edit.confirmation_complete,memo:edit.confirmation_memo??''};
}

/** Full source identity permits an unsaved estimate to be confirmed atomically.
 * For existing rows the server changes only confirmation metadata. */
export function cashPlanPaymentConfirmationChange(item:CashPlanEditorItem,confirmation:(Omit<CashPlanPaymentConfirmation,'memo'>&{memo?:string})|null):Extract<CashPlanChange,{action:'payment_confirmation'}>{
 if(item.paymentKind==='tax')throw Error('세금 일정은 납부 완료 표시를 사용해주세요.');
 if(item.excluded)throw Error('제외된 항목은 먼저 계획에서 복원해주세요.');
 if(!confirmation&&!item.edit)throw Error('저장된 출금 확인이 없습니다.');
 return {action:'payment_confirmation',id:item.edit?.id??crypto.randomUUID(),version:item.edit?.version??0,
  business_id:item.businessId,source_type:item.source_type,source_key:item.source_key,month:item.month,
  title:item.title,account_id:item.accountId,plan_date:item.date,amount:item.amount,memo:item.memo,excluded:false,
  confirmed_amount:confirmation?.amount??null,confirmed_date:confirmation?.date??null,confirmation_complete:confirmation?.complete??false,confirmation_memo:confirmation?.memo??''};
}
