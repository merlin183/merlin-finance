import type {ClobeAccountMapping} from '../finance/clobe-import';
import type {ClobeAccountsResponse} from './types';
import {validClobeDate} from './read';
import {syncClobePlanActuals,type ClobePlanActualDependencies,type ClobePlanActualResult} from './plan-actuals-sync';

export type ClobeBalanceSkip={account_id?:string;reason:string};
export type ClobeBalanceInput={company_id:string;external_account_id:string;account_id:string;balance:number;balance_date:string;collected_at:string};
export type ClobeBalanceSaved={synced:number;unchanged:number;skipped:ClobeBalanceSkip[]};
export type ClobeBalanceSyncResult=ClobeBalanceSaved&{accounts:ClobeAccountsResponse;plan_actuals?:ClobePlanActualResult};
export type ClobeBalanceDependencies={getMappings:()=>Promise<ClobeAccountMapping[]>;readAccounts:()=>Promise<ClobeAccountsResponse>;save:(rows:ClobeBalanceInput[])=>Promise<ClobeBalanceSaved>;now?:()=>number;planActuals?:ClobePlanActualDependencies};

/** Preserve the provider text/date. The internal ordering instant interprets
 * an offset-free source only for stale-response/future checks, never for display. */
export function clobeCollectedInstant(value:string){
 const m=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
 if(!m||!validClobeDate(m[1])||+m[2]>23||+m[3]>59||+m[4]>59)return null;
 if(m[6]&&m[6]!=='Z'){const [hours,minutes]=m[6].slice(1).split(':').map(Number);if(hours>14||minutes>59||hours===14&&minutes!==0)return null;}
 const instant=Date.parse(value+(m[6]?'':'+09:00'));return Number.isFinite(instant)?instant:null;
}
const validMapping=(m:ClobeAccountMapping)=>typeof m.company_id==='string'&&m.company_id.length>0&&m.company_id.length<=200&&/^[1-9]\d{0,15}$/.test(m.external_account_id)&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(m.account_id);

/** Even a zero-new-transaction sync saves collected balances for explicitly
 * mapped KRW accounts. No transaction/plan/classification is supplied or edited. */
export async function syncClobeBalances(deps:ClobeBalanceDependencies):Promise<ClobeBalanceSyncResult>{
 const startedAt=(deps.now??Date.now)();
 const mappings=await deps.getMappings();
 if(mappings.length>100||mappings.some(m=>!validMapping(m))||new Set(mappings.map(m=>m.account_id)).size!==mappings.length||new Set(mappings.map(m=>JSON.stringify([m.company_id,m.external_account_id]))).size!==mappings.length)throw Error('CLOBE_BALANCE_CONFIGURATION');
 const accounts=await deps.readAccounts(),rows:ClobeBalanceInput[]=[],skipped:ClobeBalanceSkip[]=[];
 const now=(deps.now??Date.now)(),today=new Date(now+9*60*60*1000).toISOString().slice(0,10);
 for(const mapping of mappings){
  const company=accounts.companies.find(c=>c.id===mapping.company_id),account=company?.accounts.find(a=>String(a.id)===mapping.external_account_id);
  const skip=(reason:string)=>skipped.push({account_id:mapping.account_id,reason});
  if(!company||company.error||!account){skip('연결된 Clobe 사업자·통장을 조회하지 못해 잔액을 유지했습니다.');continue;}
  if(account.currency!=='KRW'){skip('외화 통장은 원화 잔액 계산에 포함하지 않았습니다.');continue;}
  if(company.scraping.status!=='SUCCESS'||company.scraping.error){skip('Clobe 은행 자료 수집이 완료되지 않아 잔액을 유지했습니다.');continue;}
  const collectedAt=company.scraping.lastCollectedAt,instant=collectedAt?clobeCollectedInstant(collectedAt):null;
  if(!collectedAt||instant===null){skip('은행 자료 수집 시각을 확인하지 못해 잔액을 유지했습니다.');continue;}
  if(collectedAt.slice(0,10)>today||instant>now+5*60*1000){skip('은행 자료 수집 시각이 현재보다 미래여서 잔액을 유지했습니다.');continue;}
  if(account.balance===null||!Number.isSafeInteger(account.balance)){skip('원화 통장의 정확한 잔액을 확인하지 못해 기존 잔액을 유지했습니다.');continue;}
  rows.push({company_id:mapping.company_id,external_account_id:mapping.external_account_id,account_id:mapping.account_id,balance:account.balance,balance_date:collectedAt.slice(0,10),collected_at:collectedAt});
 }
 // Persist through the signed server RPC even when the valid list is empty;
 // its access check and response remain consistent with successful reads.
 const saved=await deps.save(rows);
 if(!mappings.length)skipped.push({reason:'저장된 Clobe 통장 연결이 없습니다. 통장·기간 선택 후 대시보드 적용으로 계좌 연결을 먼저 저장해주세요.'});
 const rejected=new Set(saved.skipped.flatMap(row=>row.account_id?[row.account_id]:[]));
 const plan_actuals=deps.planActuals?await syncClobePlanActuals(deps.planActuals,mappings,rows.filter(row=>!rejected.has(row.account_id)),startedAt):undefined;
 return {accounts,synced:saved.synced,unchanged:saved.unchanged,skipped:[...skipped,...saved.skipped],...(plan_actuals?{plan_actuals}:{})};
}
