import type {SupabaseClient} from '@supabase/supabase-js';
import {signClobeImport} from '../clobe/import-security';
import {TossError} from './config';
import type {TossMerchant,TossSettlement,TossSettlementResponse} from './types';
import {z} from 'zod';

const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/),money=z.number().int().safe();
const merchant=z.object({merchantId:z.string().min(1).max(100),businessId:z.string().uuid(),accountId:z.string().uuid(),label:z.string().min(1).max(100)}).strict();
const settlement=z.object({merchant_id:z.string().min(1).max(100),transaction_key:z.string().min(1).max(200),payment_key:z.string().min(1).max(200),business_id:z.string().uuid(),account_id:z.string().uuid(),paid_out_date:date,sold_date:date,amount:money,pay_out_amount:money,fee_amount:money,synced_at:z.string().datetime({offset:true})}).strict();
const readSchema=z.object({merchants:z.array(merchant).max(20),settlements:z.array(settlement).max(100000),lastSyncedAt:z.string().datetime({offset:true}).nullable(),range:z.object({from:date,to:date}).strict().nullable()}).strict();
export type TossStored=Omit<TossSettlementResponse,'configured'|'sync'>;
export type TossSave={run_id:string;issued_at:string;from:string;to:string;merchants:TossMerchant[];settlements:TossSettlement[]};
export type TossStore={read:()=>Promise<TossStored>;claim:(run:string,issuedAt:string)=>Promise<void>;release:(run:string,issuedAt:string)=>Promise<void>;save:(input:TossSave)=>Promise<{saved:number;from:string;to:string}>};
function storageError(message:string):never{
 if(/ADMIN_REQUIRED|UNAUTHORIZED/.test(message))throw Error('ADMIN_REQUIRED');
 if(/TOSS_BUSY/.test(message))throw new TossError('busy');
 if(/TOSS_CONFIGURATION|TOSS_UNTRUSTED/.test(message))throw new TossError('configuration');
 if(/TOSS_SCOPE/.test(message))throw new TossError('scope');
 throw new TossError('storage');
}
export function tossStore(db:SupabaseClient,userId:string,ownerId:string):TossStore{
 const write=async(action:string,payload:unknown)=>{
  const wire=JSON.stringify(payload),proof=signClobeImport(`toss-settlements-${action}`,wire,userId,ownerId);
  const {data,error}=await db.rpc('fd_toss_settlements_sync',{p_action:action,p_payload:wire,p_proof:proof});
  if(error)storageError(error.message);
  return data;
 };
 return {
  async read(){const {data,error}=await db.rpc('fd_toss_settlements_read');if(error)storageError(error.message);const result=readSchema.safeParse(data);if(!result.success)throw new TossError('storage');return result.data;},
  async claim(run_id,issued_at){const result=await write('claim',{run_id,issued_at});if(result?.claimed!==true)throw new TossError('storage');},
  async release(run_id,issued_at){await write('release',{run_id,issued_at});},
  async save(input){const result=await write('save',input);if(!result||!Number.isSafeInteger(result.saved)||result.saved<0||result.from!==input.from||result.to!==input.to)throw new TossError('storage');return result;},
 };
}
