import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {intercompanyChangeSchema,intercompanyEntrySchema,intercompanyRegisterSchema,type IntercompanyBaseline,type IntercompanyEntry,type IntercompanyRegisterData} from './intercompany-register';

type Dependencies={authenticate:()=>Promise<{db:Pick<SupabaseClient,'rpc'>}>,syncEntry:(baseline:IntercompanyBaseline,entry:IntercompanyEntry,options?:{expectedPreviousRow?: (string|number)[]})=>Promise<void>};
const headers={'Cache-Control':'no-store'};
const fail=(error:string,status:number)=>Response.json({error},{status,headers});
const claimSchema=z.object({entry:intercompanyEntrySchema,token:z.string().uuid(),lease_version:z.number().int().min(1),previous_row:z.array(z.union([z.string(),z.number()])).length(9).nullable().optional()}).strict();
const syncSchema=z.object({action:z.literal('sync'),id:z.string().uuid()}).strict();
const rpcFailure=(message:string)=>{
 if(message.includes('INTERCOMPANY_SHEET_SYNC_BUSY'))return fail('시트 동기화가 진행 중입니다. 완료된 뒤 다시 저장해주세요.',409);
 if(message.includes('ADMIN_REQUIRED')||message.includes('UNAUTHORIZED'))return fail('초대된 관리자만 공동 재무자료에 접근할 수 있습니다.',403);
 if(message.includes('INTERCOMPANY_STALE')||message.includes('INTERCOMPANY_ID_CONFLICT'))return fail('이 기록이 변경되었거나 같은 식별자로 다른 내용이 저장되었습니다. 입력 내용은 유지됩니다. 최신 기록을 확인해주세요.',409);
 if(message.includes('INTERCOMPANY_BASELINE_PERIOD'))return fail('원본 시트 집계에 포함된 기간입니다. 기준일 다음 날부터 새 자금 이동을 기록해주세요.',400);
 if(message.includes('INTERCOMPANY_FUTURE_DATE'))return fail('미래 날짜를 실제 자금 이동으로 기록할 수 없습니다.',400);
 if(message.includes('INTERCOMPANY_BASELINE_REQUIRED'))return fail('원본 대여금 기준 자료를 먼저 연결해주세요.',409);
 if(message.includes('INTERCOMPANY_SHEET_FULL'))return fail('연결된 시트의 기록 공간이 가득 찼습니다. 시트 기록 범위를 확장한 뒤 다시 저장해주세요.',409);
 if(message.includes('INTERCOMPANY_PARTY_REQUIRED')||message.includes('INVALID_INTERCOMPANY_CHANGE'))return fail('보낸 사업자·받은 사업자·날짜·금액을 확인해주세요.',400);
 return fail('대여금 기록을 처리하지 못했습니다. 다시 조회한 뒤 시도해주세요.',500);
};
const caught=(error:unknown)=>{
 const message=error instanceof Error?error.message:'';
 if(message==='UNAUTHORIZED')return fail('로그인이 필요합니다.',401);
 if(message==='ADMIN_REQUIRED')return fail('초대된 관리자만 공동 재무자료에 접근할 수 있습니다.',403);
 return fail('대여금 기록을 처리하지 못했습니다. 다시 시도해주세요.',500);
};

