import type {CashPlanChange,CashPlanEdit} from './cash-plan-edits';
import type {CashPlanEditorItem} from './editable-cash-plan';
import {parseFinanceDate} from './date-range';

export type CashPlanPaymentConfirmation={amount:number;date:string;complete:boolean;memo:string;returnedAmount?:number;returnedDate?:string};

const returnPrefix='[cash-plan-return:';
const returnMarker=/^\[cash-plan-return:v1:([^\]\r\n]+)\]$/;
const positiveMoney=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const validReturn=(amount:unknown,date:unknown,gross:number,month:string):amount is number=>positiveMoney(amount)&&amount<=gross&&typeof date==='string'&&!!parseFinanceDate(date)&&date.startsWith(`${month}-`);

/** Return evidence is explicit plan metadata, not an inferred bank credit. The
 * existing memo column keeps the gross payment and its return atomic without
 * changing bank transactions or silently reinterpreting older confirmations. */
function readConfirmationMemo(memo:string,gross:number,month:string,asOf:string):Pick<CashPlanPaymentConfirmation,'memo'|'returnedAmount'|'returnedDate'>{
 const lines=memo.split('\n'),indexes=lines.flatMap((line,index)=>line.includes(returnPrefix)?[index]:[]);
 if(!indexes.length)return {memo};
 const userMemo=lines.filter((_,index)=>!indexes.includes(index)).join('\n');
 // Malformed, duplicated and unknown-version metadata can never reduce gross.
 if(indexes.length!==1)return {memo:userMemo};
 const index=indexes[0],match=returnMarker.exec(lines[index].trim());
 if(!match)return {memo:userMemo};
 let value:unknown;
 try{value=JSON.parse(decodeURIComponent(match[1]));}catch{return {memo:userMemo};}
 if(!value||typeof value!=='object'||Array.isArray(value))return {memo:userMemo};
 const returned=value as Record<string,unknown>;
 if(Object.keys(returned).sort().join(',')!=='amount,date'||!validReturn(returned.amount,returned.date,gross,month)||String(returned.date)>asOf)return {memo:userMemo};
 return {memo:userMemo,returnedAmount:returned.amount,returnedDate:returned.date as string};
}

/** The API applies the same strict decoder before persisting return metadata.
 * A future credit cannot be stored now and silently become actual evidence later. */
export function cashPlanPaymentConfirmationMemoError(memo:string,gross:number,month:string,asOf:string):string{
 if(!memo.includes(returnPrefix))return '';
 return readConfirmationMemo(memo,gross,month,asOf).returnedAmount===undefined?'반환 입금 정보가 올바르지 않습니다. 출금액 이하의 반환 금액과 이미 입금된 해당 월의 날짜를 확인해 주세요.':'';
}

function confirmationMemo(confirmation:Omit<CashPlanPaymentConfirmation,'memo'>&{memo?:string},month:string):string{
 const memo=confirmation.memo??'';
 if(memo.includes(returnPrefix))throw Error('반환 입금의 내부 표식은 메모에 직접 입력하지 마세요.');
 const {returnedAmount,returnedDate}=confirmation;
 let stored=memo;
 if(returnedAmount!==0&&(returnedAmount!==undefined||returnedDate!==undefined)){
  if(!validReturn(returnedAmount,returnedDate,confirmation.amount,month))throw Error('돌려받은 금액은 출금액 이하로, 반환 입금일은 이 계획의 달 안에서 입력해 주세요.');
  stored=`[cash-plan-return:v1:${encodeURIComponent(JSON.stringify({amount:returnedAmount,date:returnedDate}))}]${memo?'\n'+memo:''}`;
 }
 if(stored.length>2000)throw Error('반환 입금 정보와 확인 메모는 합쳐서 2,000자 이내로 입력해 주세요.');
 return stored;
}

/** Bank actuals and cumulative gross confirmation still overlap. Only a valid,
 * explicitly decoded return reduces plan consumption; neither changes cash. */
export function cashPlanPaymentConfirmationNetAmount(bankRecordedAmount:number,confirmation:CashPlanPaymentConfirmation|null):number{
 const gross=Math.max(bankRecordedAmount,confirmation?.amount??0);
 const returned=confirmation&&validReturn(confirmation.returnedAmount,confirmation.returnedDate,confirmation.amount,confirmation.date.slice(0,7))?confirmation.returnedAmount:0;
 return Math.max(0,gross-returned);
}

/** Invalid or future evidence is ignored, even if an old client supplied it.
 * The explicit confirmation is cumulative for one plan/month. Never add it to
 * later matching bank actuals; both can describe the same payment. */
export function cashPlanPaymentConfirmation(edit:CashPlanEdit|undefined,asOf:string):CashPlanPaymentConfirmation|null{
 if(!edit||edit.payment_kind==='tax'||!Number.isSafeInteger(edit.confirmed_amount)||edit.confirmed_amount!<=0
  ||typeof edit.confirmed_date!=='string'||!parseFinanceDate(edit.confirmed_date)||!edit.confirmed_date.startsWith(`${edit.month}-`)
  ||edit.confirmed_date>asOf||typeof edit.confirmation_complete!=='boolean')return null;
 return {amount:edit.confirmed_amount!,date:edit.confirmed_date,complete:edit.confirmation_complete,...readConfirmationMemo(edit.confirmation_memo??'',edit.confirmed_amount!,edit.month,asOf)};
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
  confirmed_amount:confirmation?.amount??null,confirmed_date:confirmation?.date??null,confirmation_complete:confirmation?.complete??false,confirmation_memo:confirmation?confirmationMemo(confirmation,item.month):''};
}
