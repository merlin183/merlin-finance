import type {SupabaseClient} from '@supabase/supabase-js';
import {signClobeImport} from './import-security';
import type {ClobePlanActualScope,ClobePlanActualSaved} from './plan-actuals-sync';

export function clobePlanActualsStore(db:SupabaseClient,userId:string,ownerId:string){
 return async(scopes:ClobePlanActualScope[]):Promise<ClobePlanActualSaved>=>{
  const now=Date.now(),wire=JSON.stringify({issued_at:new Date(now).toISOString(),expires_at:new Date(now+5*60000).toISOString(),scopes});
  if(Buffer.byteLength(wire)>6*1024*1024)throw Error('CLOBE_PLAN_STORAGE');
  const proof=signClobeImport('plan-actuals-sync',wire,userId,ownerId);
  const {data,error}=await db.rpc('fd_clobe_plan_actuals_sync',{p_payload:wire,p_proof:proof});
  if(error)throw Error(/ADMIN_REQUIRED|UNAUTHORIZED/.test(error.message)?'ADMIN_REQUIRED':'CLOBE_PLAN_STORAGE');
  if(!data||!Number.isInteger(data.synced_accounts)||!Number.isInteger(data.unchanged_accounts)||!Number.isInteger(data.saved_outflows)||!Array.isArray(data.skipped))throw Error('CLOBE_PLAN_STORAGE');
  return data as ClobePlanActualSaved;
 };
}
