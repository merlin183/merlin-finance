import {isValidDateRange,parseFinanceDate,type DateRange} from './date-range';
import {addDays} from './format';

/** This initial plan is deliberate, never derived from the day the page opens. */
export const DEFAULT_CASH_PLAN_PERIOD:Readonly<DateRange>={from:'2026-10-01',to:'2026-10-31'};
export const CASH_PLAN_PERIOD_STORAGE_KEY='finance-cash-plan-period-v1';
const DAY_MS=86_400_000;

export function cashPlanPeriodError(range:DateRange):string {
 if(!isValidDateRange(range))return '유효한 시작일과 종료일을 선택해주세요. 종료일은 시작일과 같거나 이후여야 합니다.';
 if(range.from<'1900-04-01')return '직전 3개월 근거를 계산할 수 있도록 1900년 4월 이후를 선택해주세요.';
 if(!parseFinanceDate(addDays(range.from,-1)))return '계획 시작 전 잔액을 계산할 수 있는 시작일을 선택해주세요.';
 if(cashPlanPeriodDays(range)>366)return '계획 기간은 한 번에 366일 이내로 선택해주세요.';
 return '';
}

export function cashPlanPeriodDays(range:DateRange):number {
 return Math.round((Date.parse(`${range.to}T00:00:00Z`)-Date.parse(`${range.from}T00:00:00Z`))/DAY_MS)+1;
}

export function resolveCashPlanPeriod(range:DateRange):{range:DateRange;asOf:string;horizon:number} {
 const error=cashPlanPeriodError(range);
 if(error)throw new RangeError(error);
 return {range:{...range},asOf:addDays(range.from,-1),horizon:cashPlanPeriodDays(range)};
}

export function restoreCashPlanPeriod(serialized:string|null):DateRange {
 try{
  const stored:unknown=serialized?JSON.parse(serialized):null;
  if(stored&&typeof stored==='object'&&'version' in stored&&stored.version===1&&'from' in stored&&typeof stored.from==='string'&&'to' in stored&&typeof stored.to==='string'){
   const range={from:stored.from,to:stored.to};
   if(!cashPlanPeriodError(range))return range;
  }
 }catch{/* A corrupt or old preference must never break the finance screen. */}
 return {...DEFAULT_CASH_PLAN_PERIOD};
}

export function serializeCashPlanPeriod(range:DateRange):string {
 resolveCashPlanPeriod(range);
 return JSON.stringify({version:1,...range});
}
