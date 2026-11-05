import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {createMerchantNoteStore,type NoteWrite,type NoteWriteResult} from '../lib/finance/merchant-note-store';
import {noteSubject} from '../lib/finance/merchant-notes';
import type {MerchantNote,Transaction} from '../lib/finance/types';

function transaction(id='one'):Transaction{return {id,business_id:'synthetic-business',account_id:`synthetic-account-${id}`,upload_id:null,txn_date:'2026-01-01',amount:100,direction:'out',description:'SYNTHETIC CLOUD SERVICE',raw_gwamok:'',category_id:null,is_internal:false,balance:null,tax_invoice:false,dedup_hash:id,manually_classified:false};}
function note(tx:Transaction,memo:string,version:number):MerchantNote{return {id:`synthetic-note-${tx.id}`,...noteSubject(tx),memo,version,updated_at:'2026-01-01T00:00:00Z'};}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('typing notifies only editors for the same merchant and keeps other snapshots stable',t=>{
 const a=transaction(),b=transaction('two');
 const store=createMerchantNoteStore([],async()=>{throw Error('not saving');});t.after(()=>store.dispose());
 let aUpdates=0,bUpdates=0;
 const first=store.state(a),other=store.state(b);
 const unsubscribe=store.subscribe(a,()=>aUpdates++);store.subscribe(b,()=>bUpdates++);
 store.change(a,'메모 입력');
 assert.equal(aUpdates,1);assert.equal(bUpdates,0);assert.equal(store.state(b),other);
 assert.notEqual(store.state(a),first);assert.equal(store.state(a),store.state(a));
 unsubscribe();store.change(a,'메모 추가 입력');assert.equal(aUpdates,1);
});

test('idle typing autosaves the final text once, without requiring blur',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const tx=transaction(),writes:NoteWrite[]=[];
 const store=createMerchantNoteStore([],async input=>{writes.push(input);return {note:note(tx,input.memo,1)};});t.after(()=>store.dispose());
 store.change(tx,'첫');t.mock.timers.tick(500);store.change(tx,'최종 입력');
 t.mock.timers.tick(799);await turn();assert.equal(writes.length,0);
 t.mock.timers.tick(1);await store.flush();
 assert.deepEqual(writes,[{transaction_id:tx.id,memo:'최종 입력',version:0}]);
 assert.equal(store.state(tx).status,'saved');assert.equal(store.hasUnsaved(),false);
});

test('typing during save is preserved, serialized using the new version, and awaited by flush',async t=>{
 const tx=transaction(),first=deferred<NoteWriteResult>(),second=deferred<NoteWriteResult>(),writes:NoteWrite[]=[];
 const store=createMerchantNoteStore([],input=>{writes.push(input);return writes.length===1?first.promise:second.promise;});t.after(()=>store.dispose());
 store.change(tx,'먼저 쓴 메모');const saving=store.save(tx);assert.equal(store.save(tx),saving);await turn();
 store.change(tx,'저장 중 추가한 내용');let flushed=false;const flushing=store.flush().then(()=>{flushed=true;});
 first.resolve({note:note(tx,'먼저 쓴 메모',1)});await turn();
 assert.equal(store.state(tx).text,'저장 중 추가한 내용');assert.equal(flushed,false);
 assert.deepEqual(writes.map(({memo,version})=>({memo,version})),[{memo:'먼저 쓴 메모',version:0},{memo:'저장 중 추가한 내용',version:1}]);
 second.resolve({note:note(tx,'저장 중 추가한 내용',2)});await flushing;
 assert.equal(store.state(tx).version,2);assert.equal(store.hasUnsaved(),false);
});

test('independent merchants flush concurrently while each merchant uses one request',async t=>{
 const a=transaction(),b=transaction('two'),aResult=deferred<NoteWriteResult>(),bResult=deferred<NoteWriteResult>(),writes:NoteWrite[]=[];
 const store=createMerchantNoteStore([],input=>{writes.push(input);return input.transaction_id===a.id?aResult.promise:bResult.promise;});t.after(()=>store.dispose());
 store.change(a,'첫 거래처');store.change(b,'둘째 거래처');const flushing=store.flush();await turn();
 assert.equal(writes.length,2);
 aResult.resolve({note:note(a,'첫 거래처',1)});bResult.resolve({note:note(b,'둘째 거래처',1)});await flushing;
 assert.equal(store.hasUnsaved(),false);
});

