import {authenticated,apiError} from '@/lib/supabase/server';
import {getClobeConnectionStatus} from '@/lib/clobe/connection';

export const runtime='nodejs';
export async function GET(){
 try{
  const {db}=await authenticated();
  return Response.json(await getClobeConnectionStatus(db),{headers:{'Cache-Control':'no-store'}});
 }catch(error){return apiError(error);}
}
