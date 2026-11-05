export const DATASET_READ_LOCK_NAME='finance-dataset-read-v1';
export type DatasetReadLockManager={request<T>(name:string,options:{mode:'exclusive'},callback:()=>Promise<T>):Promise<T>};
const securityError=(error:unknown)=>!!error&&typeof error==='object'&&'name' in error&&error.name==='SecurityError';

/** Same-origin documents serialize reads without sharing financial responses,
 * account identities or credentials. The callback checks its current session.
 * Native Web Locks release on either completion or rejection, including timeout. */
export async function withDatasetReadLock<T>(read:()=>Promise<T>,locks?:DatasetReadLockManager|null):Promise<T>{
 let manager=locks;
 if(manager===undefined){
  try{manager=typeof navigator==='undefined'?null:navigator.locks??null;}
  catch(error){if(securityError(error))return read();throw error;}
 }
 if(!manager)return read();
 let entered=false;
 try{return await manager.request(DATASET_READ_LOCK_NAME,{mode:'exclusive'},async()=>{entered=true;return read();});}
 catch(error){
  // A policy may deny acquiring Web Locks. A failed read is never rerun here.
  if(!entered&&securityError(error))return read();
  throw error;
 }
}
