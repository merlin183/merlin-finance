import {authenticated} from '@/lib/supabase/server';
import {tossMerchants} from '@/lib/toss/config';
import {tossStore} from '@/lib/toss/store';
import {tossSettlementHandlers} from '@/lib/toss/route';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;
const handlers=tossSettlementHandlers({
 authenticate:async()=>{const {db,user,ownerId}=await authenticated();return tossStore(db,user.id,ownerId);},
 merchants:tossMerchants,
 origin:()=>{
  const value=process.env.TOSS_SYNC_ORIGIN||process.env.CLOBE_OAUTH_REDIRECT_URL;
  return value?new URL(value).origin:'';
 },
});
export const GET=handlers.GET;
export const POST=handlers.POST;
