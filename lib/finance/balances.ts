import type {Account,Transaction} from './types';
import type {AccountBalanceSnapshot} from './account-balance-types';
import {parseFinanceDate} from './date-range';

export type BalanceSnapshot={balance:number|null;date:string|null;source:'statement'|'calculated'|'opening'|'unavailable'|'conflict'|'clobe';transactionId:string|null;message:string;collectedAt?:string;ledgerBalance?:number|null};
const movement=(t:Transaction)=>(t.direction==='in'?1:-1)*t.amount;
const hasBalance=(t:Transaction)=>typeof t.balance==='number'&&Number.isSafeInteger(t.balance);

// Bank balances form a directed path: balance before -> balance after each transaction.
// Verify every edge and a unique endpoint; input/UUID order must not decide a day's closing balance.
export function statementClosing(rows:Transaction[]):Transaction|null{
 if(!rows.length||!rows.every(hasBalance))return null;
 if(rows.length===1)return rows[0];
 const degrees=new Map<number,number>(),edges=new Map<number,Transaction[]>();
 for(const t of rows){const before=t.balance!-movement(t),after=t.balance!;degrees.set(before,(degrees.get(before)||0)+1);degrees.set(after,(degrees.get(after)||0)-1);edges.set(before,[...(edges.get(before)||[]),t]);}
 const starts=[...degrees].filter(([,d])=>d===1),ends=[...degrees].filter(([,d])=>d===-1);
 if([...degrees.values()].some(d=>Math.abs(d)>1)||starts.length!==1||ends.length!==1){
  // A zero-net day needs explicit transaction times to identify its endpoint.
  if([...degrees.values()].some(d=>d!==0)||rows.some(t=>!t.txn_time))return null;
  const timed=[...rows].sort((a,b)=>a.txn_time!.localeCompare(b.txn_time!));
  if(timed.some((t,i)=>i>0&&(t.txn_time===timed[i-1].txn_time||t.balance!-movement(t)!==timed[i-1].balance)))return null;
  return timed.at(-1)!;
 }
 const stack=[starts[0][0]];let used=0;
 while(stack.length){const next=edges.get(stack.at(-1)!);if(next?.length){const edge=next.pop()!;used++;stack.push(edge.balance!);}else stack.pop();}
 if(used!==rows.length)return null;
 const closing=rows.filter(t=>t.balance===ends[0][0]);
 return closing[0]||null;
}

function ledgerAccountSnapshot(account:Account,transactions:Transaction[],asOf:string):BalanceSnapshot{
 const rows=transactions.filter(t=>t.account_id===account.id&&t.txn_date<=asOf);
 const bankDates=[...new Set(rows.filter(hasBalance).map(t=>t.txn_date))].sort();
 const bankDate=bankDates.at(-1);
 if(bankDate){
  const dayRows=rows.filter(t=>t.txn_date===bankDate),closing=statementClosing(dayRows);
  if(!closing)return {balance:null,date:bankDate,source:'conflict',transactionId:null,message:'같은 날의 거래 잔액이 연결되지 않습니다. 해당 날짜의 통장 원본을 확인하세요.'};
  const after=rows.filter(t=>t.txn_date>bankDate);
  return {balance:closing.balance!+after.reduce((sum,t)=>sum+movement(t),0),date:after.length?after.reduce((d,t)=>t.txn_date>d?t.txn_date:d,bankDate):bankDate,source:after.length?'calculated':'statement',transactionId:closing.id,message:after.length?'마지막 통장 잔액에 이후 입출금을 반영했습니다.':'엑셀의 거래 후 잔액'};
 }
 if(!account.opening_balance_date||account.opening_balance_date>asOf)return {balance:null,date:null,source:'unavailable',transactionId:null,message:'잔액이 있는 통장 파일을 올리거나 개시잔액을 설정하세요.'};
 const after=rows.filter(t=>t.txn_date>=account.opening_balance_date!);
 return {balance:Number(account.opening_balance)+after.reduce((sum,t)=>sum+movement(t),0),date:after.length?after.reduce((d,t)=>t.txn_date>d?t.txn_date:d,account.opening_balance_date):account.opening_balance_date,source:after.length?'calculated':'opening',transactionId:null,message:'개시잔액에 입출금을 반영한 계산 잔액'};
}

