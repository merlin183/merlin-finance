import {noteKey,noteSubject} from './merchant-notes';
import type {MerchantNote,Transaction} from './types';

export type NoteDraft={text:string;base:string;version:number;transaction:Transaction;status:'editing'|'saving'|'saved'|'error';error?:string;current?:MerchantNote};
export type NoteWrite={transaction_id:string;memo:string;version:number};
export type NoteWriteResult={note?:MerchantNote;current?:MerchantNote;error?:string};
type Writer=(input:NoteWrite)=>Promise<NoteWriteResult>;

/** Per-merchant snapshots keep typing out of the full finance workspace render. */
export function createMerchantNoteStore(initial:MerchantNote[],writeNote:Writer,delay=800){
 const saved=new Map(initial.map(note=>[noteKey(note),note]));
 const drafts=new Map<string,NoteDraft>(),listeners=new Map<string,Set<()=>void>>();
 const pending=new Map<string,Promise<void>>(),timers=new Map<string,ReturnType<typeof setTimeout>>();
 const keyFor=(transaction:Transaction)=>noteKey(noteSubject(transaction));
 const needsSave=(draft:NoteDraft)=>draft.text!==draft.base||draft.status==='error'||Boolean(draft.current);
 function publish(key:string,draft:NoteDraft){drafts.set(key,draft);listeners.get(key)?.forEach(listener=>listener());}
 function clearTimer(key:string){const timer=timers.get(key);if(timer!==undefined)clearTimeout(timer);timers.delete(key);}
 function state(transaction:Transaction):NoteDraft{
  const key=keyFor(transaction),existing=drafts.get(key);
  if(existing)return existing;
  const note=saved.get(key),draft:NoteDraft={text:note?.memo||'',base:note?.memo||'',version:note?.version||0,transaction,status:'saved'};
  drafts.set(key,draft);return draft;
 }
 function change(transaction:Transaction,text:string){
  const key=keyFor(transaction),draft=state(transaction);
  publish(key,{...draft,text,transaction,status:draft.current||draft.status==='error'?'error':pending.has(key)?'saving':'editing',error:draft.status==='error'?draft.error:undefined});
  clearTimer(key);
  if(!draft.current)timers.set(key,setTimeout(()=>{timers.delete(key);void save(transaction).catch(()=>{});},delay));
 }
 function save(transaction:Transaction):Promise<void>{
  const key=keyFor(transaction);clearTimer(key);
  const running=pending.get(key);if(running)return running;
  const draft=drafts.get(key);if(!draft||!needsSave(draft))return Promise.resolve();
  if(draft.current)return Promise.reject(Error('변경된 메모를 확인해주세요.'));
  // Schedule the writer after registering its promise, including synchronous failures.
  const task=Promise.resolve().then(async()=>{
   let latest=drafts.get(key)!;
   while(needsSave(latest)){
    if(latest.current)throw Error('변경된 메모를 확인해주세요.');
    const sent=latest;
    publish(key,{...sent,status:'saving',error:undefined});
    let result:NoteWriteResult;
    try{result=await writeNote({transaction_id:sent.transaction.id,memo:sent.text,version:sent.version});}
    catch(error){
     publish(key,{...drafts.get(key)!,status:'error',error:'연결을 확인하고 다시 저장해주세요.'});
     clearTimer(key);throw error;
    }
    latest=drafts.get(key)!;
    if(!result.note){
     const message=result.error||'메모 저장에 실패했습니다.';
     publish(key,{...latest,status:'error',error:message,current:result.current});
     clearTimer(key);throw Error(message);
    }
    const note=result.note,observed=saved.get(key);
    if(observed&&observed.version>note.version){
     if(latest.text===sent.text){
      publish(key,{...latest,text:observed.memo,base:observed.memo,version:observed.version,status:'saved',current:undefined,error:undefined});
      clearTimer(key);return;
     }
     const message='다른 관리자가 메모를 수정했습니다. 최신 메모를 확인한 뒤 저장해주세요.';
     publish(key,{...latest,base:note.memo,version:note.version,status:'error',error:message,current:observed});
     clearTimer(key);throw Error(message);
    }
    saved.set(key,note);
    // A response only confirms the submitted text. Never replace newer typing.
    const text=latest.text===sent.text?note.memo:latest.text;
    latest={...latest,text,base:note.memo,version:note.version,status:text===note.memo?'saved':'editing',current:undefined,error:undefined};
    publish(key,latest);
    clearTimer(key);
    // If typing continued during the request, save it against the returned version.
   }
  }).finally(()=>{pending.delete(key);});
  pending.set(key,task);return task;
 }
 async function flush(){
  // A blur may already have started a write; all callers share that request and
  // its queued edits. Recheck after waiting so navigation never leaves a draft.
  for(;;){
   const tasks=[...pending.values()];
   for(const [key,draft] of drafts)if(needsSave(draft)&&!pending.has(key))tasks.push(save(draft.transaction));
   if(!tasks.length)return;
   await Promise.all(tasks);
  }
 }
 function acceptCurrent(transaction:Transaction,keepDraft:boolean){
  const key=keyFor(transaction),draft=drafts.get(key);if(!draft?.current)return;
  const latest=draft.current;saved.set(key,latest);clearTimer(key);
  publish(key,{...draft,text:keepDraft?draft.text:latest.memo,base:latest.memo,version:latest.version,current:undefined,error:undefined,status:keepDraft?'editing':'saved'});
 }
 function hydrate(notes:MerchantNote[]){
  for(const note of notes){
   const key=noteKey(note),previous=saved.get(key);
   // A read started before a save can arrive afterward. Never roll it back.
   if(previous&&previous.version>=note.version)continue;
   saved.set(key,note);
   const draft=drafts.get(key);
   if(draft&&!needsSave(draft)&&!pending.has(key))publish(key,{...draft,text:note.memo,base:note.memo,version:note.version,status:'saved',current:undefined,error:undefined});
  }
 }
 function subscribe(transaction:Transaction,listener:()=>void){
  const key=keyFor(transaction),subscribers=listeners.get(key)||new Set<()=>void>();
  listeners.set(key,subscribers);subscribers.add(listener);
  return()=>{subscribers.delete(listener);if(!subscribers.size)listeners.delete(key);};
 }
 return {state,change,save,flush,acceptCurrent,hydrate,subscribe,
  savedNotes:()=>[...saved.values()],
  hasUnsaved:()=>pending.size>0||[...drafts.values()].some(needsSave),
  dispose:()=>{for(const key of timers.keys())clearTimer(key);},
 };
}
export type MerchantNoteStore=ReturnType<typeof createMerchantNoteStore>;
