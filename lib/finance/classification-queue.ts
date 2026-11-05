import type {ReviewGroup,ReviewSelection} from './classification-review';

export type ClassificationSubmission={groups:ReviewGroup[];selections:ReviewSelection[]};
export type ClassificationQueueEntry=ClassificationSubmission&{id:number;error?:string};
export type ClassificationQueueSnapshot={pending:ClassificationQueueEntry[];failed:ClassificationQueueEntry[]};

/** Kept by the workspace so requests and retry choices survive page changes. */
export function createClassificationQueue(){
 let sequence=0,snapshot:ClassificationQueueSnapshot={pending:[],failed:[]};
 const listeners=new Set<()=>void>(),tasks=new Map<number,Promise<boolean>>(),claimed=new Set<string>();
 function publish(next:ClassificationQueueSnapshot){snapshot=next;listeners.forEach(listener=>listener());}
 function run(submission:ClassificationSubmission,task:()=>Promise<void>):Promise<boolean>{
  const ids=submission.selections.flatMap(selection=>selection.transactions.map(transaction=>transaction.id));
  if(!ids.length||ids.some(id=>claimed.has(id)))return Promise.resolve(false);
  for(const id of ids)claimed.add(id);
  const submittedIds=new Set(ids),entry:ClassificationQueueEntry={...submission,id:++sequence};
  const remainingFailures=snapshot.failed.flatMap(failed=>{
   const selections=failed.selections.filter(selection=>!selection.transactions.some(transaction=>submittedIds.has(transaction.id)));
   const keys=new Set(selections.map(selection=>selection.key));
   return selections.length?[{...failed,selections,groups:failed.groups.filter(group=>keys.has(group.key))}]:[];
  });
  const pending=Promise.resolve().then(task).then(()=>{
   publish({...snapshot,pending:snapshot.pending.filter(item=>item.id!==entry.id)});return true;
  },cause=>{
   const error=cause instanceof Error?cause.message:'분류를 저장하지 못했습니다. 다시 적용해주세요.';
   publish({pending:snapshot.pending.filter(item=>item.id!==entry.id),failed:[...snapshot.failed,{...entry,error}]});
   throw cause;
  }).finally(()=>{for(const id of ids)claimed.delete(id);tasks.delete(entry.id);});
  // Acquire rows and register the task before notifying React, so a second
  // click or navigation from a subscriber cannot miss an in-flight request.
  tasks.set(entry.id,pending);publish({pending:[...snapshot.pending,entry],failed:remainingFailures});return pending;
 }
 async function flush(){
  // New independent submissions can start while an earlier save is awaited.
  while(tasks.size)await Promise.all([...tasks.values()]);
 }
 return {run,flush,
  getSnapshot:()=>snapshot,
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  hasPending:()=>tasks.size>0,
 };
}
export type ClassificationQueue=ReturnType<typeof createClassificationQueue>;

export function pendingClassificationIds(snapshot:ClassificationQueueSnapshot){return new Set(snapshot.pending.flatMap(entry=>entry.selections.flatMap(selection=>selection.transactions.map(transaction=>transaction.id))));}
export function failedClassificationChoices(snapshot:ClassificationQueueSnapshot){return new Map(snapshot.failed.flatMap(entry=>entry.selections.map(selection=>[selection.key,selection.category_id] as const)));}
