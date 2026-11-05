export type DateRange = {from:string;to:string};
export type DateRangePreset = 'month'|'last-month'|'quarter'|'year'|'all';

/** Calendar dates use local fields, never a UTC conversion that moves the day. */
export function parseFinanceDate(value:string):Date|undefined {
 const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
 if(!match)return undefined;
 const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
 if(year<1900||year>9999)return undefined;
 const date=new Date(year,month-1,day);
 return date.getFullYear()===year&&date.getMonth()===month-1&&date.getDate()===day?date:undefined;
}

export function formatFinanceDate(date:Date):string {
 if(!Number.isFinite(date.getTime()))return '';
 return `${String(date.getFullYear()).padStart(4,'0')}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

export function isValidDateRange(range:DateRange):boolean {
 return !!parseFinanceDate(range.from)&&!!parseFinanceDate(range.to)&&range.from<=range.to;
}

/** Include the entire actual source period, including a future-dated source row. */
export function dateRangeBounds(rows:readonly {txn_date:string}[],fallbackToday:string):DateRange {
 let from='',to='';
 for(const row of rows){
  if(!parseFinanceDate(row.txn_date))continue;
  if(!from||row.txn_date<from)from=row.txn_date;
  if(!to||row.txn_date>to)to=row.txn_date;
 }
 return from?{from,to}:{from:fallbackToday,to:fallbackToday};
}

export function dateRangePreset(preset:DateRangePreset,today:string,bounds?:DateRange):DateRange {
 const date=parseFinanceDate(today);
 if(!date)throw Error('기준 날짜를 확인해주세요.');
 const year=date.getFullYear(),month=date.getMonth();
 if(preset==='all')return bounds&&isValidDateRange(bounds)?{...bounds}:{from:today,to:today};
 if(preset==='last-month')return {from:formatFinanceDate(new Date(year,month-1,1)),to:formatFinanceDate(new Date(year,month,0))};
 const startMonth=preset==='year'?0:preset==='quarter'?Math.floor(month/3)*3:month;
 return {from:formatFinanceDate(new Date(year,startMonth,1)),to:today};
}

export function resolveDateRange(overall:DateRange,override?:DateRange):DateRange {
 return override&&isValidDateRange(override)?override:overall;
}

/** Both boundary days belong to the report; the original array stays untouched. */
export function filterTransactionsByRange<T extends {txn_date:string}>(rows:readonly T[],range:DateRange):T[] {
 if(!isValidDateRange(range))return [];
 return rows.filter(row=>row.txn_date>=range.from&&row.txn_date<=range.to);
}
