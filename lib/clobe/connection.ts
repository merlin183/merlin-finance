// Contains encrypted connection storage and server-only token access, not finance data.
import type {SupabaseClient} from '@supabase/supabase-js';
import {randomUUID} from 'node:crypto';
import {ClobeAuthError,clobeAuthorizationUrl,clobeConfig,decodeClobeAttempt,decryptClobeClient,decryptClobeTokens,encryptClobe,exchangeClobeCode,newClobeAttempt,refreshClobeTokens,registerClobeClient,type ClobeFetch} from './auth';

export type ClobeConnectionRecord={version:number;client_ciphertext:string|null;token_ciphertext:string|null;connected_at:string|null;token_expires_at:string|null;updated_at:string|null;last_error:'reconnect_required'|'refresh_uncertain'|'request_failed'|null;lease_expires_at:string|null};
export type ClobeConnectionStatus={configured:boolean;connected:boolean;state:'not_configured'|'not_connected'|'connected'|'refreshing'|'connecting'|'reconnect_required';accountLabel:null;connectedAt:string|null;expiresAt:string|null;updatedAt:string|null;error:string|null};
type Options={fetcher?:ClobeFetch;now?:()=>number;env?:NodeJS.ProcessEnv};

export async function clobeAuthStore(db:SupabaseClient,action:string,payload:Record<string,unknown>={}):Promise<ClobeConnectionRecord>{
 const {data,error}=await db.rpc('fd_clobe_auth',{p_action:action,p_payload:payload});
 if(error){
  if(error.message?.includes('ADMIN_REQUIRED'))throw Error('ADMIN_REQUIRED');
  if(error.message?.includes('CLOBE_BUSY')||error.message?.includes('CLOBE_STALE'))throw new ClobeAuthError('busy');
  if(error.message?.includes('CLOBE_ATTEMPT_INVALID'))throw new ClobeAuthError('invalid_state');
  throw new ClobeAuthError('storage_failed');
 }
 if(!data||typeof data.version!=='number'||!Number.isSafeInteger(data.version))throw new ClobeAuthError('storage_failed');
 return data as ClobeConnectionRecord;
}
export function publicClobeStatus(record:ClobeConnectionRecord,configured=true,now=Date.now()):ClobeConnectionStatus{
 const activeLease=!!record.lease_expires_at&&Date.parse(record.lease_expires_at)>now;
 const unsafe=record.last_error==='reconnect_required'||record.last_error==='refresh_uncertain';
 const connected=!!record.token_ciphertext&&!unsafe;
 const state=!configured?'not_configured':activeLease?(record.last_error==='refresh_uncertain'?'refreshing':'connecting'):unsafe?'reconnect_required':connected?'connected':'not_connected';
 return {configured,connected:configured&&connected,state,accountLabel:null,connectedAt:record.connected_at,expiresAt:record.token_expires_at,updatedAt:record.updated_at,error:record.last_error?new ClobeAuthError(record.last_error).message:null};
}
export async function getClobeConnectionStatus(db:SupabaseClient,options:Options={}){
 let configured=true;try{clobeConfig(options.env);}catch{configured=false;}
 return publicClobeStatus(await clobeAuthStore(db,'read'),configured,options.now?.());
}
async function release(db:SupabaseClient,leaseId:string,error?:ClobeConnectionRecord['last_error']){
 await clobeAuthStore(db,'release',{lease_id:leaseId,error:error||null});
}

