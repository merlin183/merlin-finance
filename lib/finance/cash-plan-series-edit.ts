import {z} from 'zod';
import type {Dataset} from './types';
import {cashPlanChangeSchema,type CashPlanChange,type CashPlanEdit} from './cash-plan-edits';
import {buildCashPlanSeriesBreakdown,type CashPlanSeriesBreakdownRow} from './cash-plan-series';
import {fixedCostMemo,readFixedCostMemo} from './cash-plan-series-memo';
import {mergeCashPlanUserMemo} from './cash-plan-memo';
import {parseFinanceDate} from './date-range';

const draftSchema=z.object({
 title:z.string().trim().min(1,'항목명을 입력해주세요.').max(500,'항목명은 500자 이내로 입력해주세요.'),
 amount:z.number().int('금액은 원 단위 정수로 입력해주세요.').min(0,'금액은 0원 이상이어야 합니다.').max(Number.MAX_SAFE_INTEGER,'입력 가능한 금액을 초과했습니다.'),
 date:z.string().nullable(),accountId:z.string().uuid('출금 계좌를 확인해주세요.').nullable(),memo:z.string().max(2000,'메모는 2,000자 이내로 입력해주세요.'),
 groupLabel:z.string().trim().min(1,'고정비 분류를 선택해주세요.').max(100,'고정비 분류는 100자 이내로 입력해주세요.').optional(),
}).strict();
export type FixedCostDraft=z.infer<typeof draftSchema>;
type Scope={data:Dataset;edits:readonly CashPlanEdit[];businessId:string;month:string};
export type CashPlanFixedCostChangeInput=Scope&{rowId:string;expectedVersion:number;expectedEditId:string|null;action:'save'|'remove';draft?:FixedCostDraft;newEditId?:string};
export type CashPlanFixedCostAddInput=Scope&{id:string;draft:FixedCostDraft};

const uuid=(value:string)=>z.string().uuid().safeParse(value).success;
const normalizedTitle=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('ko-KR');
function assertScope({data,businessId,month}:Scope){
 if(!data.businesses.some(business=>business.id===businessId))throw Error('고정비를 수정할 사업자를 확인해주세요.');
 if(!/^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/.test(month))throw Error('고정비를 수정할 월을 확인해주세요.');
}
function readDraft(value:FixedCostDraft|undefined,{data,businessId,month}:Scope):FixedCostDraft{
 const parsed=draftSchema.safeParse(value);
 if(!parsed.success)throw Error(parsed.error.issues[0]?.message||'고정비 입력 내용을 확인해주세요.');
 const draft=parsed.data;
 if(draft.date&&(!parseFinanceDate(draft.date)||!draft.date.startsWith(`${month}-`)))throw Error('출금 예정일은 선택한 월 안에서 입력해주세요.');
 if(draft.accountId&&!data.accounts.some(account=>account.id===draft.accountId&&account.business_id===businessId))throw Error('선택한 사업자의 출금 계좌를 선택해주세요.');
 return draft;
}
function assertDistinctTitle(rows:readonly CashPlanSeriesBreakdownRow[],title:string,exceptId?:string){
 const normalized=normalizedTitle(title),duplicate=rows.find(row=>row.id!==exceptId&&(normalizedTitle(row.title)===normalized||normalizedTitle(row.originalTitle)===normalized));
 if(duplicate)throw Error(duplicate.included?'같은 이름의 고정비가 있습니다. 항목을 수정하거나 구분되는 이름을 입력해주세요.':'선택한 달에 제외한 항목과 같은 이름입니다. 기존 제외 상태는 자동 복원하지 않습니다.');
}
function validatedSave(value:unknown):CashPlanChange{
 const result=cashPlanChangeSchema.safeParse(value);
 if(!result.success)throw Error(result.error.issues[0]?.message||'고정비 저장 내용을 확인해주세요.');
 return result.data;
}

/** Creates only the selected month's ordinary save. The RPC retains existing
 * payment confirmations and enforces the supplied optimistic-lock version. */
