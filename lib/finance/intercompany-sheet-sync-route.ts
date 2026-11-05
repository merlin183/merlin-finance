import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {intercompanyRegisterSchema,intercompanyEntrySchema,type IntercompanyBaseline,type IntercompanyEntry,type IntercompanyRegisterData} from './intercompany-register';
import {parseIntercompanySheetSource,type IntercompanySheetRaw,type IntercompanySheetSource,type IntercompanyIdentifierWrite} from './intercompany-sheet-source';
import {assertIntercompanySourceIdentities,planIntercompanySheetSync,IntercompanySyncConflict,type IntercompanySourceUpdate} from './intercompany-sheet-sync-plan';
import {IntercompanySheetError} from './intercompany-sheet';

type Db=Pick<SupabaseClient,'rpc'>;
type Dependencies={
 authenticate:()=>Promise<{db:Db}>;
 readSource:(baseline:IntercompanyBaseline)=>Promise<IntercompanySheetRaw>;
 stampIdentifiers:(baseline:IntercompanyBaseline,raw:IntercompanySheetRaw,writes:IntercompanyIdentifierWrite[])=>Promise<IntercompanySheetRaw>;
 reconcileSource:(baseline:IntercompanyBaseline,raw:IntercompanySheetRaw,updates:IntercompanySourceUpdate[])=>Promise<IntercompanySheetRaw>;
 normalizeFormulas:(baseline:IntercompanyBaseline,raw:IntercompanySheetRaw,source:IntercompanySheetSource,linkedIds:Set<string>)=>Promise<IntercompanySheetRaw>;
 syncEntry:(baseline:IntercompanyBaseline,entry:IntercompanyEntry,options?:{expectedPreviousRow?:(string|number)[]})=>Promise<void>;
 newId?:()=>string;
};
const headers={'Cache-Control':'no-store'};
const claimSchema=z.object({token:z.string().uuid(),revision:z.number().int().min(0),baseline_hash:z.string().min(1).max(200),native_hash:z.string().min(1).max(200),register:intercompanyRegisterSchema}).strict();
const rowClaimSchema=z.object({entry:intercompanyEntrySchema,token:z.string().uuid(),lease_version:z.number().int().min(1),previous_row:z.array(z.union([z.string(),z.number()])).length(9).nullable().optional()}).strict();
const failure=(error:string,status:number,row:number|null=null)=>Response.json({error,...(row===null?{}:{row})},{status,headers});
class SyncRpcError extends Error{}
const rpcError=(message:string)=>{
 if(/ADMIN_REQUIRED|UNAUTHORIZED/.test(message))return failure('초대된 관리자만 동기화할 수 있습니다.',403);
 if(/SYNC_BUSY|LEASE_BUSY/.test(message))return failure('다른 저장이나 시트 동기화가 진행 중입니다. 잠시 후 다시 눌러주세요.',409);
 if(/STALE|CONFLICT|HASH|REVISION|LEASE|KEY|LINK|IDENTITY/.test(message))return failure('동기화 중 공동 기록이 변경됐거나 연결이 다릅니다. 원본 연동ID를 확인하고 다시 눌러주세요.',409);
 return failure('시트 동기화 저장 결과를 확인하지 못했습니다. 같은 원본으로 다시 눌러 확인해주세요.',500);
};

