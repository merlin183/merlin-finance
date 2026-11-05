import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {authenticated,apiError} from '@/lib/supabase/server';
import {finishClobeConnection} from '@/lib/clobe/connection';
import {clobeConfig,CLOBE_ATTEMPT_COOKIE,ClobeAuthError} from '@/lib/clobe/auth';

export const runtime='nodejs';
export async function GET(request:Request){
 let config:ReturnType<typeof clobeConfig>;
 try{config=clobeConfig();}catch(error){return apiError(error);}
 const resultUrl=new URL('/upload',config.origin);
 const jar=await cookies();
 const cookie=jar.get(CLOBE_ATTEMPT_COOKIE)?.value||'';
 // Expire the same scoped cookie on success, rejection and invalid callbacks.
 jar.set(CLOBE_ATTEMPT_COOKIE,'',{httpOnly:true,secure:config.secure,sameSite:'lax',path:'/api/clobe',maxAge:0});
 try{
  const {db,user,ownerId}=await authenticated();
  const query=new URL(request.url).searchParams;
  if(query.has('error'))throw new ClobeAuthError('invalid_state');
  if(query.getAll('state').length!==1||query.getAll('code').length!==1)throw new ClobeAuthError('invalid_state');
  await finishClobeConnection(db,ownerId,user.id,cookie,query.get('state')||'',query.get('code')||'');
  resultUrl.searchParams.set('clobe','connected');
 }catch{
  // Never echo OAuth codes, provider errors, caller URL or arbitrary returnTo.
  resultUrl.searchParams.set('clobe','error');
 }
 const response=NextResponse.redirect(resultUrl,303);
 response.headers.set('Cache-Control','no-store');response.headers.set('Referrer-Policy','no-referrer');
 return response;
}
