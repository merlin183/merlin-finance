import type {SupabaseClient} from '@supabase/supabase-js';
import {signClobeImport} from './import-security';
import type {ClobeBalanceInput,ClobeBalanceSaved} from './balance-sync';

/** The purpose-bound HMAC reuses the existing private verifier without
 * disclosing its key or accepting browser-supplied financial values. */
export function clobeBalanceStore(db:SupabaseClient,userId:string,ownerId:string){
 return async(rows:ClobeBalanceInput[]):Promise<ClobeBalanceSaved>=>{
  const wire=JSON.stringify({snapshots:rows}),proof=signClobeImport('balance-sync',wire,userId,ownerId);
  const {data,error}=await db.rpc('fd_clobe_balance_sync',{p_payload:wire,p_proof:proof});
  if(error){
   if(/ADMIN_REQUIRED|UNAUTHORIZED/.test(error.message))throw Error('ADMIN_REQUIRED');
   if(/CLOBE_BALANCE_CONFIGURATION|CLOBE_BALANCE_UNTRUSTED/.test(error.message))throw Error('CLOBE_BALANCE_CONFIGURATION');
   if(/CLOBE_BALANCE_SCOPE/.test(error.message))throw Error('CLOBE_BALANCE_SCOPE');
   throw Error('CLOBE_BALANCE_STORAGE');
  }
  if(!data||!Number.isInteger(data.synced)||!Number.isInteger(data.unchanged)||!Array.isArray(data.skipped))throw Error('CLOBE_BALANCE_STORAGE');
  return data as ClobeBalanceSaved;
 };
}
