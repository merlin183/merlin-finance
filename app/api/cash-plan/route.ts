import {authenticated,assertSameOrigin,apiError} from '@/lib/supabase/server';
import {cashPlanChangesSchema} from '@/lib/finance/cash-plan-edits';

const headers={'Cache-Control':'no-store'};

export async function GET(){
 try{
  const {db}=await authenticated();
  const {data,error}=await db.rpc('fd_read_cash_plan_edits');
  if(error)throw Error('저장된 지출 계획을 불러오지 못했습니다. 다시 불러와주세요.');
  return Response.json({edits:data},{headers});
 }catch(error){return apiError(error);}
}

export async function POST(request:Request){
 try{
  assertSameOrigin(request);
  const {db}=await authenticated();
  const parsed=cashPlanChangesSchema.safeParse(await request.json());
  if(!parsed.success)return Response.json({error:parsed.error.issues[0]?.message||'수정할 지출 계획을 확인해주세요.'},{status:400,headers});
  const {data,error}=await db.rpc('fd_save_cash_plan_edits',{p_changes:parsed.data.changes});
  if(error){
   if(error.message.includes('CASH_PLAN_STALE'))return Response.json({error:'다른 관리자가 이 지출 계획을 수정했습니다. 입력 내용은 유지됩니다. 최신 계획을 확인한 뒤 다시 저장해주세요.'},{status:409,headers});
   if(error.message.includes('ADMIN_REQUIRED'))throw Error('ADMIN_REQUIRED');
   if(error.message.includes('CASH_PLAN_TAX_PENDING'))return Response.json({error:'미납 세금 일정은 삭제할 수 없습니다. 실제 납부 후 납부완료로 표시해주세요.'},{status:400,headers});
   if(error.message.includes('CASH_PLAN_TAX_KIND_IMMUTABLE'))return Response.json({error:'등록된 세금 일정은 일반 지출로 변경할 수 없습니다.'},{status:400,headers});
   if(error.message.includes('CASH_PLAN_CONFIRMATION_FUTURE'))return Response.json({error:'미래 날짜를 실제 출금일로 저장할 수 없습니다.'},{status:400,headers});
   if(error.message.includes('CASH_PLAN_CONFIRMATION_TAX'))return Response.json({error:'세금 일정은 기존 납부 완료 표시를 사용해주세요.'},{status:400,headers});
   if(error.message.includes('INVALID_CASH_PLAN_CONFIRMATION')||error.message.includes('finance_plan_confirmation'))return Response.json({error:'출금 확인일·금액·완료 여부를 확인해주세요.'},{status:400,headers});
   throw Error('지출 계획을 저장하지 못했습니다. 입력한 내용을 확인한 뒤 다시 저장해주세요.');
  }
  return Response.json({edits:data},{headers});
 }catch(error){return apiError(error);}
}
