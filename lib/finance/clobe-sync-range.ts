import {parseFinanceDate} from './date-range';

export type ClobeSyncRange={from:string;to:string;months:string[]};

/** Automatic bank synchronization covers last month and this month in Seoul.
 * It does not change a user's manual import or dashboard display period. */
export function clobeSyncRange(instant=Date.now()):ClobeSyncRange{
 if(!Number.isFinite(instant))throw Error('동기화 기준 날짜를 확인해주세요.');
 let to:string;
 try{to=new Date(instant+9*3600000).toISOString().slice(0,10);}catch{throw Error('동기화 기준 날짜를 확인해주세요.');}
 if(!parseFinanceDate(to))throw Error('동기화 기준 날짜를 확인해주세요.');
 const [year,month]=to.split('-').map(Number),from=new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,10);
 if(!parseFinanceDate(from))throw Error('동기화 기준 날짜를 확인해주세요.');
 return {from,to,months:[from.slice(0,7),to.slice(0,7)]};
}
