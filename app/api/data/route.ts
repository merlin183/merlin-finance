import {financeDatasetResponse,getData} from '@/lib/finance/data';import {apiError} from '@/lib/supabase/server';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=60;
export async function GET(request:Request){
 const started=performance.now();
 try{
  const data=await getData();
  return await financeDatasetResponse(data,started,request);
 }catch(e){return apiError(e)}
}
