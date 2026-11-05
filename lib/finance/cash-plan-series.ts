import {z} from 'zod';
import type {Dataset} from './types';
import type {CashPlanEdit} from './cash-plan-edits';
import {calendarMonthRange} from './transaction-calendar';
import {readFixedCostMemo} from './cash-plan-series-memo';
import {resolveCashPlanSeriesForMonth} from './cash-plan-series-revision';
import {parseFinanceDate} from './date-range';

const monthPattern=/^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/;
const money=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const cashPlanSeriesSchema=z.object({
 id:z.string().uuid(),business_id:z.string().uuid(),source_type:z.enum(['estimated','manual']),source_key:z.string().min(1).max(1500),
 title:z.string().trim().min(1).max(500),account_id:z.string().uuid().nullable(),monthly_amount:money,
 start_month:z.string().regex(monthPattern),end_month:z.string().regex(monthPattern).nullable(),day:z.number().int().min(1).max(31).nullable(),
 kind:z.enum(['operating','installment']),memo:z.string().max(2000),amount_overrides:z.record(z.string().regex(monthPattern),money),
 version:z.number().int().min(1).optional(),updated_at:z.string().optional(),
}).strict().superRefine((series,ctx)=>{
 if(series.end_month&&series.end_month<series.start_month)ctx.addIssue({code:'custom',message:'종료월은 시작월 이후로 설정해주세요.',path:['end_month']});
 if(series.source_type==='manual'&&series.source_key!==series.id)ctx.addIssue({code:'custom',message:'직접 추가 일정의 원본 식별자를 확인해주세요.',path:['source_key']});
 for(const month of Object.keys(series.amount_overrides))if(month<series.start_month||(series.end_month&&month>series.end_month))ctx.addIssue({code:'custom',message:'금액 수정월은 일정 기간 안에 있어야 합니다.',path:['amount_overrides',month]});
});
export type CashPlanSeries=z.infer<typeof cashPlanSeriesSchema>;
export type CashPlanSeriesMonthly={businessId:string;businessName:string;month:string;registered:boolean;operatingAmount:number;installmentAmount:number;total:number;notes:string[]};
export type CashPlanSeriesBreakdownRow={
 id:string;key:string;kind:CashPlanSeries['kind'];groupLabel:string;title:string;originalTitle:string;
 sourceType:CashPlanSeries['source_type'];sourceKey:string;month:string;editId:string|null;version:number;
 seriesVersion:number;revisionEffectiveMonth:string|null;revisionExcludedFrom:string|null;
 nominalDay:number|null;
 baseAmount:number;currentAmount:number;included:boolean;exclusionReason:'이번 달 제외'|'전체 기간 제외'|'이 달부터 계속 제외'|null;
 date:string|null;accountId:string|null;accountName:string;memo:string;editMemo:string|null;effectiveMemo:string;globalMemo:string|null;
};
export type CashPlanSeriesBreakdownGroup={key:string;label:string;amount:number;count:number};
export type CashPlanSeriesBreakdown={
 businessId:string;businessName:string;month:string;registered:boolean;
 status:'unknown-business'|'unregistered'|'before-start'|'active'|'ended'|'between-periods';
 operatingAmount:number;installmentAmount:number;total:number;includedCount:number;excludedCount:number;
 includedRows:CashPlanSeriesBreakdownRow[];excludedRows:CashPlanSeriesBreakdownRow[];groups:CashPlanSeriesBreakdownGroup[];notes:string[];
};

export const cashPlanSeriesKey=(series:{business_id:string;source_type:string;source_key:string})=>JSON.stringify([series.business_id,series.source_type,series.source_key]);
export const cashPlanSeriesActive=(series:CashPlanSeries,month:string)=>month>=series.start_month&&(!series.end_month||month<=series.end_month);
export const cashPlanSeriesAmount=(series:CashPlanSeries,month:string)=>series.amount_overrides[month]??series.monthly_amount;
export function cashPlanSeriesDate(series:CashPlanSeries,month:string):string|null{
 return series.day===null?null:`${month}-${String(Math.min(series.day,Number(calendarMonthRange(month).to.slice(-2)))).padStart(2,'0')}`;
}