/** Explicit, same-origin admin POST only. Never accepts a client-provided source, owner or money. */
export function intercompanySheetSyncHandlers(deps:Dependencies){
 return {POST:async(request:Request)=>{
  let db:Db|undefined,token:string|undefined;
  try{
   ({db}=await deps.authenticate());
   const origin=request.headers.get('origin');
   if(!origin||new URL(origin).origin!==new URL(request.url).origin)return failure('허용되지 않은 요청입니다.',403);
   if(Number(request.headers.get('content-length'))>1024)return failure('요청이 너무 큽니다.',413);
   const text=await request.text();if(new TextEncoder().encode(text).length>1024)return failure('요청이 너무 큽니다.',413);
   let body:unknown;try{body=JSON.parse(text);}catch{return failure('동기화 요청을 확인해주세요.',400);}
   if(!z.object({}).strict().safeParse(body).success)return failure('동기화할 원본은 서버에 등록된 시트만 사용할 수 있습니다.',400);
   const id=(deps.newId??randomUUID)();
   const invoke=async(name:string,args?:Record<string,unknown>)=>{const result=await db!.rpc(name,args);if(result.error)throw new SyncRpcError(result.error.message);return result.data as unknown;};
   const claim=claimSchema.parse(await invoke('fd_begin_intercompany_sheet_sync',{p_id:id}));token=claim.token;
   const register=claim.register,baseline=register.baseline;
   if(!baseline)throw new IntercompanySyncConflict('원본 대여금 기준 자료를 먼저 연결해주세요.');
   const renew=async()=>{const latest=claimSchema.parse(await invoke('fd_begin_intercompany_sheet_sync',{p_id:id}));if(latest.token!==token)throw new SyncRpcError('INTERCOMPANY_SYNC_LEASE_STALE');};
   let raw=await deps.readSource(baseline),source=parseIntercompanySheetSource(raw,baseline);
   assertIntercompanySourceIdentities(register,source,raw);
   await renew();
   if(source.identifierWrites.length){raw=await deps.stampIdentifiers(baseline,raw,source.identifierWrites);source=parseIntercompanySheetSource(raw,baseline);}
   let plan=planIntercompanySheetSync(register,source,raw);
   const reconciledRows=new Set(plan.sourceUpdates.map(r=>r.row));
   if(plan.sourceUpdates.length){await renew();raw=await deps.reconcileSource(baseline,raw,plan.sourceUpdates);source=parseIntercompanySheetSource(raw,baseline);plan=planIntercompanySheetSync(register,source,raw,{reconciledRows});}
   await renew();
   raw=await deps.normalizeFormulas(baseline,raw,source,new Set([...register.entries.map(e=>e.id),...source.mirrorRows.map(r=>r.id)]));
   source=parseIntercompanySheetSource(raw,baseline);plan=planIntercompanySheetSync(register,source,raw,{reconciledRows});
   const finalRead=await deps.readSource(baseline);
   if(finalRead.fingerprint!==raw.fingerprint)throw new IntercompanySyncConflict('반영 직전 시트가 다시 수정됐습니다. 최신 원본으로 다시 눌러주세요.');
   await renew();
   const applied=await invoke('fd_apply_intercompany_sheet_sync',{p_token:token,p_expected_revision:claim.revision,p_expected_baseline_hash:claim.baseline_hash,p_expected_native_hash:claim.native_hash,p_snapshot:plan.snapshot,p_amendments:plan.amendments});
   const saved=intercompanyRegisterSchema.parse(z.object({register:intercompanyRegisterSchema}).passthrough().parse(applied).register);
   let latest:IntercompanyRegisterData=saved,warning='';
   // Independent fixed rows may finish concurrently. Limit each batch and renew the workspace lease.
   const pending=saved.entries.filter(e=>e.sheet_status!=='synced').slice(0,20);
   for(let offset=0;offset<pending.length;offset+=3){
    await renew();
    await Promise.allSettled(pending.slice(offset,offset+3).map(async entry=>{
     const value=await invoke('fd_claim_intercompany_sheet_for_sync',{p_id:entry.id,p_sync_token:token});
     if(value===null)return;
     const item=rowClaimSchema.parse(value);
     if(item.entry.id!==entry.id||item.entry.version!==item.lease_version)throw new SyncRpcError('INTERCOMPANY_STALE');
     let success=false;
     try{await deps.syncEntry(baseline,item.entry,item.previous_row?{expectedPreviousRow:item.previous_row}:undefined);success=true;}catch{/* Do not expose provider bodies or credentials. */}
     await invoke('fd_finish_intercompany_sheet',{p_id:entry.id,p_token:item.token,p_version:item.lease_version,p_success:success,p_error:success?'':'기록 탭 반영 결과를 확인하지 못했습니다. 같은 기록으로 다시 시도해주세요.'});
    })).then(results=>{if(results.some(r=>r.status==='rejected'))warning='대시보드 반영은 완료됐으나 일부 기록 탭의 상태를 확인하지 못했습니다. 다시 동기화하거나 개별 시트 재시도를 눌러주세요.';});
   }
   try{latest=intercompanyRegisterSchema.parse(await invoke('fd_read_intercompany_register'));}catch{warning='대시보드에는 반영했습니다. 최신 상태를 다시 조회한 뒤 기록 탭 반영 여부를 확인해주세요.';}
   if(latest.entries.some(e=>e.sheet_status!=='synced'))warning='시트에서 가져온 내용은 대시보드에 반영됐으며 일부 기록 탭 갱신은 대기 중입니다. 같은 버튼 또는 개별 시트 재시도로 확인해주세요.';
   return Response.json({register:latest,summary:{...plan.summary,syncedAt:latest.sheet_sync?.synced_at??''},...(warning?{sheetWarning:warning}:{})},{headers});
  }catch(error){
   if(error instanceof IntercompanySyncConflict)return failure(error.message,409,error.row);
   if(error instanceof IntercompanySheetError)return failure(error.message,409);
   if(error instanceof SyncRpcError)return rpcError(error.message);
   if(error instanceof Error&&error.message==='UNAUTHORIZED')return failure('로그인이 필요합니다.',401);
   if(error instanceof Error&&error.message==='ADMIN_REQUIRED')return failure('초대된 관리자만 동기화할 수 있습니다.',403);
   return failure('시트 동기화 결과를 확인하지 못했습니다. 연동ID를 유지한 채 다시 눌러 확인해주세요.',502);
  }finally{
   if(db&&token)try{await db.rpc('fd_end_intercompany_sheet_sync',{p_token:token});}catch{/* Bounded lease expires if release acknowledgement is unavailable. */}
  }
 }};
}