/** Read and bookkeeping writes use the caller's RLS; no service-role credentials. */
export function intercompanyRegisterHandlers({authenticate,syncEntry}:Dependencies){
 const read=async(db:Pick<SupabaseClient,'rpc'>):Promise<IntercompanyRegisterData|null>=>{
  const {data,error}=await db.rpc('fd_read_intercompany_register');
  if(error)throw Error(error.message.includes('ADMIN_REQUIRED')?'ADMIN_REQUIRED':'INTERCOMPANY_READ_FAILED');
  const parsed=intercompanyRegisterSchema.safeParse(data);
  return parsed.success?parsed.data:null;
 };
 return {
  GET:async()=>{
   try{const {db}=await authenticate();const register=await read(db);return register?Response.json(register,{headers}):fail('대여금 자료 형식을 확인하지 못했습니다. 다시 조회해주세요.',502);}catch(error){return caught(error);}
  },
  POST:async(request:Request)=>{
   try{
    const {db}=await authenticate();
    const origin=request.headers.get('origin');
    if(!origin||new URL(origin).origin!==new URL(request.url).origin)return fail('허용되지 않은 요청입니다.',403);
    if(Number(request.headers.get('content-length'))>16384)return fail('요청이 너무 큽니다.',413);
    const text=await request.text();
    if(new TextEncoder().encode(text).length>16384)return fail('요청이 너무 큽니다.',413);
    let body:unknown;
    try{body=JSON.parse(text);}catch{return fail('입력한 대여금 기록을 확인해주세요.',400);}
    const sync=syncSchema.safeParse(body),change=intercompanyChangeSchema.safeParse(body);
    if(!sync.success&&!change.success)return fail(change.error?.issues[0]?.message||'입력한 대여금 기록을 확인해주세요.',400);
    let register:IntercompanyRegisterData|null;
    if(change.success){
     const {data,error}=await db.rpc('fd_save_intercompany_register',{p_change:change.data});
     if(error)return rpcFailure(error.message);
     const parsed=intercompanyRegisterSchema.safeParse(data);register=parsed.success?parsed.data:null;
    }else register=await read(db);
    if(!register)return fail('저장 결과를 확인하지 못했습니다. 같은 기록으로 다시 시도하거나 자료를 새로고침해주세요.',502);
    const entryId=change.success?change.data.id:sync.data!.id;
    const saved=register.entries.find(entry=>entry.id===entryId);
    if(!saved||!register.baseline)return fail('저장된 대여금 기록을 확인하지 못했습니다. 다시 조회해주세요.',502);
    if(change.success&&change.data.action==='create'){
     const expected=change.data;
     if(saved.from_party!==expected.from_party||saved.to_party!==expected.to_party||saved.entry_date!==expected.entry_date||saved.amount!==expected.amount||saved.kind!==expected.kind||saved.memo!==expected.memo)return fail('저장된 내용이 입력한 기록과 다릅니다. 최신 기록을 확인해주세요.',502);
    }
    const {data:claimValue,error:claimError}=await db.rpc('fd_claim_intercompany_sheet',{p_id:entryId});
    if(claimError)return Response.json({...register,sheetWarning:'대여금 기록은 저장됐지만 시트 반영을 시작하지 못했습니다. 시트 다시 반영을 눌러주세요.'},{headers});
    if(claimValue===null){
     const latest=await read(db);
     return Response.json({...latest??register,...((latest??register).entries.find(e=>e.id===entryId)?.sheet_status==='synced'?{}:{sheetWarning:'대여금 기록은 저장됐으며 시트 반영을 기다리고 있습니다. 잠시 후 다시 확인해주세요.'})},{headers});
    }
    const claimed=claimSchema.safeParse(claimValue);
    if(!claimed.success||claimed.data.entry.id!==entryId||claimed.data.entry.version!==claimed.data.lease_version)return Response.json({...register,sheetWarning:'대여금 기록은 저장됐지만 시트 반영 상태를 확인하지 못했습니다. 다시 조회해주세요.'},{headers});
    let success=false;
    try{await syncEntry(register.baseline,claimed.data.entry,claimed.data.previous_row?{expectedPreviousRow:claimed.data.previous_row}:undefined);success=true;}catch{/* Provider failures never expose response bodies or credentials. */}
    const {data:finished,error:finishError}=await db.rpc('fd_finish_intercompany_sheet',{
     p_id:entryId,p_token:claimed.data.token,p_version:claimed.data.lease_version,p_success:success,p_error:success?'':'시트 반영 결과를 확인하지 못했습니다. 같은 기록으로 다시 시도해주세요.',
    });
    const finalParsed=intercompanyRegisterSchema.safeParse(finished);
    if(finishError||!finalParsed.success)return Response.json({...register,sheetWarning:'대여금 기록은 저장됐지만 시트 반영 결과를 확인하지 못했습니다. 자료를 새로고침한 뒤 다시 반영해주세요.'},{headers});
    const final=finalParsed.data,status=final.entries.find(e=>e.id===entryId)?.sheet_status;
    return Response.json({...final,...(status==='synced'?{}:{sheetWarning:success?'반영 중 기록이 변경되었습니다. 최신 상태를 시트에 다시 반영해주세요.':'대여금 기록은 저장됐지만 시트 반영 결과는 확인이 필요합니다. 같은 기록의 시트 기록 재시도를 눌러주세요.'})},{headers});
   }catch(error){return caught(error);}
  },
 };
}