/** Required at the transport boundary. Invalid schedules must not look like a zero budget. */
export function readCashPlanSeries(value:unknown,scope?:Pick<Dataset,'businesses'|'accounts'>):CashPlanSeries[]{
 const parsed=z.array(cashPlanSeriesSchema).safeParse(value);
 if(!parsed.success)throw Error('월 고정비·할부 계획을 확인하지 못했습니다. 자료를 새로고침하거나 초기 설정을 확인해주세요.');
 const ids=new Set<string>(),keys=new Set<string>();
 for(const item of parsed.data){
  const key=cashPlanSeriesKey(item);
  if(ids.has(item.id)||keys.has(key))throw Error('월 고정비·할부 계획의 원본이 중복되어 있습니다. 관리자에게 확인해주세요.');
  if(scope&&(!scope.businesses.some(business=>business.id===item.business_id)||(item.account_id&&!scope.accounts.some(account=>account.id===item.account_id&&account.business_id===item.business_id))))throw Error('월 고정비·할부 계획의 사업자와 출금 계좌를 확인해주세요.');
  ids.add(item.id);keys.add(key);
 }
 return parsed.data;
}

const latestEdits=(edits:readonly CashPlanEdit[])=>{
 const result=new Map<string,CashPlanEdit>();
 for(const edit of edits){
  const key=JSON.stringify([edit.business_id,edit.source_type,edit.source_key,edit.month]),previous=result.get(key);
  if(!previous||previous.version<edit.version)result.set(key,edit);
 }
 return result;
};

/** Only explicitly marked ordinary manual plans enter the fixed-cost summary.
 * Tax-payment and provider-card records keep their existing independent role. */
export function isMonthlyFixedCostEdit(edit:CashPlanEdit):boolean{
 return edit.source_type==='manual'&&monthPattern.test(edit.month)&&(edit.payment_kind??'general')==='general'
  &&(edit.payment_status??'pending')==='pending'&&z.string().uuid().safeParse(edit.source_key).success
  &&!!readFixedCostMemo(edit.memo)&&!/^\[clobe-card-bill:[^\]\r\n]+\]$/m.test(edit.memo);
}

/** Summary membership does not change how the original forecast reconciles
 * bank spending. A marked estimated month keeps its original source identity. */
function isStandaloneFixedCostEdit(edit:CashPlanEdit,data:Dataset):boolean{
 if(isMonthlyFixedCostEdit(edit))return true;
 if(edit.source_type!=='estimated'||!monthPattern.test(edit.month)||(edit.payment_kind??'general')!=='general'
  ||(edit.payment_status??'pending')!=='pending'||!readFixedCostMemo(edit.memo)||/^\[clobe-card-bill:[^\]\r\n]+\]$/m.test(edit.memo)
  ||!z.string().uuid().safeParse(edit.id).success||!Number.isSafeInteger(edit.amount)||edit.amount<0
  ||(edit.plan_date!==null&&(!parseFinanceDate(edit.plan_date)||!edit.plan_date.startsWith(`${edit.month}-`))))return false;
 if(edit.account_id&&!data.accounts.some(account=>account.id===edit.account_id&&account.business_id===edit.business_id))return false;
 try{
  const source:unknown=JSON.parse(edit.source_key);
  return Array.isArray(source)&&source.length===3&&source[0]===edit.business_id&&typeof source[1]==='string'
   &&z.string().uuid().safeParse(source[1]).success&&data.accounts.some(account=>account.id===source[1]&&account.business_id===edit.business_id)
   &&typeof source[2]==='string'&&source[2].trim().length>0;
 }catch{return false;}
}

function standaloneFixedCosts(data:Dataset,overrides:ReturnType<typeof latestEdits>):CashPlanEdit[]{
 const seriesByKey=new Map((data.cash_plan_series??[]).map(series=>[cashPlanSeriesKey(series),series]));
 return [...overrides.values()].filter(edit=>{
  if(!isStandaloneFixedCostEdit(edit,data))return false;
  const series=seriesByKey.get(cashPlanSeriesKey(edit));
  return !series||edit.month<series.start_month;
 });
}

/** Use only an explicit source label. Neither a person's nor a vendor's name
 * establishes what the payment is for. Monthly notes cannot rewrite provenance. */
