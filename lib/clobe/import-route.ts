import type {ClobeReadSession} from './mcp';
import {clobeReadApiError} from './read';
import {ClobeImportError} from './import-security';
import {ClobeSyncSourceError} from './import-sync-error';
import {applyClobeImport,applyClobeSync,parseClobeImportInput,prepareClobeSync,previewClobeImport,readClobeImportSettings,type ClobeImportDependencies} from './import-service';

export const clobeImportHeaders={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const REQUEST_LIMIT=2*1024*1024;
async function inputBody(request:Request){
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||Number(request.headers.get('content-length'))>REQUEST_LIMIT||!request.body)throw new ClobeImportError('invalid_request');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{
  while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>REQUEST_LIMIT){await reader.cancel();throw new ClobeImportError('too_large');}chunks.push(part.value);}
  return parseClobeImportInput(JSON.parse(Buffer.concat(chunks).toString('utf8')));
 }catch(error){if(error instanceof ClobeImportError)throw error;throw new ClobeImportError('invalid_request');}finally{reader.releaseLock();}
}
export function clobeImportApiError(error:unknown){
 if(!(error instanceof ClobeImportError))return clobeReadApiError(error);
 const status=error.code==='stale'||error.code==='expired'?409:error.code==='too_large'?413:error.code==='configuration'?503:error.code==='storage'?502:error.code==='incomplete'?504:400;
 return Response.json({error:error.message,...(error instanceof ClobeSyncSourceError?{skipped:error.skipped,configured_account_count:error.configured_account_count}:{})},{status,headers:clobeImportHeaders});
}
type RouteDependencies={getOrigin:()=>string;authenticate:()=>Promise<{makeDependencies:(getSession:()=>Promise<ClobeReadSession>)=>ClobeImportDependencies;openSession:(signal:AbortSignal)=>Promise<ClobeReadSession>}>};
export function clobeImportHandlers(deps:RouteDependencies){
 return {
  GET:async()=>{
   try{const auth=await deps.authenticate();return Response.json(await readClobeImportSettings(auth.makeDependencies(async()=>{throw new ClobeImportError('invalid_request');})),{headers:clobeImportHeaders});}catch(error){return clobeImportApiError(error);}
  },
  POST:async(request:Request)=>{
   let session:ClobeReadSession|undefined;
   try{
    if(request.headers.get('origin')!==deps.getOrigin())throw new ClobeImportError('invalid_request');
    const input=await inputBody(request),auth=await deps.authenticate();
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(50000)]);
    const getSession=async()=>{session??=await auth.openSession(signal);return session;};
    const dependencies=auth.makeDependencies(getSession);
    const result=input.action==='preview'?await previewClobeImport(input,dependencies):input.action==='apply'?await applyClobeImport(input,dependencies):input.action==='sync_prepare'?await prepareClobeSync(input,dependencies):await applyClobeSync(input,dependencies);
    return Response.json(result,{headers:clobeImportHeaders});
   }catch(error){return clobeImportApiError(error);}finally{await session?.close();}
  },
 };
}