test('network failure preserves newer typing and blocks navigation until retry succeeds',async t=>{
 const tx=transaction(),response=deferred<NoteWriteResult>();let attempts=0;
 const store=createMerchantNoteStore([],input=>++attempts===1?response.promise:Promise.resolve({note:note(tx,input.memo,1)}));t.after(()=>store.dispose());
 store.change(tx,'전송한 내용');const saving=store.save(tx);await turn();store.change(tx,'최신 초안');
 const rejected=assert.rejects(saving,/offline/);response.reject(Error('offline'));await rejected;
 assert.equal(store.state(tx).text,'최신 초안');assert.equal(store.state(tx).status,'error');assert.equal(store.hasUnsaved(),true);
 await store.flush();assert.equal(store.state(tx).text,'최신 초안');assert.equal(store.state(tx).status,'saved');
});

test('an uncertain failed write still retries when the user reverted to the original text',async t=>{
 const tx=transaction(),response=deferred<NoteWriteResult>(),writes:NoteWrite[]=[];
 const store=createMerchantNoteStore([note(tx,'원래 메모',1)],input=>{writes.push(input);return writes.length===1?response.promise:Promise.resolve({note:note(tx,input.memo,2)});});t.after(()=>store.dispose());
 store.change(tx,'수정 요청');const saving=store.save(tx);await turn();store.change(tx,'원래 메모');
 const rejected=assert.rejects(saving);response.reject(Error('offline'));await rejected;
 assert.equal(store.hasUnsaved(),true);await store.flush();
 assert.deepEqual(writes[1],{transaction_id:tx.id,memo:'원래 메모',version:1});
});

test('version conflicts keep the latest draft and require an explicit choice',async t=>{
 const tx=transaction(),response=deferred<NoteWriteResult>(),current=note(tx,'다른 관리자 메모',3),writes:NoteWrite[]=[];
 const store=createMerchantNoteStore([note(tx,'기존 메모',1)],input=>{writes.push(input);return writes.length===1?response.promise:Promise.resolve({note:note(tx,input.memo,4)});});t.after(()=>store.dispose());
 store.change(tx,'초안');const saving=store.save(tx);await turn();store.change(tx,'최신 초안');
 const rejected=assert.rejects(saving,/다른 관리자/);response.resolve({error:'다른 관리자 변경',current});await rejected;
 assert.equal(store.state(tx).text,'최신 초안');await assert.rejects(store.flush(),/변경된 메모/);assert.equal(writes.length,1);
 store.acceptCurrent(tx,true);await store.flush();assert.equal(writes[1].version,3);assert.equal(store.state(tx).text,'최신 초안');
});

test('refresh cannot roll back a confirmed save, and clean editors receive newer shared notes',async t=>{
 const tx=transaction();const store=createMerchantNoteStore([note(tx,'처음',1)],async input=>({note:note(tx,input.memo,2)}));t.after(()=>store.dispose());
 store.change(tx,'저장한 최신 내용');await store.flush();store.hydrate([note(tx,'오래된 읽기',1)]);
 assert.equal(store.state(tx).text,'저장한 최신 내용');assert.equal(store.savedNotes()[0].version,2);
 store.hydrate([note(tx,'다른 관리자의 후속 변경',3)]);assert.equal(store.state(tx).text,'다른 관리자의 후속 변경');
 store.change(tx,'작성 중 초안');store.hydrate([note(tx,'공동 메모 4',4)]);assert.equal(store.state(tx).text,'작성 중 초안');assert.equal(store.state(tx).version,3);
});

test('a newer shared note observed during a write is not overwritten by its late response',async t=>{
 const tx=transaction(),response=deferred<NoteWriteResult>();
 const store=createMerchantNoteStore([note(tx,'처음',1)],()=>response.promise);t.after(()=>store.dispose());
 store.change(tx,'전송 내용');const saving=store.save(tx);await turn();store.change(tx,'추가 초안');store.hydrate([note(tx,'다른 관리자 최신',3)]);
 const rejected=assert.rejects(saving,/다른 관리자/);response.resolve({note:note(tx,'전송 내용',2)});await rejected;
 assert.equal(store.state(tx).text,'추가 초안');assert.equal(store.state(tx).current?.version,3);assert.equal(store.savedNotes()[0].version,3);
 store.acceptCurrent(tx,false);assert.equal(store.state(tx).text,'다른 관리자 최신');assert.equal(store.hasUnsaved(),false);
});

test('clearing a memo keeps the confirmed empty value for the saved-note library',async t=>{
 const tx=transaction();const store=createMerchantNoteStore([note(tx,'지울 메모',1)],async input=>({note:note(tx,input.memo,2)}));t.after(()=>store.dispose());
 store.change(tx,'');await store.flush();assert.equal(store.savedNotes()[0].memo,'');assert.equal(store.state(tx).version,2);
});