export function buildCashPlanFixedCostChange(input:CashPlanFixedCostChangeInput):CashPlanChange{
 assertScope(input);
 const detail=buildCashPlanSeriesBreakdown(input.data,input.edits,input.businessId,input.month);
 const row=[...detail.includedRows,...detail.excludedRows].find(item=>item.id===input.rowId&&item.kind==='operating');
 if(!row)throw Error('수정할 고정비 항목을 다시 불러와주세요.');
 if(!row.included)throw Error('제외된 고정비는 여기서 수정하거나 자동 복원할 수 없습니다.');
 if(row.version!==input.expectedVersion||row.editId!==input.expectedEditId)throw Error('다른 관리자가 이 항목을 변경했습니다. 입력값은 유지하고 최신 계획을 다시 확인해주세요.');
 const stored=row.editId?input.edits.find(edit=>edit.id===row.editId&&edit.version===row.version):undefined;
 if((stored?.payment_kind??'general')!=='general'||(stored?.payment_status??'pending')!=='pending')throw Error('세금 납부 일정은 기존 납부 확인 기능에서 관리해주세요.');
 const id=row.editId??input.newEditId??crypto.randomUUID();
 if(!uuid(id)||(!row.editId&&input.edits.some(edit=>edit.id===id)))throw Error('고정비 수정 식별자를 다시 생성해주세요.');
 let title=row.title,amount=row.currentAmount,accountId=row.accountId,date=row.date,memo=row.effectiveMemo;
 if(input.action==='save'){
  const draft=readDraft(input.draft,input);
  if(normalizedTitle(draft.title)!==normalizedTitle(row.title))assertDistinctTitle([...detail.includedRows,...detail.excludedRows],draft.title,row.id);
  const marker=readFixedCostMemo(row.effectiveMemo),series=input.data.cash_plan_series?.find(item=>item.id===row.id&&item.business_id===input.businessId);
  if(series&&draft.groupLabel!==undefined&&draft.groupLabel!==row.groupLabel)throw Error('기존 반복 고정비의 원본 분류는 이 달의 수정에서 변경할 수 없습니다.');
  memo=marker&&!series?fixedCostMemo(draft.groupLabel??marker.groupLabel,draft.memo):mergeCashPlanUserMemo(row.effectiveMemo,draft.memo);
  ({title,amount,accountId,date}=draft);
 }
 if(memo.length>2000)throw Error('고정비 분류를 포함한 메모가 너무 깁니다. 내용을 조금 줄여주세요.');
 return validatedSave({action:'save',id,business_id:input.businessId,source_type:row.sourceType,source_key:row.sourceKey,month:input.month,
  title,account_id:accountId,plan_date:date,amount,memo,excluded:input.action==='remove',payment_kind:'general',version:row.version});
}

/** The caller creates this UUID once when opening the add form and keeps it on
 * failed/ambiguous responses. A retry therefore cannot create another expense. */
export function buildCashPlanFixedCostAddChange(input:CashPlanFixedCostAddInput):CashPlanChange{
 assertScope(input);
 if(!uuid(input.id)||input.edits.some(edit=>edit.id===input.id||edit.source_key===input.id)||input.data.cash_plan_series?.some(series=>series.id===input.id||series.source_key===input.id))throw Error('이미 등록된 항목입니다. 최신 고정비 목록을 확인해주세요.');
 const draft=readDraft(input.draft,input),detail=buildCashPlanSeriesBreakdown(input.data,input.edits,input.businessId,input.month);
 assertDistinctTitle([...detail.includedRows,...detail.excludedRows],draft.title);
 const memo=fixedCostMemo(draft.groupLabel??'기타 고정비',draft.memo);
 if(memo.length>2000)throw Error('고정비 분류를 포함한 메모가 너무 깁니다. 내용을 조금 줄여주세요.');
 return validatedSave({action:'save',id:input.id,business_id:input.businessId,source_type:'manual',source_key:input.id,month:input.month,
  title:draft.title,account_id:draft.accountId,plan_date:draft.date,amount:draft.amount,memo,excluded:false,payment_kind:'general',version:0});
}
