import type {SupabaseClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {emptyDataset,type Dataset} from './types';
import type {ReviewSelection} from './classification-review';
import type {ClassificationResult} from './classification-result';

type Client=Pick<SupabaseClient,'rpc'>;
const scopeSchema=z.tuple([z.string().uuid(),z.enum(['in','out']),z.string().min(1)]);
type Scope={account_id:string;direction:'in'|'out'};
const readError='분류할 거래를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.';
const resultSchema=z.object({
 updated:z.number().int().nonnegative(),learned:z.number().int().nonnegative(),
 transactions:z.array(z.object({id:z.string().min(1),category_id:z.string().min(1),is_internal:z.boolean(),manually_classified:z.literal(true)})),
 rulesDelta:z.array(z.object({id:z.string().min(1),pattern:z.string(),field:z.literal('description'),category_id:z.string().min(1),priority:z.number().int(),is_internal:z.boolean(),account_id:z.string().min(1),direction:z.enum(['in','out'])})),
});

/** The group key only limits reads; prepareReviewChanges still verifies every actual member. */
export function classificationScopes(selections:ReviewSelection[]):Scope[]{
 const scopes=new Map<string,Scope>();
 for(const selection of selections){
  let parsed:unknown;
  try{parsed=JSON.parse(selection.key);}catch{throw Error('거래 묶음 형식을 확인하지 못했습니다. 새로고침 후 다시 확인해주세요.');}
  const result=scopeSchema.safeParse(parsed);
  if(!result.success)throw Error('거래 묶음 형식을 확인하지 못했습니다. 새로고침 후 다시 확인해주세요.');
  const [account_id,direction]=result.data;
  scopes.set(JSON.stringify([account_id,direction]),{account_id,direction});
 }
 return [...scopes.values()];
}

/** One invoker RPC checks administrator access and returns the complete scoped snapshot. */
export async function readClassificationReviewData(db:Client,selections:ReviewSelection[]):Promise<Dataset>{
 const scopes=classificationScopes(selections);
 const {data,error}=await db.rpc('fd_read_classification_context',{p_scopes:scopes});
 if(error){
  if(error.message.includes('UNAUTHORIZED'))throw Error('UNAUTHORIZED');
  if(error.message.includes('ADMIN_REQUIRED'))throw Error('ADMIN_REQUIRED');
  throw Error(readError);
 }
 if(!data||['categories','rules','aliases','transactions'].some(key=>!Array.isArray(data[key])))throw Error(readError);
 return {...emptyDataset,categories:data.categories,rules:data.rules,aliases:data.aliases,transactions:data.transactions};
}

/** The atomic RPC returns committed fields while its row locks are still held. */
export function classificationResultFromRpc(value:unknown,ids:string[],learned:number):ClassificationResult{
 const expectedIds=new Set(ids),fallback={updated:expectedIds.size,learned,needsRefresh:true};
 const parsed=resultSchema.safeParse(value);
 if(!parsed.success)return fallback;
 const result=parsed.data,actualIds=new Set(result.transactions.map(transaction=>transaction.id));
 if(result.updated!==expectedIds.size||result.learned!==learned||result.transactions.length!==expectedIds.size
  ||actualIds.size!==expectedIds.size||ids.some(id=>!actualIds.has(id))||result.rulesDelta.length!==learned
  ||new Set(result.rulesDelta.map(rule=>rule.id)).size!==learned)return fallback;
 return result;
}
