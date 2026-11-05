import type {SupabaseClient} from '@supabase/supabase-js';
import type {ExternalTransactionRef} from '../finance/clobe-import';
import {ClobeImportError,signClobeImport} from './import-security';

export function clobeImportStore(db:SupabaseClient,userId:string,ownerId:string){
 const rpc=async(action:string,payload:Record<string,unknown>):Promise<unknown>=>{
  const wire=JSON.stringify(payload),proof=signClobeImport(action,wire,userId,ownerId);
  const {data,error}=await db.rpc('fd_clobe_import',{p_action:action,p_payload:wire,p_proof:proof});
  if(error){
   // Never echo SQL/provider details, identifiers, ciphertext or signatures.
   if(/ADMIN_REQUIRED|UNAUTHORIZED/.test(error.message))throw Error('ADMIN_REQUIRED');
   if(/CLOBE_IMPORT_EXPIRED/.test(error.message))throw new ClobeImportError('expired');
   if(/CLOBE_IMPORT_TOO_LARGE/.test(error.message))throw new ClobeImportError('too_large');
   if(/CLOBE_IMPORT_CONFIGURATION|CLOBE_IMPORT_UNTRUSTED/.test(error.message))throw new ClobeImportError('configuration');
   if(/CLOBE_IMPORT_STALE|CLOBE_IMPORT_RUN_CONFLICT|CLOBE_IMPORT_MAPPING_CHANGED|CLOBE_IMPORT_CATEGORY|CLOBE_IMPORT_SCOPE/.test(error.message)||error.code==='23505')throw new ClobeImportError('stale');
   throw new ClobeImportError('storage');
  }
  return data;
 };
 return {rpc,getRefs:async(accountIds:string[])=>await rpc('refs',{account_ids:accountIds}) as ExternalTransactionRef[]};
}
