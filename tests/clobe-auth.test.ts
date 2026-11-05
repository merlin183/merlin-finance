import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {ClobeAuthError,CLOBE_RESOURCE,assertClobeOrigin,clobeAuthorizationUrl,clobeConfig,decodeClobeAttempt,decryptClobeClient,decryptClobeTokens,encryptClobe,exchangeClobeCode,newClobeAttempt,registerClobeClient,type ClobeFetch,type ClobeTokens} from '../lib/clobe/auth';
import {beginClobeConnection,finishClobeConnection,getClobeAccessToken,publicClobeStatus,type ClobeConnectionRecord} from '../lib/clobe/connection';

const owner='10000000-0000-4000-8000-000000000001';
const admin='10000000-0000-4000-8000-000000000002';
const env:NodeJS.ProcessEnv={NODE_ENV:'test',CLOBE_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),CLOBE_OAUTH_REDIRECT_URL:'https://finance.example.test/api/clobe/callback'};
const config=clobeConfig(env);
const now=Date.parse('2026-10-07T00:00:00.000Z');
const client={clientId:'synthetic-client',redirectUrl:config.redirectUrl};
const tokens:ClobeTokens={accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:new Date(now+1000).toISOString(),scope:'mcp offline_access'};
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function record():ClobeConnectionRecord{return {version:2,client_ciphertext:encryptClobe(client,config.key,owner,'client'),token_ciphertext:encryptClobe(tokens,config.key,owner,'tokens'),connected_at:new Date(now-10000).toISOString(),token_expires_at:tokens.expiresAt,updated_at:new Date(now).toISOString(),last_error:null,lease_expires_at:null};}
function memoryStore(initial=record()){
 let value=initial,lease:string|null=null,attempt:string|null=null;
 const calls:{action:string;payload:Record<string,unknown>}[]=[];
 let failTokenSave=false;
 const db={rpc:async(_name:string,{p_action:action,p_payload:payload}:{p_action:string;p_payload:Record<string,unknown>})=>{
  calls.push({action,payload});
  if(action==='read')return {data:{...value},error:null};
  if(action==='begin'){attempt=String(payload.attempt_id);return {data:{...value},error:null};}
  if(action==='consume'){
   if(attempt!==payload.attempt_id||!attempt)return {data:null,error:{message:'CLOBE_ATTEMPT_INVALID'}};
   attempt=null;lease=String(payload.lease_id);return {data:{...value},error:null};
  }
  if(action==='claim'||action==='claim_refresh'){
   if(lease||value.version!==payload.version)return {data:null,error:{message:'CLOBE_BUSY'}};
   lease=String(payload.lease_id);value={...value,lease_expires_at:new Date(now+90000).toISOString(),last_error:action==='claim_refresh'?'refresh_uncertain':value.last_error};
   return {data:{...value},error:null};
  }
  if(lease!==payload.lease_id)return {data:null,error:{message:'CLOBE_STALE'}};
  if(action==='release'){lease=null;value={...value,last_error:(payload.error||value.last_error) as ClobeConnectionRecord['last_error'],lease_expires_at:null};return {data:{...value},error:null};}
  if(action==='tokens'&&failTokenSave)return {data:null,error:{message:'storage unavailable'}};
  if(action==='tokens'){value={...value,token_ciphertext:String(payload.ciphertext),token_expires_at:String(payload.expires_at),version:value.version+1,last_error:null,lease_expires_at:null};lease=null;}
  if(action==='client'){value={...value,client_ciphertext:String(payload.ciphertext),version:value.version+1,lease_expires_at:null};lease=null;}
  return {data:{...value},error:null};
 }} as unknown as SupabaseClient;
 return {db,calls,value:()=>value,setFailTokenSave:()=>{failTokenSave=true;}};
}

test('Clobe config requires a 256-bit server key and fixed callback; supports explicit local HTTP only in development',()=>{
 assert.equal(config.origin,'https://finance.example.test');
 const overrides:Partial<NodeJS.ProcessEnv>[]=[{CLOBE_TOKEN_ENCRYPTION_KEY:'bad'},{CLOBE_OAUTH_REDIRECT_URL:'https://finance.example.test/upload'},{CLOBE_OAUTH_REDIRECT_URL:'https://finance.example.test/api/clobe/callback?returnTo=https://evil.test'},{CLOBE_OAUTH_REDIRECT_URL:'https://user:pass@finance.example.test/api/clobe/callback'},{NODE_ENV:'production',CLOBE_OAUTH_REDIRECT_URL:'http://localhost:3000/api/clobe/callback'}];
 for(const override of overrides)assert.throws(()=>clobeConfig({...env,...override}),ClobeAuthError);
 assert.equal(clobeConfig({...env,CLOBE_OAUTH_REDIRECT_URL:'http://localhost:3000/api/clobe/callback'}).secure,false);
});

