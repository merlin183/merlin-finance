import {createClient} from '@supabase/supabase-js';
import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {authenticated,apiError,assertSameOrigin,publicConfig} from '@/lib/supabase/server';
import {runSheetSync,SheetSyncError,syncErrorMessage,type SyncRpc} from '@/lib/finance/sheet-sync';

export const runtime='nodejs';
export const maxDuration=60;
const headers={'Cache-Control':'no-store'};
export async function GET(){
 try{
  const {db}=await authenticated();
  const {data,error}=await db.rpc('fd_sheet_sync_status');
  if(error)throw Error('자동 연동 상태를 읽지 못했습니다. 잠시 후 다시 확인해주세요.');
  const sources=(data||[]).map((source:Record<string,unknown>)=>({...source,id:source.source_id,last_error:syncErrorMessage(source.last_error as string|null)}));
  return Response.json({sources,configured:!!process.env.FINANCE_SHEET_SYNC_TOKEN&&sources.length>0},{headers});
 }catch(error){return apiError(error);}
}
export async function POST(request:Request){
 try{
  const expected=process.env.FINANCE_SHEET_SYNC_TOKEN||'';
  const authorization=request.headers.get('authorization');
  let dryRun=false;
  if(authorization!==null){
   const supplied=authorization.startsWith('Bearer ')?authorization.slice(7):'';
   if(!/^[a-f0-9]{64}$/.test(expected)||!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))
    return Response.json({error:'동기화 인증이 필요합니다.'},{status:401,headers});
   // The scheduler may only trigger this registered source. Caller-supplied
   // URLs, rows, mappings and owner IDs are never accepted.
   if(request.headers.get('content-length')&&Number(request.headers.get('content-length'))>1000)return Response.json({error:'요청이 너무 큽니다.'},{status:413,headers});
   const raw=await request.text();
   if(raw.length>1000)return Response.json({error:'요청이 너무 큽니다.'},{status:413,headers});
   const input=z.object({action:z.enum(['run','preview']).optional()}).strict().parse(raw?JSON.parse(raw):{});
   dryRun=input.action==='preview';
  }else{
   assertSameOrigin(request);
   await authenticated();
   z.object({action:z.literal('run')}).strict().parse(await request.json());
  }
  if(!/^[a-f0-9]{64}$/.test(expected))throw new SheetSyncError('SHEET_SYNC_NOT_CONFIGURED');
  const config=publicConfig();
  if(!config.url||!config.key)throw new SheetSyncError('SHEET_SYNC_NOT_CONFIGURED');
  const db=createClient(config.url,config.key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const rpc:SyncRpc=(name,args)=>db.rpc(name,args);
  return Response.json({result:await runSheetSync({token:expected,rpc,dryRun,force:authorization===null})},{headers});
 }catch(error){
  if(error instanceof SheetSyncError)return Response.json({error:syncErrorMessage(error.code)},{status:503,headers});
  return apiError(error);
 }
}
