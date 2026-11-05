import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';

const money=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const category=z.string().uuid().nullable();
export const transferFeeRequestSchema=z.object({
 transaction_id:z.string().uuid(),
 transfer_category_id:z.string().uuid(),
 fee_category_id:category,
 fee_amount:money,
 expected:z.object({amount:money.min(1),category_id:category,manually_classified:z.boolean(),transfer_fee_amount:money,transfer_fee_category_id:category}).strict(),
}).strict().superRefine((value,ctx)=>{
 if(value.fee_amount>=value.expected.amount)ctx.addIssue({code:z.ZodIssueCode.custom,path:['fee_amount'],message:'수수료는 원본 출금액보다 작아야 합니다.'});
 if((value.fee_amount===0)!==(value.fee_category_id===null))ctx.addIssue({code:z.ZodIssueCode.custom,path:['fee_category_id'],message:'수수료 금액과 계정과목을 함께 지정해주세요.'});
 if(value.expected.transfer_fee_amount>=value.expected.amount||(value.expected.transfer_fee_amount===0)!==(value.expected.transfer_fee_category_id===null))ctx.addIssue({code:z.ZodIssueCode.custom,path:['expected'],message:'기존 거래를 다시 조회해주세요.'});
 if(value.fee_category_id===value.transfer_category_id)ctx.addIssue({code:z.ZodIssueCode.custom,path:['fee_category_id'],message:'이체와 수수료 계정과목은 달라야 합니다.'});
});
export type TransferFeeRequest=z.infer<typeof transferFeeRequestSchema>;
export type TransferFeeSavedTransaction={id:string;amount:number;category_id:string;is_internal:true;manually_classified:true;transfer_fee_amount:number;transfer_fee_category_id:string|null};

export type TransferFeeRouteDependencies={authenticate:()=>Promise<{db:Pick<SupabaseClient,'rpc'>;ownerId:string}>};
const headers={'Cache-Control':'no-store'};
const jsonError=(error:string,status:number)=>Response.json({error},{status,headers});

/** Only explicit allocation metadata is sent to the invoker RPC; bank fields are never accepted. */
export function transferFeeHandler(dependencies:TransferFeeRouteDependencies){return async(request:Request)=>{
 try{
  const origin=request.headers.get('origin');
  if(!origin||new URL(origin).origin!==new URL(request.url).origin)return jsonError('허용되지 않은 요청입니다.',403);
  const {db,ownerId}=await dependencies.authenticate();
  if(!z.string().uuid().safeParse(ownerId).success)return jsonError('관리자 권한을 확인하지 못했습니다.',403);
  if(Number(request.headers.get('content-length'))>4096)return jsonError('요청이 너무 큽니다.',413);
  const text=await request.text();
  if(new TextEncoder().encode(text).length>4096)return jsonError('요청이 너무 큽니다.',413);
  let value:unknown;
  try{value=JSON.parse(text);}catch{return jsonError('이체 금액과 수수료를 확인해주세요.',400);}
  const parsed=transferFeeRequestSchema.safeParse(value);
  if(!parsed.success)return jsonError(parsed.error.issues[0]?.message||'이체 금액과 수수료를 확인해주세요.',400);
  const {data,error}=await db.rpc('fd_set_transaction_transfer_fee',{p_payload:parsed.data});
  if(error){
   if(error.message.includes('ADMIN_REQUIRED')||error.message.includes('UNAUTHORIZED'))return jsonError('초대된 관리자만 공동 재무자료에 접근할 수 있습니다.',403);
   if(error.message.includes('TRANSFER_FEE_STALE'))return jsonError('다른 관리자가 거래를 수정했습니다. 최신 거래를 확인한 뒤 다시 저장해주세요.',409);
   if(error.message.includes('TRANSFER_FEE_NOT_FOUND'))return jsonError('해당 거래를 찾을 수 없습니다. 거래를 다시 조회해주세요.',404);
   if(error.message.includes('TRANSFER_FEE_LINKED'))return jsonError('사업자 간 연결된 거래는 수수료를 분리할 수 없습니다. 거래 연결을 먼저 확인해주세요.',400);
   if(error.message.includes('INVALID_TRANSFER_FEE')||error.message.includes('TRANSFER_FEE_CATEGORY'))return jsonError('이체·수수료 금액과 계정과목을 확인해주세요.',400);
   return jsonError('이체 수수료 분류를 저장하지 못했습니다. 최신 거래를 확인한 뒤 다시 시도해주세요.',500);
  }
  const saved=z.object({id:z.string().uuid(),amount:money.min(1),category_id:z.string().uuid(),is_internal:z.literal(true),manually_classified:z.literal(true),transfer_fee_amount:money,transfer_fee_category_id:category}).strict().safeParse(data);
  if(!saved.success||saved.data.id!==parsed.data.transaction_id||saved.data.amount!==parsed.data.expected.amount||saved.data.category_id!==parsed.data.transfer_category_id||saved.data.transfer_fee_amount!==parsed.data.fee_amount||saved.data.transfer_fee_category_id!==parsed.data.fee_category_id)return jsonError('저장 결과를 확인하지 못했습니다. 거래를 다시 조회해주세요.',502);
  return Response.json({ok:true,transaction:saved.data},{headers});
 }catch(error){
  const message=error instanceof Error?error.message:'';
  if(message==='UNAUTHORIZED')return jsonError('로그인이 필요합니다.',401);
  if(message==='ADMIN_REQUIRED')return jsonError('초대된 관리자만 공동 재무자료에 접근할 수 있습니다.',403);
  return jsonError('이체 수수료 분류를 저장하지 못했습니다. 다시 시도해주세요.',500);
 }
};}
