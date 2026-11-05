import {authenticated,apiError,assertSameOrigin} from '@/lib/supabase/server';
import {initializeFinanceCatalog} from '@/lib/finance/setup';

export async function POST(request:Request){
 try{
  assertSameOrigin(request);
  const {db,ownerId}=await authenticated();
  return Response.json(await initializeFinanceCatalog(db,ownerId));
 }catch(error){return apiError(error);}
}