function groupLabel(series:CashPlanSeries):string{
 if(series.kind==='installment')return '한시적 할부';
 const marked=readFixedCostMemo(series.memo);
 if(marked)return marked.groupLabel;
 const title=series.title.normalize('NFKC').replace(/\s+/g,'');
 if(/^사회보험(?:월예산|월기준)?$/.test(title))return '사회보험';
 if(/^(?:세금[·ㆍ]?원천세|원천세)(?:월예산|월기준)?$/.test(title))return '세금·원천세';
 const explicit=/월\s*고정비\s*계획\s*·\s*(.+?)(?:\s+·\s+|$)/m.exec(series.memo)?.[1].trim();
 if(explicit)return explicit;
 return '기타 고정비';
}

function resolveMonthRows(data:Dataset,series:readonly CashPlanSeries[],overrides:ReturnType<typeof latestEdits>,businessId:string,month:string):CashPlanSeriesBreakdownRow[]{
 const accounts=new Map(data.accounts.filter(account=>account.business_id===businessId).map(account=>[account.id,account]));
 const rows:CashPlanSeriesBreakdownRow[]=series.filter(item=>item.business_id===businessId&&cashPlanSeriesActive(item,month)).map(item=>{
  const profile=resolveCashPlanSeriesForMonth(item,month,data.cash_plan_series_revisions)!;
  const identity=[item.business_id,item.source_type,item.source_key],edit=overrides.get(JSON.stringify([...identity,month]));
  const global=overrides.get(JSON.stringify([...identity,'*']));
  const account=accounts.get((edit?edit.account_id:profile.accountId)??'');
  const exclusionReason=global?.excluded?'전체 기간 제외':profile.revisionExcludedFrom?'이 달부터 계속 제외':edit?.excluded?'이번 달 제외':null;
  return {id:item.id,key:JSON.stringify([item.id,month]),kind:item.kind,groupLabel:groupLabel(item),
   sourceType:item.source_type,sourceKey:item.source_key,month,editId:edit?.id??null,version:edit?.version??0,
   seriesVersion:item.version??0,revisionEffectiveMonth:profile.revisionEffectiveMonth,revisionExcludedFrom:profile.revisionExcludedFrom,
   nominalDay:edit?(edit.plan_date===profile.date?profile.day:edit.plan_date?Number(edit.plan_date.slice(-2)):null):profile.day,
   title:edit?.title??profile.title,originalTitle:item.title,baseAmount:profile.amount,
   currentAmount:edit?.amount??profile.amount,included:exclusionReason===null,exclusionReason,
   date:edit?edit.plan_date:profile.date,accountId:account?.id??null,
   accountName:account?[...new Set([account.bank,account.name,account.masked_number].filter(Boolean))].join(' · '):'미지정',
   memo:item.memo,editMemo:edit?.memo??null,effectiveMemo:edit?edit.memo:profile.memo,globalMemo:global?.memo??null,
  };
 });
 for(const edit of standaloneFixedCosts(data,overrides)){
  if(edit.business_id!==businessId||edit.month!==month)continue;
  const account=accounts.get(edit.account_id??''),group=readFixedCostMemo(edit.memo)!;
  const global=overrides.get(JSON.stringify([edit.business_id,edit.source_type,edit.source_key,'*']));
  const exclusionReason=global?.excluded?'전체 기간 제외':edit.excluded?'이번 달 제외':null;
  const id=edit.source_type==='estimated'?edit.id:edit.source_key;
  rows.push({id,key:JSON.stringify([id,month]),kind:'operating',groupLabel:group.groupLabel,
   sourceType:edit.source_type==='estimated'?'estimated':'manual',sourceKey:edit.source_key,month,editId:edit.id,version:edit.version,
   seriesVersion:0,revisionEffectiveMonth:null,revisionExcludedFrom:null,
   nominalDay:edit.plan_date?Number(edit.plan_date.slice(-2)):null,
   title:edit.title,originalTitle:edit.title,baseAmount:edit.amount,currentAmount:edit.amount,included:exclusionReason===null,
   exclusionReason,date:edit.plan_date,accountId:account?.id??null,
   accountName:account?[...new Set([account.bank,account.name,account.masked_number].filter(Boolean))].join(' · '):'미지정',
   memo:edit.memo,editMemo:edit.memo,effectiveMemo:edit.memo,globalMemo:global?.memo??null});
 }
 return rows;
}

