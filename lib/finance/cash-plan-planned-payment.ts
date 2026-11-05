import {cashPlanChangeSchema,type CashPlanChange} from './cash-plan-edits';
import type {CashPlanEditorItem} from './editable-cash-plan';
import {cashPlanUserMemo,mergeCashPlanUserMemo} from './cash-plan-memo';

export type CashPlanPlannedPayment={amount:number;date:string|null;memo:string};

/** A scheduled charge is a plan edit, never proof of a future withdrawal.
 * The existing save action preserves stored confirmation metadata server-side.
 * Import provenance and source identity stay separate from editable notes. */
export function cashPlanPlannedPaymentChange(item:CashPlanEditorItem,values:CashPlanPlannedPayment):Extract<CashPlanChange,{action:'save'}>{
 if(item.paymentKind==='tax'||item.edit?.payment_kind==='tax')throw Error('세금 일정은 계획 편집에서 납부기일과 금액을 수정해주세요.');
 if(item.excluded)throw Error('제외된 항목은 먼저 계획에서 복원해주세요.');
 const change:Extract<CashPlanChange,{action:'save'}>={
  action:'save',id:item.edit?.id??crypto.randomUUID(),version:item.edit?.version??0,
  business_id:item.businessId,source_type:item.source_type,source_key:item.source_key,month:item.month,
  title:item.title,account_id:item.accountId,plan_date:values.date,amount:values.amount,
  memo:mergeCashPlanUserMemo(item.memo,cashPlanUserMemo(values.memo)),excluded:item.excluded,
  payment_kind:item.paymentKind??item.edit?.payment_kind??'general',payment_status:item.paymentStatus??item.edit?.payment_status??'pending',
 };
 return cashPlanChangeSchema.parse(change) as Extract<CashPlanChange,{action:'save'}>;
}
