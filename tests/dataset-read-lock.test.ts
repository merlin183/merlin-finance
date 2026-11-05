import test from 'node:test';
import assert from 'node:assert/strict';
import {DATASET_READ_LOCK_NAME,withDatasetReadLock,type DatasetReadLockManager} from '../lib/finance/dataset-read-lock';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function sharedLocks(){
 let tail:Promise<void>=Promise.resolve();const names:string[]=[];
 const locks:DatasetReadLockManager={request<T>(name:string,options:{mode:'exclusive'},callback:()=>Promise<T>){
  names.push(name);assert.deepEqual(options,{mode:'exclusive'});
  const read=tail.then(callback);tail=read.then(()=>{},()=>{});return read;
 }};
 return {locks,names};
}

test('independent same-origin documents never overlap dataset reads and exchange only the generic lock name',async()=>{
 const {locks,names}=sharedLocks(),firstResponse=deferred<void>();let active=0,maximum=0,reads=0;
 const read=async(document:string)=>{active++;maximum=Math.max(maximum,active);reads++;try{if(document==='first')await firstResponse.promise;return document;}finally{active--;}};
 const first=withDatasetReadLock(()=>read('first'),locks),second=withDatasetReadLock(()=>read('second'),locks);
 await Promise.resolve();assert.equal(reads,1);assert.equal(active,1);
 firstResponse.resolve();assert.deepEqual(await Promise.all([first,second]),['first','second']);
 assert.equal(maximum,1);assert.equal(reads,2);assert.deepEqual(names,[DATASET_READ_LOCK_NAME,DATASET_READ_LOCK_NAME]);
 assert.doesNotMatch(DATASET_READ_LOCK_NAME,/owner|account|email|token/);
});

test('callback failure and timeout release the lock for the next document without repeating the failed read',async()=>{
 for(const error of [Error('synthetic dataset failure'),new DOMException('synthetic read timeout','TimeoutError')]){
  const {locks}=sharedLocks();let failedReads=0,nextReads=0;
  const failed=withDatasetReadLock(async()=>{failedReads++;throw error;},locks);
  const rejected=assert.rejects(failed,value=>value===error);
  const next=withDatasetReadLock(async()=>{nextReads++;return 42;},locks);
  await rejected;assert.equal(await next,42);assert.equal(failedReads,1);assert.equal(nextReads,1);
 }
});

test('a queued callback rechecks mounted/session state and never queries a logged-out document',async()=>{
 const {locks}=sharedLocks(),firstResponse=deferred<void>();let mounted=true,sessionActive=true,authenticatedReads=0;
 const first=withDatasetReadLock(()=>firstResponse.promise,locks);
 const second=withDatasetReadLock(async()=>{if(!mounted||!sessionActive)return;authenticatedReads++;},locks);
 await Promise.resolve();mounted=false;sessionActive=false;firstResponse.resolve();await Promise.all([first,second]);
 assert.equal(authenticatedReads,0);
});

test('unsupported locks and acquisition SecurityError use exactly one existing read while other acquisition errors propagate',async()=>{
 let reads=0;const read=async()=>{reads++;return 'synthetic result';};
 assert.equal(await withDatasetReadLock(read,null),'synthetic result');assert.equal(reads,1);
 const denied:DatasetReadLockManager={request:async()=>{throw new DOMException('policy denied','SecurityError');}};
 assert.equal(await withDatasetReadLock(read,denied),'synthetic result');assert.equal(reads,2);
 const unavailable:DatasetReadLockManager={request:async()=>{throw new DOMException('synthetic acquisition failure','AbortError');}};
 await assert.rejects(withDatasetReadLock(read,unavailable),/synthetic acquisition failure/);assert.equal(reads,2);
});

test('a SecurityError from the actual callback is not mistaken for acquisition denial and cannot rerun the read',async()=>{
 const {locks}=sharedLocks();let reads=0;
 await assert.rejects(withDatasetReadLock(async()=>{reads++;throw new DOMException('dataset read denied','SecurityError');},locks),/dataset read denied/);
 assert.equal(reads,1);
 assert.equal(await withDatasetReadLock(async()=>42,locks),42);
});
