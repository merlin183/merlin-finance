import {z} from 'zod';
import {buildEditableCashPlan,type CashPlanEditorItem} from './editable-cash-plan';
import {buildCashPlanWorksheetModel} from './cash-plan-worksheet-model';
import {buildCashPlanSeriesBreakdown} from './cash-plan-series';
import {cashPlanChangesSchema,type CashPlanChange,type CashPlanEdit} from './cash-plan-edits';
import {fixedCostMemo,readFixedCostMemo} from './cash-plan-series-memo';
import {cashPlanEstimateOptions} from './cash-plan-policy';
import {calendarMonthRange} from './transaction-calendar';
import type {Dataset} from './types';
import {cashEstimateSourceIdentity} from './cash-plan-category';

export type CashPlanFixedSyncInput={data:Dataset;edits:readonly CashPlanEdit[];month:string;asOf:string;businessId?:string;basis?:'estimated'|'registered';createId?:()=>string};
export type CashPlanFixedSyncResult={changes:CashPlanChange[];includedCount:number;skippedCount:number};
const identity=(value:{businessId:string;sourceType:string;sourceKey:string})=>JSON.stringify([value.businessId,value.sourceType,value.sourceKey]);
const providerBill=/^\[clobe-card-bill:[^\]\r\n]+\]$/m;
const uuid=(value:string)=>z.string().uuid().safeParse(value).success;

function assertSource(data:Dataset,item:CashPlanEditorItem){
 if(item.edit?.account_id&&!data.accounts.some(account=>account.id===item.edit!.account_id&&account.business_id===item.businessId))throw Error('저장된 지출계획의 사업자와 출금 계좌를 확인해주세요.');
 if(item.accountId&&!data.accounts.some(account=>account.id===item.accountId&&account.business_id===item.businessId))throw Error('지출계획의 사업자와 출금 계좌를 확인해주세요.');
 if(item.source_type==='manual'){
  if(!uuid(item.source_key))throw Error('직접 추가한 지출계획의 원본을 확인해주세요.');
  return;
 }
 const source=cashEstimateSourceIdentity(item.source_key,item.businessId);
 if(!source||!source.partyKey.trim()||!data.accounts.some(account=>account.id===source.accountId&&account.business_id===item.businessId))throw Error('반복 출금의 사업자와 원본 계좌를 확인해주세요.');
}

function sourceGroup(item:CashPlanEditorItem,categories:readonly string[]):string{
 const marked=readFixedCostMemo(item.memo);if(marked)return marked.groupLabel;
 const title=item.title.normalize('NFKC').replace(/\s+/g,'');
 if(!/리스/.test(title)&&(/카드(?:대금|결제|출금|청구)/.test(title)||/^(?:롯데|우리|신한|삼성|국민|현대|하나|비씨)카드$/.test(title)))return '카드대금';
 if(/대출(?:원리|원금|이자|상환)/.test(title))return '대출원리금';
 const explicit=[...new Set(categories.map(value=>value.trim()).filter(value=>value&&value!=='미분류'&&value!=='미매핑'))];
 return explicit.length===1?explicit[0]:'기타 계획';
}

/** Enrolls the exact existing worksheet identities for this one whole month.
 * The normal authenticated save preserves payment confirmations and CAS versions.
 * This never creates a recurrence or copies a forecast into a second manual row. */
export function buildCashPlanFixedSyncChanges({data,edits,month,asOf,businessId='all',basis='estimated',createId=()=>crypto.randomUUID()}:CashPlanFixedSyncInput):CashPlanFixedSyncResult{
 const range=calendarMonthRange(month);
 if(businessId!=='all'&&!data.businesses.some(business=>business.id===businessId))throw Error('반영할 사업자를 확인해주세요.');
 const options=cashPlanEstimateOptions(data),editable=buildEditableCashPlan(data,range,asOf,[...edits],options);
 const worksheet=buildCashPlanWorksheetModel({data,editable,basis,range,asOf,options});
 const changes:CashPlanChange[]=[];let skippedCount=0;
 for(const business of worksheet.businesses){
  if(businessId!=='all'&&business.businessId!==businessId)continue;
  const detail=buildCashPlanSeriesBreakdown(data,edits,business.businessId,month);
  const known=new Set([...detail.includedRows,...detail.excludedRows].map(row=>identity({businessId:business.businessId,sourceType:row.sourceType,sourceKey:row.sourceKey})));
  const groups=new Map(editable.estimates.businesses.find(value=>value.business.id===business.businessId)?.groups.map(group=>[group.key,group.categoryNames]));
  for(const row of business.rows){
   const item=row.editorItem;
   if(known.has(identity({businessId:item.businessId,sourceType:item.source_type,sourceKey:item.source_key}))||readFixedCostMemo(item.memo))continue;
   if(item.excluded||item.month!==month||item.source_type==='registered'||(item.paymentKind??'general')!=='general'||(item.paymentStatus??'pending')!=='pending'||providerBill.test(item.memo)){skippedCount++;continue;}
   assertSource(data,item);
   const memo=fixedCostMemo(sourceGroup(item,groups.get(item.source_key)??[]),item.memo);
   const edit=item.edit;
   changes.push({action:'save',id:edit?.id??createId(),business_id:item.businessId,source_type:item.source_type,source_key:item.source_key,month,
    title:item.title,account_id:item.accountId,plan_date:item.date,amount:item.amount,memo,excluded:false,payment_kind:'general',version:edit?.version??0});
  }
 }
 if(changes.length>100)throw Error('한 번에 반영할 항목이 100건을 넘습니다. 사업자를 선택해 나누어 반영해주세요.');
 if(changes.length){const parsed=cashPlanChangesSchema.safeParse({changes});if(!parsed.success)throw Error(parsed.error.issues[0]?.message||'지출계획 반영 내용을 확인해주세요.');}
 return {changes,includedCount:changes.length,skippedCount};
}
