import {formatFinanceDate,parseFinanceDate,type DateRange} from './date-range';
import type {Transaction} from './types';

export type TransactionCalendarDay={date:string;transactions:Transaction[];income:number;expense:number};
export type TransactionCalendar={month:string;days:(TransactionCalendarDay|null)[];transactions:Transaction[];income:number;expense:number};

function monthStart(month:string):Date {
 const date=/^\d{4}-\d{2}$/.test(month)?parseFinanceDate(`${month}-01`):undefined;
 if(!date)throw new RangeError('조회할 월을 확인해주세요.');
 return date;
}

/** Full calendar month, including its final day rather than stopping at today. */
export function calendarMonthRange(month:string):DateRange {
 const first=monthStart(month);
 const last=new Date(first.getFullYear(),first.getMonth()+1,0);
 return {from:formatFinanceDate(first),to:formatFinanceDate(last)};
}

/** Clamp navigation at the same supported year boundaries as finance dates. */
export function shiftCalendarMonth(month:string,delta:number):string {
 const first=monthStart(month);
 if(!Number.isSafeInteger(delta))throw new RangeError('이동할 개월 수를 확인해주세요.');
 const index=Math.max(1900*12,Math.min(9999*12+11,first.getFullYear()*12+first.getMonth()+delta));
 return `${String(Math.floor(index/12)).padStart(4,'0')}-${String(index%12+1).padStart(2,'0')}`;
}

const compareText=(left:string,right:string)=>left<right?-1:left>right?1:0;
function compareTransactions(left:Transaction,right:Transaction):number {
 return compareText(left.txn_date,right.txn_date)
  ||compareText(left.txn_time||'\uffff',right.txn_time||'\uffff')
  ||compareText(left.id,right.id);
}

/**
 * Rows are already filtered by the caller. Aggregate all of them, preserving
 * distinct source transactions and leaving source arrays/objects untouched.
 * Days and detail rows use chronological order; unknown times sort last.
 */
export function buildTransactionCalendar(rows:readonly Transaction[],month:string):TransactionCalendar {
 const first=monthStart(month);
 const range=calendarMonthRange(month);
 const count=Number(range.to.slice(-2));
 const actualDays=Array.from({length:count},(_,index):TransactionCalendarDay=>({
  date:`${month}-${String(index+1).padStart(2,'0')}`,transactions:[],income:0,expense:0,
 }));
 const byDate=new Map(actualDays.map(day=>[day.date,day]));
 let income=0,expense=0;
 for(const transaction of rows){
  // Exact real-date keys also reject impossible dates and timestamp strings.
  const day=byDate.get(transaction.txn_date);
  if(!day)continue;
  day.transactions.push(transaction);
  if(transaction.direction==='in'){
   day.income+=transaction.amount;income+=transaction.amount;
  }else{
   day.expense+=transaction.amount;expense+=transaction.amount;
  }
 }
 for(const day of actualDays)day.transactions.sort(compareTransactions);
 const transactions=actualDays.flatMap(day=>day.transactions);
 const leading=first.getDay();
 const cells=Math.ceil((leading+count)/7)*7;
 const days=Array.from({length:cells},(_,index)=>actualDays[index-leading]??null);
 return {month,days,transactions,income,expense};
}