test('connect rejects missing/cross-site Origin even when request Host or forwarded headers claim a trusted host',()=>{
 assert.doesNotThrow(()=>assertClobeOrigin(new Request('https://finance.example.test/api/clobe/connect',{method:'POST',headers:{origin:config.origin}}),config.origin));
 const rejectedHeaders:Record<string,string>[]=[{host:'finance.example.test'},{origin:'https://attacker.example.test',host:'finance.example.test','x-forwarded-host':'finance.example.test'},{origin:'null'}];
 for(const headers of rejectedHeaders)assert.throws(()=>assertClobeOrigin(new Request('https://finance.example.test/api/clobe/connect',{method:'POST',headers}),config.origin),ClobeAuthError);
});

test('AES-GCM ciphertext cannot be moved between workspace, purpose, key or modified envelopes',()=>{
 const encrypted=encryptClobe(tokens,config.key,owner,'tokens');
 assert.ok(!encrypted.includes(tokens.accessToken)&&!encrypted.includes(tokens.refreshToken));
 assert.deepEqual(decryptClobeTokens(encrypted,config.key,owner),tokens);
 assert.throws(()=>decryptClobeTokens(encrypted,config.key,admin),ClobeAuthError);
 assert.throws(()=>decryptClobeTokens(encrypted,Buffer.alloc(32,8),owner),ClobeAuthError);
 assert.throws(()=>decryptClobeClient(encrypted,config.key,owner),ClobeAuthError);
 const parts=encrypted.split('.');parts[2]=Buffer.alloc(16,0).toString('base64url');
 assert.throws(()=>decryptClobeTokens(parts.join('.'),config.key,owner),ClobeAuthError);
});

test('PKCE state binds user/workspace/expiry and uses S256 and only configured resource',()=>{
 const attempt=newClobeAttempt(owner,admin,config.redirectUrl,randomUUID(),now);
 const cookie=encryptClobe(attempt,config.key,owner,'attempt');
 assert.deepEqual(decodeClobeAttempt(cookie,config.key,owner,admin,attempt.state,now+100),attempt);
 for(const [workspace,user,state,time] of [[admin,admin,attempt.state,now],[owner,owner,attempt.state,now],[owner,admin,'x'.repeat(43),now],[owner,admin,attempt.state,attempt.expiresAt]] as const)assert.throws(()=>decodeClobeAttempt(cookie,config.key,workspace,user,state,time),ClobeAuthError);
 const url=new URL(clobeAuthorizationUrl(client,attempt));
 assert.equal(url.origin,'https://api.clobe.ai');assert.equal(url.pathname,'/oauth/authorize');
 assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(attempt.verifier).digest('base64url'));
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('scope'),'mcp offline_access');assert.equal(url.searchParams.get('resource'),CLOBE_RESOURCE);
});

test('DCR uses its own dashboard public client and fixed callback, no Codex credentials',async()=>{
 const fetcher:ClobeFetch=async(url,init)=>{
  assert.equal(String(url),'https://api.clobe.ai/oauth/register');assert.equal(init?.redirect,'error');
  const payload=JSON.parse(String(init?.body));
  assert.equal(payload.client_name,'Merlin Finance Dashboard');assert.equal(payload.token_endpoint_auth_method,'none');assert.deepEqual(payload.redirect_uris,[config.redirectUrl]);assert.ok(!('client_secret' in payload));
  return reply({client_id:'synthetic-new-client',redirect_uris:[config.redirectUrl],token_endpoint_auth_method:'none'});
 };
 assert.equal((await registerClobeClient(config.redirectUrl,fetcher)).clientId,'synthetic-new-client');
 await assert.rejects(()=>registerClobeClient(config.redirectUrl,async()=>reply({client_id:'unexpected',client_secret:'synthetic-secret',redirect_uris:[config.redirectUrl]})),ClobeAuthError);
});

test('code exchange sends verifier/resource and provider error details never enter exceptions',async()=>{
 const attempt=newClobeAttempt(owner,admin,config.redirectUrl,randomUUID(),now);
 const fetcher:ClobeFetch=async(url,init)=>{
  assert.equal(String(url),'https://api.clobe.ai/oauth/token');
  const body=new URLSearchParams(String(init?.body));assert.equal(body.get('code_verifier'),attempt.verifier);assert.equal(body.get('resource'),CLOBE_RESOURCE);assert.equal(body.get('redirect_uri'),config.redirectUrl);
  return reply({access_token:'synthetic-issued',refresh_token:'synthetic-issued-refresh',token_type:'Bearer',expires_in:3600,scope:'mcp offline_access'});
 };
 const issued=await exchangeClobeCode(client,attempt,'synthetic-code',fetcher,now);assert.equal(issued.expiresAt,new Date(now+3600000).toISOString());
 await assert.rejects(()=>exchangeClobeCode(client,attempt,'synthetic-code',async()=>reply({error:'invalid_grant',error_description:'synthetic-private-error'},400)),error=>error instanceof ClobeAuthError&&error.code==='reconnect_required'&&!error.message.includes('synthetic-private-error'));
 await assert.rejects(()=>exchangeClobeCode(client,attempt,'synthetic-code',async()=>reply({access_token:'secret',refresh_token:'secret',expires_in:3600,token_type:'mac'})),ClobeAuthError);
});

