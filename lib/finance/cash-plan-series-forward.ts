import {z} from 'zod';
import {cashPlanChangeSchema,type CashPlanChange,type CashPlanEdit} from './cash-plan-edits';
import {readCashPlanSeries,buildCashPlanSeriesBreakdown,type CashPlanSeries} from './cash-plan-series';
import {readCashPlanSeriesRevisions,type CashPlanSeriesRevision} from './cash-plan-series-revision';
import {buildCashPlanFixedCostChange,buildCashPlanFixedCostAddChange,type CashPlanFixedCostChangeInput,type CashPlanFixedCostAddInput} from './cash-plan-series-edit';

type SaveChange=Extract<CashPlanChange,{action:'save'}>;
export type FixedCostForwardRequest={scope:'from-month';business_id:string;month:string;series_id:string;expected_series_version:number;day:number|null;change:SaveChange};
export type FixedCostSaveResult={edits:CashPlanEdit[];series:CashPlanSeries[];revisions:CashPlanSeriesRevision[]};
const month=/^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/;
export const fixedCostForwardRequestSchema=z.object({
 scope:z.literal('from-month'),business_id:z.string().uuid(),month:z.string().regex(month),series_id:z.string().uuid(),
 expected_series_version:z.number().int().min(0).max(2147483646),day:z.number().int().min(1).max(31).nullable(),change:cashPlanChangeSchema,
}).strict().superRefine((request,ctx)=>{
 const change=request.change;
 if(change.action!=='save'){ctx.addIssue({code:'custom',message:'반복 고정비의 저장 내용을 확인해주세요.',path:['change']});return;}
 if(change.business_id!==request.business_id||change.month!==request.month||change.source_type==='registered'||(change.source_type==='manual'&&change.source_key!==request.series_id)
  ||(change.payment_kind??'general')!=='general'||(change.payment_status??'pending')!=='pending')ctx.addIssue({code:'custom',message:'고정비 원본과 적용월을 확인해주세요.',path:['change']});
});

const editReadSchema=z.object({
 id:z.string().uuid(),business_id:z.string().uuid(),source_type:z.enum(['estimated','registered','manual']),source_key:z.string().min(1).max(1500),
 month:z.string().refine(value=>value==='*'||month.test(value)),title:z.string(),account_id:z.string().uuid().nullable(),plan_date:z.string().nullable(),
 amount:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),memo:z.string(),excluded:z.boolean(),version:z.number().int().min(1),updated_at:z.string(),
 payment_kind:z.enum(['general','tax']).optional(),payment_status:z.enum(['pending','paid']).optional(),confirmed_amount:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
 confirmed_date:z.string().nullable().optional(),confirmation_complete:z.boolean().optional(),confirmation_memo:z.string().optional(),
}).strict();

export function readFixedCostSaveResult(value:unknown):FixedCostSaveResult{
 const envelope=z.object({edits:z.array(editReadSchema),series:z.array(z.unknown()),revisions:z.array(z.unknown())}).strict().safeParse(value);
 if(!envelope.success)throw Error('반복 고정비 저장 응답을 확인하지 못했습니다. 최신 자료를 다시 불러와주세요.');
 const series=readCashPlanSeries(envelope.data.series),revisions=readCashPlanSeriesRevisions(envelope.data.revisions,{series});
 return {edits:envelope.data.edits,series,revisions};
}

function requestFor(change:CashPlanChange,seriesId:string,version:number,day:number|null):FixedCostForwardRequest{
 if(change.action!=='save')throw Error('반복 고정비 저장 형식을 확인해주세요.');
 const parsed=fixedCostForwardRequestSchema.safeParse({scope:'from-month',business_id:change.business_id,month:change.month,series_id:seriesId,expected_series_version:version,day,change});
 if(!parsed.success)throw Error(parsed.error.issues[0]?.message||'반복 고정비 저장 내용을 확인해주세요.');
 return {...parsed.data,change};
}

export function buildCashPlanFixedCostForwardChange(input:CashPlanFixedCostChangeInput&{expectedSeriesVersion:number}):FixedCostForwardRequest{
 const series=input.data.cash_plan_series?.find(item=>item.id===input.rowId&&item.business_id===input.businessId);
 const currentVersion=series?.version??0;
 if(currentVersion!==input.expectedSeriesVersion)throw Error('다른 관리자가 반복 고정비를 변경했습니다. 입력값은 유지하고 최신 계획을 다시 확인해주세요.');
 if(series&&(series.kind!=='operating'||input.month<series.start_month||(series.end_month&&input.month>series.end_month)))throw Error('반복 고정비의 적용 기간과 종류를 확인해주세요.');
 const change=buildCashPlanFixedCostChange(input);
 const row=buildCashPlanSeriesBreakdown(input.data,input.edits,input.businessId,input.month).includedRows.find(item=>item.id===input.rowId)!;
 if(!series&&row.sourceType==='estimated')throw Error('지출계획표에서 연결한 추정 항목은 이번 달만 적용해주세요.');
 const day=change.action==='save'&&change.plan_date===row.date?row.nominalDay:change.action==='save'&&change.plan_date?Number(change.plan_date.slice(-2)):null;
 return requestFor(change,series?.id??row.id,currentVersion,day);
}

export function buildCashPlanFixedCostForwardAddChange(input:CashPlanFixedCostAddInput):FixedCostForwardRequest{
 const change=buildCashPlanFixedCostAddChange(input);
 return requestFor(change,input.id,0,change.action==='save'&&change.plan_date?Number(change.plan_date.slice(-2)):null);
}
