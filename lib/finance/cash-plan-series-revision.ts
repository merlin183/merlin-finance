import {z} from 'zod';
import type {CashPlanSeries} from './cash-plan-series';
import type {Account} from './types';
import {calendarMonthRange} from './transaction-calendar';

const month=/^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/;
export const cashPlanSeriesRevisionSchema=z.object({
 id:z.string().uuid(),business_id:z.string().uuid(),series_id:z.string().uuid(),effective_month:z.string().regex(month),
 title:z.string().trim().min(1).max(500),monthly_amount:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
 day:z.number().int().min(1).max(31).nullable(),account_id:z.string().uuid().nullable(),memo:z.string().max(2000),
 excluded:z.boolean(),cancelled:z.boolean(),version:z.number().int().min(1),updated_at:z.string(),
}).strict().refine(value=>!(value.excluded&&value.cancelled),'계속 제외한 고정비는 자동 복원할 수 없습니다.');
export type CashPlanSeriesRevision=z.infer<typeof cashPlanSeriesRevisionSchema>;
export type CashPlanSeriesProfile={title:string;amount:number;day:number|null;accountId:string|null;date:string|null;memo:string;revisionEffectiveMonth:string|null;revisionExcludedFrom:string|null};

export function readCashPlanSeriesRevisions(value:unknown,scope?:{series?:readonly CashPlanSeries[];accounts?:readonly Account[]}):CashPlanSeriesRevision[]{
 const parsed=z.array(cashPlanSeriesRevisionSchema).safeParse(value);
 if(!parsed.success)throw Error('고정비의 반복 변경 이력을 확인하지 못했습니다. 자료를 다시 불러와주세요.');
 const ids=new Set<string>(),keys=new Set<string>();
 for(const revision of parsed.data){
  const key=JSON.stringify([revision.series_id,revision.effective_month]);
  if(ids.has(revision.id)||keys.has(key))throw Error('고정비의 반복 변경 이력이 중복되었습니다.');
  ids.add(revision.id);keys.add(key);
  if(scope?.series){
   const series=scope.series.find(item=>item.id===revision.series_id&&item.business_id===revision.business_id);
   if(!series||series.kind!=='operating'||revision.effective_month<series.start_month||(series.end_month&&revision.effective_month>series.end_month))throw Error('고정비 변경 이력의 원본과 적용월을 확인해주세요.');
  }
  if(scope?.accounts&&revision.account_id&&!scope.accounts.some(account=>account.id===revision.account_id&&account.business_id===revision.business_id))throw Error('고정비 변경 이력의 출금 계좌를 확인해주세요.');
 }
 return parsed.data;
}

/** One profile resolver shared by the monthly summary and cash-plan worksheet.
 * An onward exclusion is a tombstone: later monthly overrides cannot restore it. */
export function resolveCashPlanSeriesForMonth(series:CashPlanSeries,month:string,revisions:readonly CashPlanSeriesRevision[]=[]):CashPlanSeriesProfile|null{
 if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)||month<series.start_month||(series.end_month&&month>series.end_month))return null;
 const eligible=series.kind==='operating'?revisions.filter(item=>item.series_id===series.id&&item.business_id===series.business_id&&!item.cancelled&&item.effective_month<=month):[];
 const current=eligible.reduce<CashPlanSeriesRevision|null>((latest,item)=>!latest||item.effective_month>latest.effective_month||(item.effective_month===latest.effective_month&&item.version>latest.version)?item:latest,null);
 const revisionExcludedFrom=eligible.filter(item=>item.excluded).reduce<string|null>((first,item)=>first===null||item.effective_month<first?item.effective_month:first,null);
 const day=current?current.day:series.day;
 return {title:current?.title??series.title,amount:current?current.monthly_amount:series.amount_overrides[month]??series.monthly_amount,
  day,accountId:current?current.account_id:series.account_id,memo:current?current.memo:series.memo,
  date:day===null?null:`${month}-${String(Math.min(day,Number(calendarMonthRange(month).to.slice(-2)))).padStart(2,'0')}`,
  revisionEffectiveMonth:current?.effective_month??null,revisionExcludedFrom};
}
