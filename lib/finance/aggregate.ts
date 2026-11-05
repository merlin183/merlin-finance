import type {Account,Dataset,Recurring,Transaction} from './types';
import {addDays,dateISO} from './format';
import {accountSnapshot} from './balances';
import type {AccountBalanceSnapshot} from './account-balance-types';
export function accountBalance(a:Account,tx:Transaction[],asOf:string,snapshots?:readonly AccountBalanceSnapshot[]){return accountSnapshot(a,tx,asOf,snapshots).balance;}
export function occurrences(item:Recurring,from:string,to:string){const dates:string[]=[];if(item.frequency==='once')return item.start_date>=from&&item.start_date<=to?[item.start_date]:[];const d=new Date(from.slice(0,7)+'-01T00:00:00Z');while(dateISO(d)<=to){const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();const day=dateISO(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),Math.min(item.day,last))));if(day>=from&&day<=to&&day>=item.start_date&&(!item.end_date||day<=item.end_date))dates.push(day);d.setUTCMonth(d.getUTCMonth()+1)}return dates;}
export function positions(data:Dataset,asOf:string,horizon=30,snapshots?:readonly AccountBalanceSnapshot[]){return data.businesses.map(b=>{const ac=data.accounts.filter(a=>a.business_id===b.id);const balances=ac.map(a=>accountBalance(a,data.transactions,asOf,snapshots));const balance=ac.length&&balances.every(v=>v!==null)?balances.reduce<number>((s,v)=>s+(v??0),0):null;const expenses=data.recurring.filter(r=>r.business_id===b.id&&r.direction==='out').reduce((s,r)=>s+occurrences(r,addDays(asOf,1),addDays(asOf,horizon)).length*r.amount,0);return {...b,balance,expenses,available:balance===null?null:balance-expenses-b.reserve}})}
/** Explicit current-cash opt-in; historical positions keep ledger-only defaults. */
export function currentCashPositions(data:Dataset,asOf:string,horizon=30){return positions(data,asOf,horizon,data.balance_snapshots);}
export function forecast(data:Dataset,asOf:string,horizon:number){const initial=positions(data,asOf);return Array.from({length:horizon+1},(_,i)=>{const day=addDays(asOf,i);const point:Record<string,string|number|null>={date:day};for(const b of initial){point[b.id]=b.balance===null?null:b.balance+data.recurring.filter(r=>r.business_id===b.id).reduce((sum,r)=>sum+(r.direction==='in'?1:-1)*r.amount*occurrences(r,addDays(asOf,1),day).length,0)}return point})}
export function monthly(tx:Transaction[]){const rows:Record<string,{month:string;income:number;expense:number;net:number}>={};for(const t of tx){const key=t.txn_date.slice(0,7);rows[key]??={month:key,income:0,expense:0,net:0};rows[key][t.direction==='in'?'income':'expense']+=t.amount;rows[key].net+=(t.direction==='in'?1:-1)*t.amount}return Object.values(rows).sort((a,b)=>a.month.localeCompare(b.month))}
export function simulate(data:Dataset,asOf:string,from:string,to:string,amount:number,when=asOf){
 if(from===to)throw Error('서로 다른 사업자를 선택하세요.');
 if(!Number.isSafeInteger(amount)||amount<=0)throw Error('이체 금액은 0보다 큰 정수로 입력하세요.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(when)||when<asOf||when>addDays(asOf,90)||addDays(when,0)!==when)throw Error('예정일은 오늘부터 90일 이내로 입력하세요.');
 const all=positions(data,asOf).map(b=>{
   if(b.balance===null)return b;
   const movement=data.recurring.filter(r=>r.business_id===b.id).reduce((s,r)=>s+(r.direction==='in'?1:-1)*r.amount*occurrences(r,addDays(asOf,1),when).length,0);
   const expenses=data.recurring.filter(r=>r.business_id===b.id&&r.direction==='out').reduce((s,r)=>s+r.amount*occurrences(r,addDays(when,1),addDays(when,30)).length,0);
   return {...b,balance:b.balance+movement,expenses,available:b.balance+movement-expenses-b.reserve};
 });
 const sender=all.find(b=>b.id===from),receiver=all.find(b=>b.id===to);
 if(!sender||!receiver||sender.balance===null||receiver.balance===null)throw Error('두 사업자의 모든 계좌에 개시잔액과 개시일을 먼저 입력하세요.');
 return {sender:{...sender,balance:sender.balance-amount,available:sender.available!-amount},receiver:{...receiver,balance:receiver.balance+amount,available:receiver.available!+amount}};
}
