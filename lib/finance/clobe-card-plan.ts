import {z} from 'zod';
import type {ClobeCardBill} from '../clobe/card-billing-types';
import {cashPlanChangesSchema,type CashPlanChange,type CashPlanEdit} from './cash-plan-edits';
import {buildEditableCashPlan,type CashPlanEditorItem} from './editable-cash-plan';
import {parseFinanceDate} from './date-range';
import {calendarMonthRange} from './transaction-calendar';
import type {Dataset} from './types';

export type ClobeCardPlanSelection={companyId:string;businessId:string;accountId:string;bill:ClobeCardBill;replacementKeys:readonly string[]};
export type ClobeCardPlanInput={data:Dataset;edits:readonly CashPlanEdit[];asOf:string;selections:readonly ClobeCardPlanSelection[];newEditIds?:Readonly<Record<string,string>>};
type Save=Extract<CashPlanChange,{action:'save'}>;
const uuid=(value:string)=>z.string().uuid().safeParse(value).success;
const providerTitle='클로브 카드대금 · ';
const providerMemo=(companyId:string,billKey:string)=>`[clobe-card-bill:${companyId}:${billKey}]`;
const replacementMemo='\n대체 계획 키: ';
function linkedKeys(memo:string):Set<string>{
 const start=memo.indexOf(replacementMemo);
 if(start<0)return new Set();
 try{
  const value:unknown=JSON.parse(memo.slice(start+replacementMemo.length).split('\n')[0]);
  return new Set(Array.isArray(value)?value.filter((key):key is string=>typeof key==='string'):[]);
 }catch{return new Set();}
}
function noteWithKeys(memo:string,previous:Set<string>,keys:readonly string[]):string{
 const combined=[...new Set([...previous,...keys])];
 if(combined.length===previous.size)return memo;
 const start=memo.indexOf(replacementMemo),line=`${replacementMemo}${JSON.stringify(combined)}`;
 if(start<0)return `${memo}${line}`;
 const end=memo.indexOf('\n',start+replacementMemo.length);
 return `${memo.slice(0,start)}${line}${end<0?'':memo.slice(end)}`;
}
const omittedCardExpenses=/(?:문자|sms|수수료|연회비|카드론|현금서비스|단기카드|장기카드|카드발급|카드등록|취소|환불|충전|캐시백|이자)/i;
const target=(item:CashPlanEditorItem,businessId:string,month:string)=>item.businessId===businessId&&item.month===month&&!item.excluded&&item.inRange&&item.remainingAmount>0
 &&item.paymentKind!=='tax'&&item.edit?.payment_kind!=='tax'
 &&!item.title.startsWith(providerTitle)&&!item.memo.includes('[clobe-card-bill:')
 &&/(?:카드|card)/i.test(item.title)&&!omittedCardExpenses.test(item.title);

/** Candidates are a review list, never an instruction to disable guessed names. */
export function getClobeCardPlanCandidates(data:Dataset,edits:readonly CashPlanEdit[],businessId:string,month:string,asOf:string):CashPlanEditorItem[]{
 if(!parseFinanceDate(asOf)||!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)||!parseFinanceDate(`${month}-01`))return [];
 if(!data.businesses.some(business=>business.id===businessId))return [];
 return buildEditableCashPlan(data,calendarMonthRange(month),asOf,edits).items.filter(item=>target(item,businessId,month));
}

function usable(bill:ClobeCardBill,asOf:string):boolean {
 return bill.replaceable===true&&bill.kind==='REGULAR'&&uuid(bill.key)
  &&!!parseFinanceDate(bill.date)&&bill.date>=asOf&&Number.isSafeInteger(bill.amount)&&bill.amount!>0&&bill.amount!<=Number.MAX_SAFE_INTEGER
  &&Number.isSafeInteger(bill.itemCount)&&bill.itemCount>0
  &&typeof bill.maskedCard==='string'&&bill.maskedCard.trim().length>0&&bill.maskedCard.length<=100&&/[*●•xX]/.test(bill.maskedCard);
}

function exclude(item:CashPlanEditorItem,newId:string|undefined):Save {
 const id=item.edit?.id??newId;
 if(!id||!uuid(id))throw Error('기존 카드 계획의 수정 식별자를 확인해주세요.');
 return {action:'save',id,business_id:item.businessId,source_type:item.source_type,source_key:item.source_key,month:item.month,
  title:item.title,account_id:item.accountId,plan_date:item.date,amount:item.amount,memo:item.memo,excluded:true,version:item.edit?.version??0,
  ...(item.edit?.payment_kind!==undefined?{payment_kind:item.edit.payment_kind}:{}),
  ...(item.edit?.payment_status!==undefined?{payment_status:item.edit.payment_status}:{}),
 };
}

const unchanged=(existing:CashPlanEdit,next:Save)=>existing.title===next.title&&existing.account_id===next.account_id&&existing.plan_date===next.plan_date
 &&existing.amount===next.amount&&existing.memo===next.memo&&!existing.excluded;

