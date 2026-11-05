import {accountSnapshot,type BalanceSnapshot} from './balances';
import {parseFinanceDate} from './date-range';
import type {Account,Business,Dataset,Transaction} from './types';

export type LatestCashBusiness={
 business:Business;
 accounts:{account:Account;snapshot:BalanceSnapshot}[];
 balance:number|null;
 knownBalance:number;
 firstRecordDate:string|null;
 lastRecordDate:string|null;
};
export type LatestCashBalances={asOf:string;businesses:LatestCashBusiness[]};

/** Display source collection clocks in Seoul, independently of the viewer's
 * system timezone. Offset-free source clocks already use the bank's Seoul day. */
export function balanceCollectedTimeLabel(value:string|undefined):string|null {
 if(!value)return null;
 const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
 if(!match||!parseFinanceDate(match[1])||+match[2]>23||+match[3]>59||+match[4]>59)return null;
 if(match[6]&&match[6]!=='Z'){
  const [hours,minutes]=match[6].slice(1).split(':').map(Number);
  if(hours>14||minutes>59||(hours===14&&minutes!==0))return null;
 }
 const instant=Date.parse(value+(match[6]?'':'+09:00'));
 if(!Number.isFinite(instant))return null;
 return new Date(instant+9*60*60*1000).toISOString().slice(0,16).replace('T',' ');
}

export function accountBalanceRecordLabel(snapshot:BalanceSnapshot):string {
 if(snapshot.source==='clobe'){
  const collected=balanceCollectedTimeLabel(snapshot.collectedAt);
  return collected?`Clobe 수집 기준 ${collected}`:'Clobe 수집 시각 확인 필요';
 }
 return snapshot.date?`${snapshot.date} 거래 기록 기준`:'잔액 근거일 확인 필요';
}

/** Short labels use existing account names; repeated names retain a masked
 * suffix so two bank accounts never look like one merged account. */
export function latestAccountBalanceRows(business:LatestCashBusiness|undefined) {
 const accounts=business?.accounts??[];
 const names=accounts.map(({account},index)=>account.name.trim()||account.bank.trim()||`통장 ${index+1}`);
 return accounts.map(({account,snapshot},index)=>{
  const repeated=names.filter(name=>name===names[index]).length>1;
  const suffix=account.masked_number.replace(/\s/g,'').slice(-4);
  const detail=repeated?[account.bank.trim()!==names[index]?account.bank.trim():'',suffix].filter(Boolean).join(' '):'';
  return {id:account.id,label:detail?`${names[index]} · ${detail}`:names[index],balance:snapshot.balance,basis:accountBalanceRecordLabel(snapshot)};
 });
}

/** Current cash shares the same collected/ledger resolver as funding plans.
 * Reading a balance never marks a plan paid or changes its saved budget. */
export function buildLatestCashBalances(data:Dataset,asOf:string):LatestCashBalances {
 if(!parseFinanceDate(asOf))throw new RangeError('현재 잔액의 조회 기준일을 확인해주세요.');
 const rowsByAccount=new Map<string,Transaction[]>();
 for(const row of data.transactions){
  const rows=rowsByAccount.get(row.account_id);
  if(rows)rows.push(row);else rowsByAccount.set(row.account_id,[row]);
 }
 const byBusiness=new Map<string,Account[]>();
 for(const account of data.accounts){
  const accounts=byBusiness.get(account.business_id);
  if(accounts)accounts.push(account);else byBusiness.set(account.business_id,[account]);
 }
 const businesses=data.businesses.map((business):LatestCashBusiness=>{
  const accounts=(byBusiness.get(business.id)??[]).map(account=>({account,snapshot:accountSnapshot(account,rowsByAccount.get(account.id)??[],asOf,data.balance_snapshots)}));
  const knownBalance=accounts.reduce((sum,{snapshot})=>sum+(snapshot.balance??0),0);
  const dates=accounts.map(({snapshot})=>snapshot.date).filter((date):date is string=>date!==null).sort();
  return {
   business,accounts,knownBalance,
   balance:accounts.length>0&&accounts.every(({snapshot})=>snapshot.balance!==null)?knownBalance:null,
   firstRecordDate:dates[0]??null,lastRecordDate:dates.at(-1)??null,
  };
 });
 return {asOf,businesses};
}

/** A business may contain bank records from different days; show that range. */
export function latestBalanceRecordLabel(business:LatestCashBusiness|undefined):string {
 if(!business?.lastRecordDate)return '잔액 근거일 확인 필요';
 const dates=business.firstRecordDate===business.lastRecordDate?business.lastRecordDate:`${business.firstRecordDate} ~ ${business.lastRecordDate}`;
 const collected=business.accounts.filter(account=>account.snapshot.source==='clobe');
 if(collected.length){
  const clocks=collected.map(({snapshot})=>balanceCollectedTimeLabel(snapshot.collectedAt)).filter((clock):clock is string=>clock!==null).sort();
  const first=clocks[0],last=clocks.at(-1);
  let clockLabel='시각 확인 필요';
  if(first&&last){
   clockLabel=first===last?first.slice(5):`${first.slice(5)}~${first.slice(0,10)===last.slice(0,10)?last.slice(11):last.slice(5)}`;
   if(clocks.length!==collected.length)clockLabel+=' · 일부 시각 미확인';
  }
  return collected.length===business.accounts.length?`Clobe 수집 기준 ${clockLabel}`:`${dates} 기록 · Clobe ${clockLabel} 포함`;
 }
 return `${dates} 기록`;
}
