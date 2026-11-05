import type {ClobeBalanceSyncResult} from '../clobe/balance-sync';
import type {DatasetMutationCompletion} from './dataset-refresh';

export type ClobeBalanceSyncCompletion=DatasetMutationCompletion<ClobeBalanceSyncResult>;

/** Acquire the guard before React renders its disabled button. Once saving has
 * succeeded, a failed dataset read may only be retried as a read. */
export function createClobeBalanceSyncActions(sync:()=>Promise<ClobeBalanceSyncCompletion>,refresh:()=>Promise<void>){
 let busy=false,completion:ClobeBalanceSyncCompletion|null=null;
 return {
  sync():Promise<ClobeBalanceSyncCompletion>|null{
   if(busy||completion?.refreshed===false)return null;
   busy=true;
   return Promise.resolve().then(sync).then(value=>{completion=value;return value;}).finally(()=>{busy=false;});
  },
  retryRefresh():Promise<ClobeBalanceSyncCompletion>|null{
   if(busy||!completion||completion.refreshed)return null;
   busy=true;
   const saved=completion.result;
   return Promise.resolve().then(refresh).then(()=>{
    completion={result:saved,refreshed:true};return completion;
   },cause=>{
    completion={result:saved,refreshed:false,refreshError:cause instanceof Error?cause:new Error('화면 잔액을 다시 조회하지 못했습니다.')};return completion;
   }).finally(()=>{busy=false;});
  },
 };
}

export function clobeBalanceSyncFeedback(completion:ClobeBalanceSyncCompletion){
 const {result,refreshed}=completion;
 const available=result.synced+result.unchanged>0;
 const actuals=result.plan_actuals;
 const outflowsAvailable=!!actuals&&(actuals.synced_accounts+actuals.unchanged_accounts>0||actuals.saved_outflows>0);
 const outflowWarning=!!actuals&&(!actuals.complete||actuals.skipped.length>0);
 const warning=!refreshed||result.skipped.length>0||outflowWarning||!available;
 let title:string;
 if(actuals){
  if(!refreshed)title='동기화 저장 완료 · 화면 조회 필요';
  else if(outflowWarning)title='동기화 결과 · 은행 출금 확인 필요';
  else if(result.skipped.length)title='동기화 결과 · 통장 자료 확인 필요';
  else if(available)title='잔액·은행 출금 자료를 확인했습니다';
  else if(outflowsAvailable)title='은행 출금 자료 반영 · 잔액 확인 필요';
  else title='반영 가능한 통장 자료를 확인해주세요';
 }else{
  if(!refreshed)title='잔액 저장 완료 · 화면 조회 필요';
  else if(!available)title='반영 가능한 통장 잔액이 없습니다';
  else title=result.synced?'Clobe 잔액 동기화 완료':'저장된 잔액이 최신입니다';
 }
 return {
  title,
  counts:`잔액 갱신 ${result.synced}개 · 최신 유지 ${result.unchanged}개 · 확인 필요 ${result.skipped.length}개`,
  outflowCounts:actuals?`은행 출금 조회 ${actuals.fetched_outflows}건 · 계획용 보관 ${actuals.saved_outflows}건`:null,
  outflowAccounts:actuals?`출금 자료 갱신 ${actuals.synced_accounts}개 계좌 · 최신 유지 ${actuals.unchanged_accounts}개 · 확인 필요 ${actuals.skipped.length}개`:null,
  outflowWarning,warning,
  recalculated:refreshed&&(available||outflowsAvailable),
  recalculatedText:actuals?'조회한 잔액·은행 출금을 반영해 남은 지출·필요자금을 다시 계산했습니다.':'현재 잔액·지출 후 잔액·필요자금을 갱신했습니다.',
  refreshText:actuals?'동기화 결과는 저장됐습니다. 화면 조회만 다시 시도해주세요.':'잔액은 저장됐습니다. 화면 조회만 다시 시도해주세요.',
 };
}
