// Server-only OAuth primitives. Never import this module from a client component.
import {createCipheriv,createDecipheriv,createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';

export const CLOBE_RESOURCE='https://api.clobe.ai/mcp';
export const CLOBE_ISSUER='https://api.clobe.ai';
export const CLOBE_SCOPE='mcp offline_access';
export const CLOBE_ATTEMPT_COOKIE='merlin_clobe_oauth';
export const CLOBE_ATTEMPT_TTL_SECONDS=600;
export type ClobeFetch=typeof fetch;

const clientSchema=z.object({clientId:z.string().min(1).max(512),redirectUrl:z.string().url()}).strict();
const tokenSchema=z.object({accessToken:z.string().min(1).max(8192),refreshToken:z.string().min(1).max(8192),expiresAt:z.string().datetime(),scope:z.string().max(200)}).strict();
const attemptSchema=z.object({state:z.string().regex(/^[A-Za-z0-9_-]{43}$/),verifier:z.string().regex(/^[A-Za-z0-9_-]{43}$/),id:z.string().uuid(),userId:z.string().uuid(),ownerId:z.string().uuid(),redirectUrl:z.string().url(),expiresAt:z.number().int()}).strict();
export type ClobeClient=z.infer<typeof clientSchema>;
export type ClobeTokens=z.infer<typeof tokenSchema>;
export type ClobeAttempt=z.infer<typeof attemptSchema>;

export class ClobeAuthError extends Error {
 constructor(public readonly code:'configuration'|'busy'|'not_connected'|'invalid_state'|'request_failed'|'reconnect_required'|'refresh_uncertain'|'storage_failed'){
  super({configuration:'Clobe 연결 환경설정을 확인해주세요.',busy:'다른 관리자가 Clobe 연결을 처리 중입니다. 잠시 후 다시 시도하세요.',not_connected:'Clobe 계정을 먼저 연결해주세요.',invalid_state:'Clobe 승인 시간이 지났거나 요청이 일치하지 않습니다. 다시 연결해주세요.',request_failed:'Clobe 인증 요청을 완료하지 못했습니다. 다시 연결해주세요.',reconnect_required:'Clobe 인증이 만료되었습니다. 계정을 다시 연결해주세요.',refresh_uncertain:'Clobe 인증 갱신 결과를 확인할 수 없습니다. 안전하게 계정을 다시 연결해주세요.',storage_failed:'Clobe 연결 상태를 저장하지 못했습니다. 다시 확인해주세요.'}[code]);
 }
}

export function clobeConfig(env:NodeJS.ProcessEnv=process.env){
 if(typeof window!=='undefined')throw new ClobeAuthError('configuration');
 const raw=env.CLOBE_TOKEN_ENCRYPTION_KEY||'';
 if(!/^[A-Za-z0-9+/]{43}=$/.test(raw))throw new ClobeAuthError('configuration');
 const key=Buffer.from(raw,'base64');
 if(key.length!==32||key.toString('base64')!==raw)throw new ClobeAuthError('configuration');
 let redirect:URL;
 try{redirect=new URL(env.CLOBE_OAUTH_REDIRECT_URL||'');}catch{throw new ClobeAuthError('configuration');}
 const local=env.NODE_ENV!=='production'&&redirect.protocol==='http:'&&['localhost','127.0.0.1'].includes(redirect.hostname);
 if((redirect.protocol!=='https:'&&!local)||redirect.pathname!=='/api/clobe/callback'||redirect.search||redirect.hash||redirect.username||redirect.password)throw new ClobeAuthError('configuration');
 return {key,redirectUrl:redirect.href,origin:redirect.origin,secure:redirect.protocol==='https:'};
}

export function assertClobeOrigin(request:Request,origin:string){
 if(request.headers.get('origin')!==origin)throw new ClobeAuthError('invalid_state');
}

export function encryptClobe(value:unknown,key:Buffer,ownerId:string,purpose:'client'|'tokens'|'attempt'){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 cipher.setAAD(Buffer.from(`merlin:clobe:v1:${ownerId}:${purpose}`));
 const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
 return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
}

function decryptClobe(ciphertext:string,key:Buffer,ownerId:string,purpose:'client'|'tokens'|'attempt'):unknown{
 try{
  if(ciphertext.length>32000)throw Error();
  const [version,iv,tag,data,...extra]=ciphertext.split('.');
  if(version!=='v1'||extra.length||!iv||!tag||!data||![iv,tag,data].every(part=>/^[A-Za-z0-9_-]+$/.test(part)))throw Error();
  const ivBytes=Buffer.from(iv,'base64url'),tagBytes=Buffer.from(tag,'base64url');
  if(ivBytes.length!==12||tagBytes.length!==16)throw Error();
  const decipher=createDecipheriv('aes-256-gcm',key,ivBytes);
  decipher.setAAD(Buffer.from(`merlin:clobe:v1:${ownerId}:${purpose}`));decipher.setAuthTag(tagBytes);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8'));
 }catch{throw new ClobeAuthError(purpose==='attempt'?'invalid_state':'reconnect_required');}
}
export function decryptClobeClient(value:string,key:Buffer,ownerId:string):ClobeClient{
 try{return clientSchema.parse(decryptClobe(value,key,ownerId,'client'));}catch{throw new ClobeAuthError('reconnect_required');}
}
export function decryptClobeTokens(value:string,key:Buffer,ownerId:string):ClobeTokens{
 try{return tokenSchema.parse(decryptClobe(value,key,ownerId,'tokens'));}catch{throw new ClobeAuthError('reconnect_required');}
}
export function decodeClobeAttempt(value:string,key:Buffer,ownerId:string,userId:string,state:string,now=Date.now()){
 try{
  const attempt=attemptSchema.parse(decryptClobe(value,key,ownerId,'attempt'));
  const received=Buffer.from(state),expected=Buffer.from(attempt.state);
  if(received.length!==expected.length||!timingSafeEqual(received,expected)||attempt.ownerId!==ownerId||attempt.userId!==userId||attempt.expiresAt<=now||attempt.expiresAt>now+CLOBE_ATTEMPT_TTL_SECONDS*1000)throw Error();
  return attempt;
 }catch{throw new ClobeAuthError('invalid_state');}
}
export function newClobeAttempt(ownerId:string,userId:string,redirectUrl:string,id:string,now=Date.now()):ClobeAttempt{
 return {ownerId,userId,redirectUrl,id,state:randomBytes(32).toString('base64url'),verifier:randomBytes(32).toString('base64url'),expiresAt:now+CLOBE_ATTEMPT_TTL_SECONDS*1000};
}
export function clobeAuthorizationUrl(client:ClobeClient,attempt:ClobeAttempt){
 const url=new URL('/oauth/authorize',CLOBE_ISSUER);
 url.search=new URLSearchParams({response_type:'code',client_id:client.clientId,redirect_uri:client.redirectUrl,state:attempt.state,code_challenge:createHash('sha256').update(attempt.verifier).digest('base64url'),code_challenge_method:'S256',scope:CLOBE_SCOPE,resource:CLOBE_RESOURCE}).toString();
 return url.href;
}

async function oauthJson(path:'/oauth/register'|'/oauth/token',init:RequestInit,fetcher:ClobeFetch){
 let response:Response;
 try{response=await fetcher(new URL(path,CLOBE_ISSUER),{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new ClobeAuthError('request_failed');}
 // No provider payloads, descriptions, access tokens or URLs enter application errors.
 if(!response.ok){
  let invalidGrant=false;
  try{const data:unknown=await response.json();invalidGrant=!!data&&typeof data==='object'&&'error' in data&&data.error==='invalid_grant';}catch{}
  throw new ClobeAuthError(invalidGrant?'reconnect_required':'request_failed');
 }
 try{
  const text=await response.text();if(text.length>24000)throw Error();
  const data:unknown=JSON.parse(text);
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error();
  return data as Record<string,unknown>;
 }catch{throw new ClobeAuthError('request_failed');}
}
export async function registerClobeClient(redirectUrl:string,fetcher:ClobeFetch=fetch):Promise<ClobeClient>{
 const data=await oauthJson('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({client_name:'Merlin Finance Dashboard',redirect_uris:[redirectUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:CLOBE_SCOPE})},fetcher);
 if(typeof data.client_id!=='string'||!data.client_id||data.client_id.length>512||data.client_secret||(data.token_endpoint_auth_method&&data.token_endpoint_auth_method!=='none')||!Array.isArray(data.redirect_uris)||!data.redirect_uris.includes(redirectUrl))throw new ClobeAuthError('request_failed');
 return {clientId:data.client_id,redirectUrl};
}
async function requestTokens(params:Record<string,string>,priorRefresh:string|undefined,now:number,fetcher:ClobeFetch):Promise<ClobeTokens>{
 const data=await oauthJson('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({...params,resource:CLOBE_RESOURCE})},fetcher);
 const accessToken=data.access_token,refreshToken=data.refresh_token??priorRefresh,seconds=data.expires_in;
 const scope=typeof data.scope==='string'?data.scope:CLOBE_SCOPE;
 if(typeof accessToken!=='string'||!accessToken||accessToken.length>8192||typeof refreshToken!=='string'||!refreshToken||refreshToken.length>8192||typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<=0||seconds>31536000||typeof data.token_type!=='string'||data.token_type.toLowerCase()!=='bearer'||!scope.split(/\s+/).includes('mcp'))throw new ClobeAuthError('request_failed');
 return {accessToken,refreshToken,expiresAt:new Date(now+Math.floor(seconds*1000)).toISOString(),scope};
}
export const exchangeClobeCode=(client:ClobeClient,attempt:ClobeAttempt,code:string,fetcher:ClobeFetch=fetch,now=Date.now())=>requestTokens({grant_type:'authorization_code',client_id:client.clientId,redirect_uri:client.redirectUrl,code,code_verifier:attempt.verifier},undefined,now,fetcher);
export const refreshClobeTokens=(client:ClobeClient,tokens:ClobeTokens,fetcher:ClobeFetch=fetch,now=Date.now())=>requestTokens({grant_type:'refresh_token',client_id:client.clientId,refresh_token:tokens.refreshToken},tokens.refreshToken,now,fetcher);
