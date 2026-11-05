// Server-only preview encryption and the database's server-origin proof.
import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import {clobeConfig} from './auth';

export const CLOBE_PREVIEW_TTL=2*60*60*1000;
export const CLOBE_SNAPSHOT_BYTES=6*1024*1024;
export class ClobeImportError extends Error{
 constructor(public readonly code:'invalid_request'|'stale'|'storage'|'too_large'|'configuration'|'expired'|'incomplete',message?:string){
  super(message||{invalid_request:'Clobe 거래와 계좌 연결·계정과목 선택을 확인해주세요.',stale:'기존 거래나 연결 정보가 변경되었습니다. 거래를 다시 불러와 분류한 뒤 적용해주세요.',storage:'Clobe 가져오기 내용을 저장하지 못했습니다. 같은 적용을 다시 시도해주세요.',too_large:'한 번에 가져올 수 있는 거래 수 또는 자료 크기를 초과했습니다. 조회 기간을 나누어주세요.',configuration:'Clobe 거래 가져오기 환경설정을 확인해주세요.',expired:'분류 확인 시간이 지났습니다. 거래를 다시 불러와주세요.',incomplete:'모든 통장 거래를 조회하지 못했습니다. 기존 거래는 변경하지 않았습니다.'}[code]);
 }
}
export function clobeImportSigningKey(env:NodeJS.ProcessEnv=process.env){
 const value=env.CLOBE_IMPORT_SIGNING_KEY||'';
 if(typeof window!=='undefined'||!/^[A-Za-z0-9+/]{43}=$/.test(value)||Buffer.from(value,'base64').length!==32)throw new ClobeImportError('configuration');
 return Buffer.from(value,'base64');
}
export function signClobeImport(action:string,payload:string,userId:string,ownerId:string,key=clobeImportSigningKey()){
 return createHmac('sha256',key).update(`merlin:clobe-import:v1\n${action}\n${userId}\n${ownerId}\n${payload}`).digest('hex');
}
const aad=(id:string,userId:string,ownerId:string)=>Buffer.from(`merlin:clobe-import:preview:v1:${ownerId}:${userId}:${id}`);
export function sealClobePreview(value:unknown,id:string,userId:string,ownerId:string,key=clobeConfig().key){
 const plain=JSON.stringify(value);if(Buffer.byteLength(plain)>CLOBE_SNAPSHOT_BYTES)throw new ClobeImportError('too_large');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(id,userId,ownerId));
 const encrypted=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]);
 return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
}
export function openClobePreview(ciphertext:string,id:string,userId:string,ownerId:string,key=clobeConfig().key):unknown{
 try{
  if(ciphertext.length>8*1024*1024)throw Error();
  const [version,iv,tag,body,...extra]=ciphertext.split('.');
  if(version!=='v1'||extra.length||![iv,tag,body].every(v=>v&&/^[A-Za-z0-9_-]+$/.test(v)))throw Error();
  const ivBytes=Buffer.from(iv,'base64url'),tagBytes=Buffer.from(tag,'base64url');if(ivBytes.length!==12||tagBytes.length!==16)throw Error();
  const cipher=createDecipheriv('aes-256-gcm',key,ivBytes);cipher.setAAD(aad(id,userId,ownerId));cipher.setAuthTag(tagBytes);
  const raw=Buffer.concat([cipher.update(Buffer.from(body,'base64url')),cipher.final()]);if(raw.length>CLOBE_SNAPSHOT_BYTES)throw Error();
  return JSON.parse(raw.toString('utf8'));
 }catch{throw new ClobeImportError('invalid_request');}
}
