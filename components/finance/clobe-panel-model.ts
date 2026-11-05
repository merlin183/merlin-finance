import type {ClobeTransactionRow,ClobeTransactionsResponse} from '@/lib/clobe/types';
import type {ClobeBalanceSyncResult} from '@/lib/clobe/balance-sync';
import {settleDatasetMutation} from '@/lib/finance/dataset-refresh';

/** Saving balances and bank plan evidence is a mutation: navigation must not
 * cancel its shared refresh. Ledger transaction application stays separate. */
export function syncClobePanelBalances(refresh:()=>Promise<void>,requestFetch:typeof fetch=fetch){
 return settleDatasetMutation(clobePanelRequest<ClobeBalanceSyncResult>('/api/clobe/balance-sync',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},requestFetch),refresh);
}

export function clobeAuthorizationUrl(value:unknown):string|null{
 if(typeof value!=='string')return null;
 try{
  const url=new URL(value);
  return url.origin==='https://api.clobe.ai'&&url.pathname==='/oauth/authorize'&&!url.username&&!url.password&&!url.hash?url.href:null;
 }catch{return null;}
}

/** Every new selection invalidates the previous request, even when fetch ignores abort. */
export function createClobeRequestGate(){
 let version=0,controller:AbortController|null=null;
 return {
  begin(){controller?.abort();controller=new AbortController();return {version:++version,signal:controller.signal};},
  current(requestVersion:number){return requestVersion===version&&!controller?.signal.aborted;},
  cancel(){controller?.abort();controller=null;version++;},
 };
}

export async function clobePanelRequest<T>(path:string,options:RequestInit={},requestFetch:typeof fetch=fetch):Promise<T>{
 const response=await requestFetch(path,{...options,cache:'no-store'});
 let value:unknown;
 try{value=await response.json();}catch{throw Error('Clobe 응답을 확인하지 못했습니다. 다시 조회해주세요.');}
 if(!response.ok){
  if(response.status===401){
   if(typeof window!=='undefined')window.dispatchEvent(new Event('finance-auth-invalid'));
   throw Error('대시보드 로그인 권한을 확인해주세요. Google 계정으로 다시 로그인할 수 있습니다.');
  }
  const message=value&&typeof value==='object'&&'error' in value&&typeof value.error==='string'?value.error:'';
  throw Error(message||'Clobe 자료를 조회하지 못했습니다. 잠시 후 다시 시도해주세요.');
 }
 return value as T;
}

export type ClobeQueryScope={companyId:string;bankAccountId:number;startDate:string;endDate:string};
export function matchesClobeQuery(value:ClobeTransactionsResponse,scope:ClobeQueryScope){
 return value.companyId===scope.companyId&&value.bankAccountId===scope.bankAccountId&&value.startDate===scope.startDate&&value.endDate===scope.endDate;
}

export function mergeClobeRows(previous:readonly ClobeTransactionRow[],incoming:readonly ClobeTransactionRow[]):ClobeTransactionRow[]{
 const seen=new Set(previous.map(row=>row.id));
 return [...previous,...incoming.filter(row=>{if(seen.has(row.id))return false;seen.add(row.id);return true;})];
}

export function clobeMoney(value:number|null,currency:string){
 return value===null?'잔액 미확인':`${value.toLocaleString('ko-KR',{maximumFractionDigits:currency==='KRW'?0:2})}${currency==='KRW'?'원':` ${currency}`}`;
}

export function clobeCollectedAt(value:string|null){
 if(!value)return '수집 시각 미확인';
 // Preserve offset-free provider text; only explicitly zoned values are converted.
 if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value))return value.replace('T',' ').slice(0,19);
 const date=new Date(value);
 if(!Number.isFinite(date.getTime()))return '수집 시각 미확인';
 return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
}
