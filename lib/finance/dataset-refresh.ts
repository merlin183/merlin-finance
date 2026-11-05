import {publishDatasetChange} from './dataset-change-signal';

type RefreshTask=()=>Promise<void>;

/** Share ordinary reads, but a committed write needs a read started afterwards.
 * A failed older read must not prevent that new read from being attempted. */
export function createDatasetRefreshCoordinator(){
 let current:Promise<void>|null=null;
 function refresh(task:RefreshTask):Promise<void>{
  if(current)return current;
  const pending=Promise.resolve().then(task).finally(()=>{if(current===pending)current=null;});
  current=pending;
  return pending;
 }
 async function afterChange(task:RefreshTask){
  const previous=current;
  if(previous)await previous.catch(()=>{});
  await refresh(task);
 }
 return {refresh,afterChange};
}

export type DatasetMutationCompletion<T>={result:T;refreshed:true}|{result:T;refreshed:false;refreshError:Error};

/** Once the server confirms a write, refresh the shared workspace even if its
 * initiating screen has unmounted. A refresh failure never retries the write. */
export async function settleDatasetMutation<T>(mutation:Promise<T>,refresh:RefreshTask,notify:()=>void=publishDatasetChange):Promise<DatasetMutationCompletion<T>>{
 const result=await mutation;
 try{
  await refresh();
  return {result,refreshed:true};
 }catch(cause){
  return {result,refreshed:false,refreshError:cause instanceof Error?cause:new Error('자료를 다시 불러오지 못했습니다.')};
 }finally{
  // Refresh this tab first so other tabs cannot queue ahead of it for the shared
  // read lock. They still need invalidation when the local refresh fails.
  try{notify();}catch{/* Cross-tab notification is best effort. */}
 }
}
