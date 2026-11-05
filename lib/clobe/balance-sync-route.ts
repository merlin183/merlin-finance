import type {ClobeReadSession} from './mcp';
import {clobeReadApiError} from './read';
import {syncClobeBalances,type ClobeBalanceDependencies} from './balance-sync';

export const clobeBalanceSyncHeaders={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
type Dependencies={getOrigin:()=>string;authenticate:()=>Promise<{openSession:(signal:AbortSignal)=>Promise<ClobeReadSession>;makeDependencies:(getSession:()=>Promise<ClobeReadSession>)=>ClobeBalanceDependencies}>};
async function emptyBody(request:Request){
 // The browser can request a sync, never submit financial source values,
 // owner IDs, mappings, dates, tool names or connection credentials.
 if(!request.body)return;
 if(Number(request.headers.get('content-length'))>128)throw Error('CLOBE_BALANCE_INVALID_REQUEST');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{while(true){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>128){await reader.cancel();throw Error('CLOBE_BALANCE_INVALID_REQUEST');}chunks.push(next.value);}
  // NextRequest may expose a readable stream for a zero-byte POST without
  // Content-Type. Determine emptiness from bounded bytes, not stream presence.
  const body=Buffer.concat(chunks).toString('utf8').trim();
  if(!body)return;
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||body!=='{}')throw Error('CLOBE_BALANCE_INVALID_REQUEST');
 }finally{reader.releaseLock();}
}
export function clobeBalanceSyncHandler(deps:Dependencies){
 return async(request:Request)=>{
  let session:ClobeReadSession|undefined;
  try{
   if(request.headers.get('origin')!==deps.getOrigin())throw Error('CLOBE_BALANCE_INVALID_REQUEST');
   await emptyBody(request);
   const signal=AbortSignal.any([request.signal,AbortSignal.timeout(50000)]);
   const auth=await deps.authenticate(),getSession=async()=>session??=await auth.openSession(signal),dependencies=auth.makeDependencies(getSession);
   if(dependencies.planActuals)dependencies.planActuals.signal=signal;
   return Response.json(await syncClobeBalances(dependencies),{headers:clobeBalanceSyncHeaders});
  }catch(error){
   const message=error instanceof Error?error.message:'';
   if(message.startsWith('CLOBE_BALANCE_')){
    const status=message==='CLOBE_BALANCE_INVALID_REQUEST'?400:message==='CLOBE_BALANCE_SCOPE'?409:message==='CLOBE_BALANCE_CONFIGURATION'?503:502;
    return Response.json({error:status===400?'Clobe 최신 동기화 요청을 확인해주세요.':status===409?'Clobe 통장 연결이 변경되었습니다. 계좌 연결을 다시 확인해주세요.':status===503?'Clobe 잔액 동기화 환경설정을 확인해주세요.':'Clobe 계좌 잔액을 저장하지 못했습니다. 기존 거래와 잔액은 유지했습니다.'},{status,headers:clobeBalanceSyncHeaders});
   }
   return clobeReadApiError(error);
  }finally{await session?.close();}
 };
}