function monthAmounts(rows:readonly CashPlanSeriesBreakdownRow[]):Pick<CashPlanSeriesMonthly,'operatingAmount'|'installmentAmount'|'total'|'notes'>{
 let operatingAmount=0,installmentAmount=0;
 const notes=new Set<string>();
 for(const row of rows){
  if(!row.included)continue;
  if(row.kind==='operating')operatingAmount+=row.currentAmount;else installmentAmount+=row.currentAmount;
  if(row.kind==='installment'&&row.memo)notes.add(row.memo);
 }
 return {operatingAmount,installmentAmount,total:operatingAmount+installmentAmount,notes:[...notes]};
}

/** Read-only explanation of the same whole-month budget shown in the summary.
 * Excluded items retain their amounts and reasons but never enter subtotals. */
export function buildCashPlanSeriesBreakdown(data:Dataset,edits:readonly CashPlanEdit[],businessId:string,month:string):CashPlanSeriesBreakdown{
 if(!monthPattern.test(month))throw new RangeError('월별 계획 조회기간을 확인해주세요.');
 const business=data.businesses.find(item=>item.id===businessId);
 const series=business?(data.cash_plan_series??[]).filter(item=>item.business_id===businessId):[];
 const overrides=latestEdits(edits),manual=business?standaloneFixedCosts(data,overrides).filter(edit=>edit.business_id===businessId):[];
 const rows=business?resolveMonthRows(data,series,overrides,businessId,month):[];
 const includedRows=rows.filter(row=>row.included),excludedRows=rows.filter(row=>!row.included);
 const groups=new Map<string,CashPlanSeriesBreakdownGroup>();
 for(const row of includedRows){
  if(row.kind!=='operating')continue;
  const group=groups.get(row.groupLabel)??{key:row.groupLabel,label:row.groupLabel,amount:0,count:0};
  group.amount+=row.currentAmount;group.count++;groups.set(row.groupLabel,group);
 }
 const registered=series.some(item=>month>=item.start_month)||manual.some(edit=>month>=edit.month);
 const status:CashPlanSeriesBreakdown['status']=!business?'unknown-business':series.length===0&&manual.length===0?'unregistered':!registered?'before-start':rows.length>0?'active':series.every(item=>item.end_month!==null&&month>item.end_month)&&manual.every(edit=>month>edit.month)?'ended':'between-periods';
 const groupOrder=['급여','사회보험','세금·원천세','임차료','세무기장','통신','은행 정기수수료','정기 서비스·구독','카드대금'];
 const groupRank=(label:string)=>{const index=groupOrder.indexOf(label);return index>=0?index:label==='기타 고정비'?groupOrder.length+1:groupOrder.length;};
 return {businessId,businessName:business?.name??'',month,registered,status,...monthAmounts(rows),
  includedCount:includedRows.length,excludedCount:excludedRows.length,includedRows,excludedRows,groups:[...groups.values()].sort((left,right)=>groupRank(left.label)-groupRank(right.label))};
}

/** Whole-month budgets for every workspace business, including unregistered ones.
 * The registration flag distinguishes missing plans from an explicit zero budget.
 * These totals are never added again to balance deductions. */
export function buildCashPlanSeriesMonthly(data:Dataset,edits:readonly CashPlanEdit[],fromMonth:string,count=6):CashPlanSeriesMonthly[]{
 if(!monthPattern.test(fromMonth)||!Number.isInteger(count)||count<1||count>60)throw new RangeError('월별 계획 조회기간을 확인해주세요.');
 const series=data.cash_plan_series??[];
 const overrides=latestEdits(edits),manual=standaloneFixedCosts(data,overrides);
 const start=Number(fromMonth.slice(0,4))*12+Number(fromMonth.slice(5,7))-1;
 const months=Array.from({length:count},(_,index)=>`${String(Math.floor((start+index)/12)).padStart(4,'0')}-${String((start+index)%12+1).padStart(2,'0')}`);
 return data.businesses.flatMap(business=>months.map(month=>{
  const registered=series.some(item=>item.business_id===business.id&&month>=item.start_month)||manual.some(edit=>edit.business_id===business.id&&month>=edit.month);
  return {businessId:business.id,businessName:business.name,month,registered,...monthAmounts(resolveMonthRows(data,series,overrides,business.id,month))};
 }));
}
