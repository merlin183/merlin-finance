import {authenticated} from '@/lib/supabase/server';
import {getClobeAccessToken} from '@/lib/clobe/connection';
import {clobeConfig} from '@/lib/clobe/auth';
import {createClobeReadSession} from '@/lib/clobe/mcp';
import {clobeAccountsHandler} from '@/lib/clobe/read';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export const GET=clobeAccountsHandler({authenticate:authenticated,getAccessToken:getClobeAccessToken,openSession:createClobeReadSession,getOrigin:()=>clobeConfig().origin});