/** Build one atomic replacement batch. It changes saved plans only, never bank
 * transactions, account balances, categories, source rules or registered rows.
 * Original plan identifiers are supplied explicitly by the reviewer; recurring
 * sources are excluded for this month rather than deleted or globally disabled.
 * The caller supplies new IDs for unedited old plans to keep this model pure. */
export function buildClobeCardPlanChanges({data,edits,asOf,selections,newEditIds={}}:ClobeCardPlanInput):CashPlanChange[]{
 if(!parseFinanceDate(asOf))throw Error('카드 계획의 기준 날짜를 확인해주세요.');
 const changes:Save[]=[],excluded=new Map<string,Save>(),selectedBills=new Set<string>(),companyBusinesses=new Map<string,string>();
 const monthItems=new Map<string,Map<string,CashPlanEditorItem>>();
 for(const selection of selections){
  const {companyId,businessId,accountId,bill,replacementKeys}=selection;
  // Empty/partial/PRE_PAYMENT data never replaces an estimate with a fake zero.
  if(!usable(bill,asOf))continue;
  if(!companyId.trim()||companyId.length>200||!data.businesses.some(business=>business.id===businessId))throw Error('클로브 회사와 사업자 연결을 확인해주세요.');
  if(!uuid(accountId)||!data.accounts.some(account=>account.id===accountId&&account.business_id===businessId))throw Error('해당 사업자의 출금 계좌를 선택해주세요.');
  const mapped=companyBusinesses.get(companyId);
  if(mapped&&mapped!==businessId)throw Error('같은 클로브 회사의 청구서는 같은 사업자로 연결해주세요.');
  companyBusinesses.set(companyId,businessId);
  if(selectedBills.has(bill.key))throw Error('같은 카드 청구서를 한 번만 선택해주세요.');
  selectedBills.add(bill.key);
  const month=bill.date.slice(0,7),marker=providerMemo(companyId,bill.key);
  const matching=edits.filter(edit=>edit.id===bill.key||edit.source_key===bill.key);
  const existing=matching.find(edit=>edit.id===bill.key&&edit.source_type==='manual'&&edit.source_key===bill.key&&edit.month===month&&edit.business_id===businessId);
  if(matching.length>1||(matching.length===1&&!existing))throw Error('기존 카드 청구 계획의 사업자와 월이 일치하지 않습니다.');
  if(existing&&(existing.payment_kind==='tax'||!existing.memo.includes(marker)))throw Error('다른 지출 계획을 카드 청구서로 덮어쓸 수 없습니다.');
  if(existing?.excluded)throw Error('직접 제외한 카드 청구서는 자동 복원하지 않습니다. 계획 편집에서 먼저 확인해주세요.');
  if(!existing&&replacementKeys.length===0)throw Error('대체할 기존 카드 계획을 선택해주세요.');
  let allItems=monthItems.get(month);
  if(!allItems){allItems=new Map(buildEditableCashPlan(data,calendarMonthRange(month),asOf,edits).items.map(item=>[item.key,item]));monthItems.set(month,allItems);}
  const candidates=new Map([...allItems].filter(([,item])=>target(item,businessId,month)));
  const previouslyReplaced=existing?linkedKeys(existing.memo):new Set<string>();
  for(const key of new Set(replacementKeys)){
   const item=candidates.get(key);
   if(!item){
    const prior=allItems.get(key);
    if(existing&&previouslyReplaced.has(key)&&prior?.edit?.excluded&&!prior.globalEdit?.excluded
     &&prior.businessId===businessId&&prior.month===month&&prior.paymentKind!=='tax')continue;
    throw Error('선택한 카드 계획이 변경되었거나 해당 사업자·월의 대체 대상이 아닙니다.');
   }
   if(item.source_key===bill.key||item.edit?.id===bill.key)throw Error('새 카드 청구서 자체는 기존 대체 대상으로 선택할 수 없습니다.');
   if(!excluded.has(key))excluded.set(key,exclude(item,newEditIds[key]));
  }
  // Preserve user notes after the provenance marker. A refresh updates only the
  // explicit bill amount/date/bank; exclusion is never automatically reversed.
  const next:Save={action:'save',id:bill.key,business_id:businessId,source_type:'manual',source_key:bill.key,month,
   title:`${providerTitle}${bill.maskedCard.trim()}`,account_id:accountId,plan_date:bill.date,amount:bill.amount!,memo:existing?noteWithKeys(existing.memo,previouslyReplaced,replacementKeys):`${marker}${replacementMemo}${JSON.stringify([...new Set(replacementKeys)])}`,
   excluded:false,version:existing?.version??0,payment_kind:existing?.payment_kind??'general',payment_status:existing?.payment_status??'pending'};
  if(!existing||!unchanged(existing,next))changes.push(next);
 }
 const result=[...excluded.values(),...changes];
 if(!result.length)return [];
 if(result.length>100)throw Error('한 번에 변경할 카드 계획은 100건 이내로 선택해주세요.');
 const checked=cashPlanChangesSchema.safeParse({changes:result});
 if(!checked.success)throw Error(checked.error.issues[0]?.message??'카드 계획 변경 내용을 확인해주세요.');
 return checked.data.changes;
}
