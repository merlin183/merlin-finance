import {serverClient} from '@/lib/supabase/server';
export async function GET(request:Request){const url=new URL(request.url);const code=url.searchParams.get('code');if(code){const db=await serverClient();const {error}=await db.auth.exchangeCodeForSession(code);if(!error)return Response.redirect(new URL('/',url.origin))}return Response.redirect(new URL('/login?error=expired',url.origin))}
