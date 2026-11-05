import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisibleDatasetInvalidation} from '../lib/finance/visible-dataset-invalidation';
import {createDatasetRefreshCoordinator} from '../lib/finance/dataset-refresh';

function deferred(){
 let resolve!:()=>void,reject!:(error:Error)=>void;
 const promise=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});
 return {promise,resolve,reject};
}

test('hidden signals coalesce and one visible resume reads even without an age threshold',async()=>{
 let visible=false,reads=0;
 const pending=deferred();
 const invalidation=createVisibleDatasetInvalidation({isVisible:()=>visible,refreshAfterChange:async()=>{reads++;await pending.promise;}});
 for(let i=0;i<16;i++)assert.equal(invalidation.invalidate(),null);
 assert.equal(invalidation.resume(),null);assert.equal(reads,0);
 visible=true;
 const resumed=invalidation.resume();assert.ok(resumed);
 assert.equal(invalidation.resume(),resumed);
 await Promise.resolve();assert.equal(reads,1);
 pending.resolve();await resumed;
 assert.equal(invalidation.resume(),null);assert.equal(reads,1);
});

test('a visible tab refreshes immediately and keeps a signal arriving during its pending read',async()=>{
 const first=deferred();let reads=0;
 const invalidation=createVisibleDatasetInvalidation({isVisible:()=>true,refreshAfterChange:async()=>{reads++;if(reads===1)await first.promise;}});
 const initial=invalidation.invalidate();assert.ok(initial);
 await Promise.resolve();assert.equal(reads,1);
 for(let i=0;i<4;i++)assert.equal(invalidation.invalidate(),initial);
 first.resolve();await initial;
 assert.equal(reads,2);assert.equal(invalidation.resume(),null);
});

test('a signal received while a pre-change snapshot is pending still reads the committed state',async()=>{
 const coordinator=createDatasetRefreshCoordinator(),old=deferred();let stored=100,shown=0,reads=0;
 const read=async()=>{const snapshot=stored;reads++;if(reads===1)await old.promise;shown=snapshot;};
 const stale=coordinator.refresh(read);await Promise.resolve();
 stored=200;
 const invalidation=createVisibleDatasetInvalidation({isVisible:()=>true,refreshAfterChange:()=>coordinator.afterChange(read)});
 const refreshed=invalidation.invalidate();assert.ok(refreshed);
 await Promise.resolve();assert.equal(reads,1);
 old.resolve();await stale;await refreshed;
 assert.equal(reads,2);assert.equal(shown,200);
});

test('becoming hidden during a read retains later signals until visible again',async()=>{
 let visible=true,reads=0;const first=deferred();
 const invalidation=createVisibleDatasetInvalidation({isVisible:()=>visible,refreshAfterChange:async()=>{reads++;if(reads===1)await first.promise;}});
 const initial=invalidation.invalidate();await Promise.resolve();
 visible=false;assert.equal(invalidation.invalidate(),null);
 first.resolve();await initial;assert.equal(reads,1);
 visible=true;await invalidation.resume();assert.equal(reads,2);
});

test('failed reads stay dirty without automatic retries and can resume on a later event',async()=>{
 let reads=0;
 const invalidation=createVisibleDatasetInvalidation({isVisible:()=>true,refreshAfterChange:async()=>{reads++;if(reads===1)throw Error('synthetic read failure');}});
 await assert.rejects(invalidation.invalidate()!,/synthetic read failure/);
 await Promise.resolve();assert.equal(reads,1);
 await invalidation.resume();assert.equal(reads,2);assert.equal(invalidation.resume(),null);
});

test('dispose prevents future reads and drops an invalidation queued behind the current read',async()=>{
 const first=deferred();let reads=0;
 const invalidation=createVisibleDatasetInvalidation({isVisible:()=>true,refreshAfterChange:async()=>{reads++;await first.promise;}});
 const initial=invalidation.invalidate();await Promise.resolve();
 invalidation.invalidate();invalidation.dispose();
 assert.equal(invalidation.invalidate(),null);assert.equal(invalidation.resume(),null);
 first.resolve();await initial;assert.equal(reads,1);
});
