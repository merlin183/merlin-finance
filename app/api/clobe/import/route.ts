import {authenticated} from '@/lib/supabase/server';
import {getData} from '@/lib/finance/data';
import {clobeConfig} from '@/lib/clobe/auth';
import {getClobeAccessToken} from '@/lib/clobe/connection';
import {createClobeReadSession} from '@/lib/clobe/mcp';
import {fetchClobeImportRows,fetchClobeSyncRows,verifyClobeImportAccess,verifyClobeSyncSource} from '@/lib/clobe/import-source';
import {clobeImportStore} from '@/lib/clobe/import-store';
import {clobeImportHandlers} from '@/lib/clobe/import-route';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const handlers=clobeImportHandlers({getOrigin:()=>clobeConfig().origin,authenticate:async()=>{
 const {db,user,ownerId}=await authenticated(),store=clobeImportStore(db,user.id,ownerId);
 return {openSession:async signal=>createClobeReadSession(await getClobeAccessToken(db,ownerId),{signal}),makeDependencies:getSession=>({
  userId:user.id,ownerId,getDataset:()=>getData(db),getRefs:store.getRefs,rpc:store.rpc,
  fetchSource:async scope=>fetchClobeImportRows(await getSession(),scope),validateSource:async scope=>verifyClobeImportAccess(await getSession(),scope),
   fetchSyncSource:async scope=>fetchClobeSyncRows(await getSession(),scope),validateSyncSource:async(scope,collections)=>verifyClobeSyncSource(await getSession(),scope,collections),
 })};
}});
export const GET=handlers.GET;
export const POST=handlers.POST;
