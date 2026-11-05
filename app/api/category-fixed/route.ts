import {z} from 'zod';
import {authenticated,assertSameOrigin,apiError} from '@/lib/supabase/server';
import {needsCategoryReview} from '@/lib/finance/category-status';
export async function POST(request:Request){
 try{
  assertSameOrigin(request);const {db,ownerId}=await authenticated();
  const body=z.object({id:z.string().uuid(),is_fixed:z.boolean(),expected:z.boolean()}).parse(await request.json());
  const {data:category,error:readError}=await db.from('fd_categories').select('*').eq('id',body.id).single();
  if(readError||!category||category.is_internal||needsCategoryReview(category.name))throw Error('세부 지출 과목만 고정비로 지정할 수 있습니다.');
  const {data,error}=await db.from('fd_categories').update({is_fixed:body.is_fixed}).eq('id',body.id).eq('owner_id',ownerId).eq('is_fixed',body.expected).select('id').maybeSingle();
  if(error||!data)throw Error('과목 설정이 변경됐습니다. 새로고침 후 다시 선택해주세요.');
  return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return apiError(error);}
}