/** Preserve provider spelling/date. For comparisons only, interpret an
 * offset-free bank clock consistently with the dashboard's Asia/Seoul clock. */
function collectedInstant(value:string):number|null{
 const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
 if(!match||!parseFinanceDate(match[1])||+match[2]>23||+match[3]>59||+match[4]>59)return null;
 if(match[6]&&match[6]!=='Z'){
  const [hours,minutes]=match[6].slice(1).split(':').map(Number);
  if(hours>14||minutes>59||(hours===14&&minutes!==0))return null;
 }
 const instant=Date.parse(value+(match[6]?'':'+09:00'));
 return Number.isFinite(instant)?instant:null;
}

function sourceSnapshot(account:Account,transactions:Transaction[],asOf:string,snapshots:readonly AccountBalanceSnapshot[],ledger:BalanceSnapshot):BalanceSnapshot{
 if(!parseFinanceDate(asOf))return ledger;
 const candidates=snapshots.flatMap(snapshot=>{
  if(!snapshot||snapshot.account_id!==account.id||snapshot.business_id!==account.business_id||snapshot.source!=='clobe'||snapshot.currency!=='KRW'||!Number.isSafeInteger(snapshot.balance)||typeof snapshot.balance_date!=='string'||typeof snapshot.collected_at!=='string'||typeof snapshot.synced_at!=='string'||!parseFinanceDate(snapshot.balance_date)||snapshot.balance_date>asOf||snapshot.collected_at.slice(0,10)!==snapshot.balance_date)return [];
  const collected=collectedInstant(snapshot.collected_at),synced=collectedInstant(snapshot.synced_at);
  if(collected===null||synced===null||!/(?:Z|[+-]\d{2}:\d{2})$/.test(snapshot.synced_at)||collected>synced+5*60*1000)return [];
  return [{snapshot,collected}];
 }).sort((left,right)=>right.collected-left.collected);
 if(!candidates.length)return ledger;
 const {snapshot,collected}=candidates[0];
 // Equal-time contradictory snapshots are not resolved using array order.
 if(candidates.some(item=>item.collected===collected&&(item.snapshot.balance!==snapshot.balance||item.snapshot.balance_date!==snapshot.balance_date)))return ledger;
 if(ledger.date&&snapshot.balance_date<ledger.date)return ledger;
 const rows=transactions.filter(row=>row.account_id===account.id&&row.txn_date<=asOf);
 if(rows.some(row=>row.business_id!==account.business_id||row.txn_date>snapshot.balance_date))return ledger;
 for(const row of rows){
  if(row.txn_date!==snapshot.balance_date||!row.txn_time)continue;
  const instant=collectedInstant(`${row.txn_date}T${row.txn_time}`);
  if(instant!==null&&instant>collected)return ledger;
 }
 const differs=ledger.balance!==snapshot.balance;
 return {balance:snapshot.balance,date:snapshot.balance_date,source:'clobe',transactionId:null,collectedAt:snapshot.collected_at,ledgerBalance:ledger.balance,
  message:differs?'Clobe 수집 잔액 · 거래 기준 잔액과 차이가 있어 남은 지출 확인 필요':'Clobe 수집 잔액 · 저장된 거래 기준 잔액과 일치합니다.',
 };
}

/** Three arguments retain historical ledger-only behavior. Current cash views
 * opt into separately collected balances with the explicit fourth argument.
 * A verified source never changes transactions or marks an obligation paid. */
export function accountSnapshot(account:Account,transactions:Transaction[],asOf:string,snapshots?:readonly AccountBalanceSnapshot[]):BalanceSnapshot{
 const ledger=ledgerAccountSnapshot(account,transactions,asOf);
 return snapshots?.length?sourceSnapshot(account,transactions,asOf,snapshots,ledger):ledger;
}