test('OAuth client registration is persisted once; callback consumes the attempt before token exchange',async()=>{
 const value=record();value.client_ciphertext=null;value.token_ciphertext=null;value.version=0;value.token_expires_at=null;
 const store=memoryStore(value);let registrations=0,exchanges=0;
 const fetcher:ClobeFetch=async(url)=>String(url).endsWith('/register')?(registrations++,reply({client_id:client.clientId,redirect_uris:[config.redirectUrl]})):(exchanges++,reply({access_token:'synthetic-issued',refresh_token:'synthetic-refresh',token_type:'Bearer',expires_in:3600}));
 const options={env,now:()=>now,fetcher};
 const first=await beginClobeConnection(store.db,owner,admin,options);
 const second=await beginClobeConnection(store.db,owner,admin,options);assert.equal(registrations,1);
 const firstState=new URL(first.authorizationUrl).searchParams.get('state')!;
 await assert.rejects(()=>finishClobeConnection(store.db,owner,admin,first.cookie,firstState,'code',options),ClobeAuthError);
 assert.equal(exchanges,0);
 const state=new URL(second.authorizationUrl).searchParams.get('state')!;
 assert.equal((await finishClobeConnection(store.db,owner,admin,second.cookie,state,'code',options)).connected,true);
 await assert.rejects(()=>finishClobeConnection(store.db,owner,admin,second.cookie,state,'code',options),ClobeAuthError);assert.equal(exchanges,1);
});

test('refresh persists an uncertainty marker before sending one request and commits rotated encrypted tokens',async()=>{
 const store=memoryStore();let calls=0;
 const fetcher:ClobeFetch=async(_url,init)=>{
  calls++;assert.equal(store.value().last_error,'refresh_uncertain');
  assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'),tokens.refreshToken);
  await assert.rejects(()=>getClobeAccessToken(store.db,owner,{env,now:()=>now,fetcher}),ClobeAuthError);
  return reply({access_token:'synthetic-rotated-access',refresh_token:'synthetic-rotated-refresh',token_type:'Bearer',expires_in:3600});
 };
 assert.equal(await getClobeAccessToken(store.db,owner,{env,now:()=>now,fetcher}),'synthetic-rotated-access');assert.equal(calls,1);assert.equal(store.value().last_error,null);
 assert.equal(decryptClobeTokens(store.value().token_ciphertext!,config.key,owner).refreshToken,'synthetic-rotated-refresh');
 assert.equal(await getClobeAccessToken(store.db,owner,{env,now:()=>now,fetcher}),'synthetic-rotated-access');assert.equal(calls,1);
});

test('lost refresh response or token save fails closed without replaying an old rotating token',async()=>{
 for(const failSave of [false,true]){
  const store=memoryStore();if(failSave)store.setFailTokenSave();let calls=0;
  const fetcher:ClobeFetch=async()=>{calls++;if(!failSave)throw Error('synthetic-network-secret');return reply({access_token:'synthetic-rotated',refresh_token:'synthetic-rotated',token_type:'Bearer',expires_in:3600});};
  await assert.rejects(()=>getClobeAccessToken(store.db,owner,{env,now:()=>now,fetcher}),error=>error instanceof ClobeAuthError&&error.code==='refresh_uncertain');
  await assert.rejects(()=>getClobeAccessToken(store.db,owner,{env,now:()=>now,fetcher}),ClobeAuthError);assert.equal(calls,1);
 }
});

test('public connection status omits ciphertext, token, client, owner and pending lease identities',()=>{
 const value=record(),status=publicClobeStatus(value,true,now);
 assert.equal(status.connected,true);assert.equal(status.accountLabel,null);
 const json=JSON.stringify(status);for(const secret of [value.client_ciphertext!,value.token_ciphertext!,tokens.accessToken,tokens.refreshToken,owner,client.clientId])assert.ok(!json.includes(secret));
 assert.equal(publicClobeStatus({...value,last_error:'refresh_uncertain',lease_expires_at:new Date(now+1000).toISOString()},true,now).state,'refreshing');
 assert.equal(publicClobeStatus({...value,last_error:'refresh_uncertain'},true,now).state,'reconnect_required');
});
