import {authenticated,assertSameOrigin,apiError} from '@/lib/supabase/server';
import {fixedCostForwardRequestSchema,readFixedCostSaveResult} from '@/lib/finance/cash-plan-series-forward';

const headers={'Cache-Control':'no-store'};
export async function POST(request:Request){
 try{
  assertSameOrigin(request);
  const {db}=await authenticated(),parsed=fixedCostForwardRequestSchema.safeParse(await request.json());
  if(!parsed.success)return Response.json({error:parsed.error.issues[0]?.message||'반복 고정비 입력 내용을 확인해주세요.'},{status:400,headers});
  const {data,error}=await db.rpc('fd_save_cash_plan_series',{p_change:parsed.data});
  if(error){
   if(/CASH_PLAN_(?:SERIES_)?STALE/.test(error.message))return Response.json({error:'다른 관리자가 이 고정비를 변경했습니다. 입력은 유지했습니다. 최신 계획을 다시 확인해주세요.'},{status:409,headers});
   if(error.message.includes('ADMIN_REQUIRED'))throw Error('ADMIN_REQUIRED');
   if(error.message.includes('CASH_PLAN_SERIES_EXCLUDED'))return Response.json({error:'제외된 항목은 자동으로 다시 포함할 수 없습니다.'},{status:400,headers});
   if(error.message.includes('CASH_PLAN_SERIES_OPERATING_REQUIRED'))return Response.json({error:'카드 할부 일정은 반복 고정비로 변경할 수 없습니다.'},{status:400,headers});
   if(error.message.includes('CASH_PLAN_SERIES_'))return Response.json({error:'고정비 원본·적용월·출금 계좌와 입력 내용을 확인해주세요.'},{status:400,headers});
   throw Error('반복 고정비를 저장하지 못했습니다. 입력 내용은 유지했습니다.');
  }
  return Response.json(readFixedCostSaveResult(data),{headers});
 }catch(error){return apiError(error);}
}
