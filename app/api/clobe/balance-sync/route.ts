import {authenticated} from '@/lib/supabase/server';
import {clobeConfig} from '@/lib/clobe/auth';
import {getClobeAccessToken} from '@/lib/clobe/connection';
import {createClobeReadSession} from '@/lib/clobe/mcp';
import {readClobeAccounts} from '@/lib/clobe/read';
import {clobeImportStore} from '@/lib/clobe/import-store';
import {clobeBalanceStore} from '@/lib/clobe/balance-sync-store';
import {clobeBalanceSyncHandler} from '@/lib/clobe/balance-sync-route';
import type {ClobeImportSettings} from '@/lib/clobe/import-types';
import {clobePlanActualsStore} from '@/lib/clobe/plan-actuals-store';
import {readClobePlanActualPage,readClobePlanBankStatus} from '@/lib/clobe/plan-actuals-sync';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export const POST=clobeBalanceSyncHandler({getOrigin:()=>clobeConfig().origin,authenticate:async()=>{
 const {db,user,ownerId}=await authenticated(),store=clobeImportStore(db,user.id,ownerId),save=clobeBalanceStore(db,user.id,ownerId),saveActuals=clobePlanActualsStore(db,user.id,ownerId);
 return {openSession:async signal=>createClobeReadSession(await getClobeAccessToken(db,ownerId),{signal}),makeDependencies:getSession=>({
  getMappings:async()=>((await store.rpc('settings',{})) as ClobeImportSettings).mappings,
  readAccounts:async()=>readClobeAccounts(await getSession()),save,
  planActuals:{readPage:async(request,collectedAt)=>readClobePlanActualPage(await getSession(),request,collectedAt),readStatus:async companyId=>readClobePlanBankStatus(await getSession(),companyId),save:saveActuals},
 })};
}});
