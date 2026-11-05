import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {createClassificationQueue,pendingClassificationIds,failedClassificationChoices,type ClassificationSubmission} from '../lib/finance/classification-queue';
import type {ReviewGroup} from '../lib/finance/classification-review';
import type {Transaction} from '../lib/finance/types';

function group(id:string):ReviewGroup{
 const row:Transaction={id,business_id:'synthetic-business',account_id:'synthetic-account',upload_id:null,txn_date:'2026-01-01',amount:100,direction:'out',description:`SYNTHETIC ${id}`,raw_gwamok:'',category_id:null,is_internal:false,balance:null,tax_invoice:false,dedup_hash:id,manually_classified:false};
 return {key:`group-${id}`,account_id:row.account_id,direction:'out',label:row.description,rows:[row],total:100,from:row.txn_date,to:row.txn_date,patterns:[],canLearn:false,ambiguous:true,suggestedCategoryId:null,reason:'선택 필요',historyCount:0};
}
function submission(groups:ReviewGroup[],category_id='synthetic-fee'):ClassificationSubmission{return {groups,selections:groups.map(group=>({key:group.key,category_id,remember:false,transactions:group.rows.map(({id,category_id,manually_classified})=>({id,category_id,manually_classified}))}))};}
function deferred(){let resolve!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('a row is marked pending immediately and duplicate transaction IDs cannot be submitted under another group key',async()=>{
 const queue=createClassificationQueue(),row=group('one'),result=deferred();let calls=0;
 const running=queue.run(submission([row]),async()=>{calls++;await result.promise;});
 assert.equal(queue.hasPending(),true);assert.equal(pendingClassificationIds(queue.getSnapshot()).has('one'),true);
 assert.equal(await queue.run(submission([{...row,key:'changed-group'}]),async()=>{calls++;}),false);
 await turn();assert.equal(calls,1);result.resolve();assert.equal(await running,true);assert.equal(queue.hasPending(),false);
});

test('independent rows save concurrently and out-of-order responses remove only their own pending rows',async()=>{
 const queue=createClassificationQueue(),first=deferred(),second=deferred();const started:string[]=[];
 const a=queue.run(submission([group('one')]),async()=>{started.push('one');await first.promise;});
 const b=queue.run(submission([group('two')]),async()=>{started.push('two');await second.promise;});
 await turn();assert.deepEqual(started,['one','two']);assert.equal(queue.getSnapshot().pending.length,2);
 second.resolve();await b;assert.deepEqual([...pendingClassificationIds(queue.getSnapshot())],['one']);
 first.resolve();await a;assert.equal(queue.getSnapshot().pending.length,0);
});

test('navigation flush waits for submissions started during an earlier request',async()=>{
 const queue=createClassificationQueue(),first=deferred(),second=deferred();
 const a=queue.run(submission([group('one')]),()=>first.promise);let navigated=false;
 const navigation=queue.flush().then(()=>{navigated=true;});
 const b=queue.run(submission([group('two')]),()=>second.promise);
 first.resolve();await a;await turn();assert.equal(navigated,false);
 second.resolve();await b;await navigation;assert.equal(navigated,true);
});

test('failed requests survive editor unmount with exact groups and chosen categories and are never retried automatically',async()=>{
 const queue=createClassificationQueue(),result=deferred(),submitted=submission([group('one')],'synthetic-rent');let calls=0;
 let notifications=0;const unsubscribe=queue.subscribe(()=>{notifications++;});
 const running=queue.run(submitted,async()=>{calls++;await result.promise;});unsubscribe();
 const rejected=assert.rejects(running,/offline/),navigation=assert.rejects(queue.flush(),/offline/);
 result.reject(Error('offline'));await rejected;await navigation;
 assert.equal(queue.hasPending(),false);assert.equal(queue.getSnapshot().pending.length,0);
 assert.equal(queue.getSnapshot().failed[0].groups[0],submitted.groups[0]);
 assert.equal(failedClassificationChoices(queue.getSnapshot()).get('group-one'),'synthetic-rent');
 assert.equal(notifications,1);await queue.flush();await turn();assert.equal(calls,1);
});

test('retrying one member of a failed batch preserves the other failed rows and their choices',async()=>{
 const queue=createClassificationQueue(),a=group('one'),b=group('two');
 await assert.rejects(queue.run(submission([a,b],'synthetic-rent'),async()=>{throw Error('retry');}));
 await queue.run(submission([a],'synthetic-fee'),async()=>{});
 assert.deepEqual(queue.getSnapshot().failed.flatMap(entry=>entry.groups.map(group=>group.key)),['group-two']);
 assert.equal(failedClassificationChoices(queue.getSnapshot()).get('group-two'),'synthetic-rent');
 assert.equal(failedClassificationChoices(queue.getSnapshot()).has('group-one'),false);
});

test('synchronous errors restore rows and a navigation subscriber sees the already registered request',async()=>{
 const queue=createClassificationQueue();let flushing:Promise<void>|undefined;
 const unsubscribe=queue.subscribe(()=>{if(queue.hasPending()&&!flushing)flushing=queue.flush();});
 const pending=queue.run(submission([group('one')]),()=>{throw Error('validation failed');});
 const rejected=assert.rejects(pending,/validation failed/),navigation=assert.rejects(flushing!,/validation failed/);
 await rejected;await navigation;unsubscribe();assert.equal(queue.getSnapshot().failed.length,1);
});