export async function beginClobeConnection(db:SupabaseClient,ownerId:string,userId:string,options:Options={}){
 const config=clobeConfig(options.env),now=options.now?.()??Date.now();
 let record=await clobeAuthStore(db,'read');
 if(!record.client_ciphertext){
  const leaseId=randomUUID();record=await clobeAuthStore(db,'claim',{version:record.version,lease_id:leaseId});
  try{
   // A second caller may have registered since the initial read; the CAS rejects it.
   const client=await registerClobeClient(config.redirectUrl,options.fetcher);
   record=await clobeAuthStore(db,'client',{version:record.version,lease_id:leaseId,ciphertext:encryptClobe(client,config.key,ownerId,'client')});
  }catch(error){await release(db,leaseId).catch(()=>{});throw error;}
 }
 const client=decryptClobeClient(record.client_ciphertext!,config.key,ownerId);
 // Redirect changes need a separately registered client; do not silently reuse one.
 if(client.redirectUrl!==config.redirectUrl)throw new ClobeAuthError('configuration');
 const attempt=newClobeAttempt(ownerId,userId,config.redirectUrl,randomUUID(),now);
 await clobeAuthStore(db,'begin',{attempt_id:attempt.id});
 return {authorizationUrl:clobeAuthorizationUrl(client,attempt),cookie:encryptClobe(attempt,config.key,ownerId,'attempt'),secure:config.secure};
}

export async function finishClobeConnection(db:SupabaseClient,ownerId:string,userId:string,cookie:string,state:string,code:string,options:Options={}){
 const config=clobeConfig(options.env),now=options.now?.()??Date.now();
 const attempt=decodeClobeAttempt(cookie,config.key,ownerId,userId,state,now);
 if(attempt.redirectUrl!==config.redirectUrl||!code||code.length>4096)throw new ClobeAuthError('invalid_state');
 const leaseId=randomUUID();
 const record=await clobeAuthStore(db,'consume',{attempt_id:attempt.id,lease_id:leaseId});
 try{
  if(!record.client_ciphertext)throw new ClobeAuthError('invalid_state');
  const client=decryptClobeClient(record.client_ciphertext,config.key,ownerId);
  if(client.redirectUrl!==attempt.redirectUrl)throw new ClobeAuthError('invalid_state');
  const tokens=await exchangeClobeCode(client,attempt,code,options.fetcher,now);
  const saved=await clobeAuthStore(db,'tokens',{version:record.version,lease_id:leaseId,ciphertext:encryptClobe(tokens,config.key,ownerId,'tokens'),expires_at:tokens.expiresAt});
  return publicClobeStatus(saved,true,now);
 }catch(error){await release(db,leaseId).catch(()=>{});throw error;}
}

export async function getClobeAccessToken(db:SupabaseClient,ownerId:string,options:Options={}):Promise<string>{
 const config=clobeConfig(options.env),clock=options.now??Date.now;
 let record=await clobeAuthStore(db,'read');
 if(record.last_error==='refresh_uncertain')throw new ClobeAuthError(record.lease_expires_at&&Date.parse(record.lease_expires_at)>clock()?'busy':'refresh_uncertain');
 if(record.last_error==='reconnect_required')throw new ClobeAuthError('reconnect_required');
 if(!record.token_ciphertext||!record.client_ciphertext)throw new ClobeAuthError('not_connected');
 const tokens=decryptClobeTokens(record.token_ciphertext,config.key,ownerId);
 if(Date.parse(tokens.expiresAt)>clock()+60000)return tokens.accessToken;
 const leaseId=randomUUID();record=await clobeAuthStore(db,'claim_refresh',{version:record.version,lease_id:leaseId});
 try{
  const client=decryptClobeClient(record.client_ciphertext!,config.key,ownerId);
  const currentTokens=decryptClobeTokens(record.token_ciphertext!,config.key,ownerId);
  const next=await refreshClobeTokens(client,currentTokens,options.fetcher,clock());
  await clobeAuthStore(db,'tokens',{version:record.version,lease_id:leaseId,ciphertext:encryptClobe(next,config.key,ownerId,'tokens'),expires_at:next.expiresAt});
  return next.accessToken;
 }catch(error){
  // Refresh may rotate remotely before a timeout/save failure. Never retry an old
  // refresh token automatically: the durable marker forces a fresh consent flow.
  const failure=error instanceof ClobeAuthError&&error.code==='reconnect_required'?'reconnect_required':'refresh_uncertain';
  await release(db,leaseId,failure).catch(()=>{});
  throw new ClobeAuthError(failure);
 }
}
