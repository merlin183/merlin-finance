import {cookies} from 'next/headers';
import {authenticated,apiError} from '@/lib/supabase/server';
import {beginClobeConnection} from '@/lib/clobe/connection';
import {assertClobeOrigin,clobeConfig,CLOBE_ATTEMPT_COOKIE,CLOBE_ATTEMPT_TTL_SECONDS} from '@/lib/clobe/auth';

export const runtime='nodejs';
export async function POST(request:Request){
 try{
  const config=clobeConfig();
  // A mutating browser action requires Origin, compared with server config,
  // never with untrusted forwarded/Host headers. Cross-site form POSTs fail.
  assertClobeOrigin(request,config.origin);
  const {db,user,ownerId}=await authenticated();
  const result=await beginClobeConnection(db,ownerId,user.id);
  (await cookies()).set(CLOBE_ATTEMPT_COOKIE,result.cookie,{httpOnly:true,secure:result.secure,sameSite:'lax',path:'/api/clobe',maxAge:CLOBE_ATTEMPT_TTL_SECONDS});
  return Response.json({authorizationUrl:result.authorizationUrl},{headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
 }catch(error){return apiError(error);}
}
