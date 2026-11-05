import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatasetRefreshCoordinator,settleDatasetMutation} from '../lib/finance/dataset-refresh';
import {createDatasetUpdates,mergeClassificationResult} from '../lib/finance/dataset-updates';
import {emptyDataset,type Transaction} from '../lib/finance/types';

function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
 const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});
 return {promise,resolve,reject};
}

test('ordinary refresh shares its request, then another refresh reads again',async()=>{
 const coordinator=createDatasetRefreshCoordinator(),response=deferred<void>();let reads=0;
 const task=async()=>{reads++;await response.promise;};
 const first=coordinator.refresh(task),second=coordinator.refresh(task);
 assert.equal(first,second);
 await Promise.resolve();assert.equal(reads,1);
 response.resolve();await first;
 await coordinator.refresh(task);assert.equal(reads,2);
});

test('a successful sync waits for an older snapshot then fetches the committed new rows',async()=>{
 const coordinator=createDatasetRefreshCoordinator(),oldResponse=deferred<void>();
 let stored=[100],shown:number[]=[],reads=0,signals=0;
 const read=async()=>{
  const snapshot=[...stored];reads++;
  if(reads===1)await oldResponse.promise;
  shown=snapshot;
 };
 const older=coordinator.refresh(read);await Promise.resolve();
 stored=[100,50];
 const completion=settleDatasetMutation(Promise.resolve({inserted:1,blocked:0}),()=>coordinator.afterChange(read),()=>{signals++;});
 await Promise.resolve();assert.equal(reads,1);
 oldResponse.resolve();await older;
 const outcome=await completion;
 assert.equal(outcome.refreshed,true);assert.equal(reads,2);assert.equal(signals,1);
 assert.deepEqual(shown,[100,50]);
});

test('a failed pre-mutation read does not prevent the fresh post-mutation read',async()=>{
 const coordinator=createDatasetRefreshCoordinator(),oldResponse=deferred<void>();let reads=0;
 const old=coordinator.refresh(async()=>{reads++;await oldResponse.promise;});
 const handledOld=old.catch(()=>{});
 const fresh=coordinator.afterChange(async()=>{reads++;});
 oldResponse.reject(new Error('old read failed'));
 await handledOld;await fresh;
 assert.equal(reads,2);
});

test('leaving the initiating upload screen before the save reply does not cancel shared refresh',async()=>{
 const saved=deferred<{inserted:number;blocked:number}>();
 let screenMounted=true,localResult=false,sharedReads=0;
 const finished=settleDatasetMutation(saved.promise,async()=>{sharedReads++;},()=>{}).then(completion=>{
  if(screenMounted)localResult=true;
  return completion;
 });
 screenMounted=false;saved.resolve({inserted:2,blocked:1});
 const completion=await finished;
 assert.equal(sharedReads,1);assert.equal(localResult,false);
 assert.equal(completion.refreshed,true);assert.deepEqual(completion.result,{inserted:2,blocked:1});
});

test('the initiating tab finishes its refresh before other tabs are notified once',async()=>{
 const response=deferred<void>(),events:string[]=[];
 const completion=settleDatasetMutation(Promise.resolve({inserted:0}),async()=>{
  events.push('local refresh started');
  await response.promise;
  events.push('local refresh completed');
 },()=>{events.push('notify other tabs');});
 await Promise.resolve();
 assert.deepEqual(events,['local refresh started']);
 response.resolve();
 assert.equal((await completion).refreshed,true);
 assert.deepEqual(events,['local refresh started','local refresh completed','notify other tabs']);
});

test('other tabs are notified once after a failed local refresh, including notification failure',async()=>{
 const response=deferred<void>(),events:string[]=[],refreshError=Error('local read failed');
 const completion=settleDatasetMutation(Promise.resolve({inserted:1}),async()=>{
  events.push('local refresh started');
  try{await response.promise;}finally{events.push('local refresh finished');}
 },()=>{events.push('notify other tabs');throw Error('channel unavailable');});
 await Promise.resolve();
 assert.deepEqual(events,['local refresh started']);
 response.reject(refreshError);
 const outcome=await completion;
 assert.equal(outcome.refreshed,false);
 if(!outcome.refreshed)assert.equal(outcome.refreshError,refreshError);
 assert.deepEqual(outcome.result,{inserted:1});
 assert.deepEqual(events,['local refresh started','local refresh finished','notify other tabs']);
});

test('refresh failure preserves committed partial success; retry only reads and never repeats the write',async()=>{
 const coordinator=createDatasetRefreshCoordinator();let writes=0,reads=0,signals=0;
 const save=async()=>{writes++;return {inserted:2,blocked:1,unchanged:3};};
 const read=async()=>{reads++;if(reads===1)throw Error('synthetic connection failed');};
 const completion=await settleDatasetMutation(save(),()=>coordinator.afterChange(read),()=>{signals++;});
 assert.equal(completion.refreshed,false);
 if(!completion.refreshed)assert.match(completion.refreshError.message,/connection failed/);
 assert.deepEqual(completion.result,{inserted:2,blocked:1,unchanged:3});
 await coordinator.afterChange(read);
 assert.equal(writes,1);assert.equal(reads,2);assert.equal(signals,1);
});

test('a saved no-change run still refreshes, while a failed mutation neither refreshes nor signals',async()=>{
 let reads=0,signals=0;
 const read=async()=>{reads++;},signal=()=>{signals++;};
 await settleDatasetMutation(Promise.resolve({inserted:0,unchanged:5}),read,signal);
 assert.equal(reads,1);assert.equal(signals,1);
 await assert.rejects(settleDatasetMutation(Promise.reject(Error('save failed')),read,signal),/save failed/);
 assert.equal(reads,1);assert.equal(signals,1);
});

test('notification failure cannot hide a successful write or stop this workspace refresh',async()=>{
 let reads=0;
 const result=await settleDatasetMutation(Promise.resolve({inserted:1}),async()=>{reads++;},()=>{throw Error('channel unavailable');});
 assert.equal(result.refreshed,true);assert.equal(reads,1);
});

test('shared refresh retains classification replay protection during a slow snapshot',async()=>{
 const transaction:Transaction={id:'synthetic',business_id:'b',account_id:'a',upload_id:null,txn_date:'2026-09-30',amount:100,direction:'out',description:'Synthetic',raw_gwamok:'',category_id:null,is_internal:false,balance:900,tax_invoice:false,dedup_hash:'synthetic',manually_classified:false};
 const initial={...emptyDataset,transactions:[transaction]},updates=createDatasetUpdates(),coordinator=createDatasetRefreshCoordinator(),response=deferred<void>();
 let shown=initial;
 const read=coordinator.refresh(async()=>{
  const snapshot=updates.beginRead();
  try{await response.promise;shown=snapshot.apply(initial);}finally{snapshot.finish();}
 });
 await Promise.resolve();
 updates.record(data=>mergeClassificationResult(data,{updated:1,learned:0,transactions:[{id:transaction.id,category_id:'fee',is_internal:false,manually_classified:true}]}));
 response.resolve();await read;
 assert.equal(shown.transactions[0].category_id,'fee');assert.equal(shown.transactions[0].balance,900);
 assert.equal(initial.transactions[0].category_id,null);
});
