import {authenticated} from '@/lib/supabase/server';
import {getClobeAccessToken} from '@/lib/clobe/connection';
import {clobeConfig} from '@/lib/clobe/auth';
import {createClobeReadSession} from '@/lib/clobe/mcp';
import {clobeCardBillsHandler} from '@/lib/clobe/card-billing';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export const GET=clobeCardBillsHandler({authenticate:authenticated,getAccessToken:getClobeAccessToken,openSession:createClobeReadSession,getOrigin:()=>clobeConfig().origin});
