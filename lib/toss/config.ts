import {z} from 'zod';
import type {TossMerchant} from './types';

export class TossError extends Error{
 constructor(public readonly code:'configuration'|'provider_auth'|'provider_access'|'provider'|'incomplete'|'invalid_request'|'storage'|'busy'|'scope'){
  super({configuration:'토스 정산 API 연결 설정이 필요합니다.',provider_auth:'토스 상점의 라이브 API 키와 조회 권한을 확인해주세요.',provider_access:'토스 API 키 접근 정책이 서버 호출을 차단했습니다. 토스 개발자센터에서 호출 서버의 IP·국가와 허용 범위를 확인해주세요. 저장된 자료는 유지했습니다.',provider:'토스 정산 자료를 조회하지 못했습니다. 저장된 자료는 유지했습니다.',incomplete:'토스 정산 자료를 모두 확인하지 못해 이번 동기화를 반영하지 않았습니다.',invalid_request:'토스 정산 동기화 요청을 확인해주세요.',storage:'토스 정산 자료를 저장하지 못했습니다. 기존 자료는 유지했습니다.',busy:'토스 정산 동기화가 진행 중이거나 방금 실행되었습니다. 잠시 후 다시 시도해주세요.',scope:'토스 상점의 사업자·입금 계좌 연결을 확인해주세요.'}[code]);
 }
}
export type TossServerMerchant=TossMerchant&{secretKey:string};
const mapSchema=z.array(z.object({merchantId:z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),businessId:z.string().uuid(),accountId:z.string().uuid(),label:z.string().min(1).max(100),secretKeyEnv:z.string().regex(/^TOSS_[A-Z0-9_]+$/).default('TOSS_SECRET_KEY')}).strict()).min(1).max(20);
export function tossMerchants(env:Readonly<Record<string,string|undefined>>=process.env):TossServerMerchant[]{
 if(typeof window!=='undefined')throw new TossError('configuration');
 const raw=env.TOSS_SETTLEMENT_MERCHANTS;
 if(!raw)return [];
 try{
  const maps=mapSchema.parse(JSON.parse(raw));
  if(new Set(maps.map(row=>row.merchantId)).size!==maps.length)throw Error();
  return maps.map(({secretKeyEnv,...mapping})=>{
   const secretKey=env[secretKeyEnv]??'';
   if(!/^live_(?:g)?sk_[A-Za-z0-9_-]+$/.test(secretKey)||secretKey.length>512)throw Error();
   return {...mapping,secretKey};
  });
 }catch{throw new TossError('configuration');}
}
export function publicTossMerchants(rows:readonly TossServerMerchant[]):TossMerchant[]{return rows.map(({merchantId,businessId,accountId,label})=>({merchantId,businessId,accountId,label}));}
