import {randomUUID} from 'node:crypto';
import {publicTossMerchants,TossError,type TossServerMerchant} from './config';
import {readTossSettlements,tossSyncRange} from './client';
import type {TossStore} from './store';
import type {TossSettlementResponse} from './types';

const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
type Dependencies={authenticate:()=>Promise<TossStore>;merchants:()=>TossServerMerchant[];origin:()=>string;now?:()=>number;fetcher?:typeof fetch};
function activeResponse(saved:Awaited<ReturnType<TossStore['read']>>,merchants:TossServerMerchant[]):TossSettlementResponse{
 const active=new Map(merchants.map(row=>[row.merchantId,row]));
 return {...saved,configured:merchants.length>0,merchants:publicTossMerchants(merchants),settlements:saved.settlements.filter(row=>{const m=active.get(row.merchant_id);return m?.businessId===row.business_id&&m?.accountId===row.account_id;})};
}
async function emptyBody(request:Request){
 if(Number(request.headers.get('content-length'))>128)throw new TossError('invalid_request');
 if(!request.body)return;
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>128){await reader.cancel();throw new TossError('invalid_request');}chunks.push(part.value);}
  const body=Buffer.concat(chunks).toString('utf8').trim();
  if(body&&(body!=='{}'||request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'))throw new TossError('invalid_request');
 }finally{reader.releaseLock();}
}
export function tossApiError(error:unknown){
 if(error instanceof Error&&error.message==='UNAUTHORIZED')return Response.json({error:'로그인이 필요합니다.'},{status:401,headers});
 if(error instanceof Error&&error.message==='ADMIN_REQUIRED')return Response.json({error:'초대된 관리자만 정산 자료에 접근할 수 있습니다.'},{status:403,headers});
 const known=error instanceof TossError?error:new TossError('storage');
 const status=known.code==='invalid_request'?400:known.code==='busy'||known.code==='scope'?409:known.code==='configuration'?503:502;
 return Response.json({error:known.message},{status,headers});
}
export function tossSettlementHandlers(deps:Dependencies){
 return {
  GET:async()=>{try{
   const store=await deps.authenticate(),merchants=deps.merchants(),saved=await store.read();
   const answer=activeResponse(saved,merchants);
   return Response.json(answer,{headers});
  }catch(error){return tossApiError(error);}},
  POST:async(request:Request)=>{
   let store:TossStore|undefined,run:string|undefined,issuedAt:string|undefined,claimed=false;
   try{
    if(request.headers.get('origin')!==deps.origin()||new URL(request.url).search)throw new TossError('invalid_request');
    await emptyBody(request);
    store=await deps.authenticate();const merchants=deps.merchants();if(!merchants.length)throw new TossError('configuration');
    const now=deps.now??Date.now,range=tossSyncRange(now());run=randomUUID();issuedAt=new Date(now()).toISOString();
    await store.claim(run,issuedAt);claimed=true;
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(240000)]);
    const settlements=await readTossSettlements(merchants,range,signal,now,deps.fetcher);
    const sync=await store.save({run_id:run,issued_at:issuedAt,...range,merchants:publicTossMerchants(merchants),settlements});claimed=false;
    const saved=await store.read();return Response.json({...activeResponse(saved,merchants),sync} satisfies TossSettlementResponse,{headers});
   }catch(error){return tossApiError(error);}
   finally{if(claimed&&store&&run&&issuedAt)try{await store.release(run,issuedAt);}catch{/* A bounded lease expires; never echo storage/provider details. */}}
  },
 };
}
