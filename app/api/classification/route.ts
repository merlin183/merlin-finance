import {z} from 'zod';
import {signedIn,apiError,assertSameOrigin} from '@/lib/supabase/server';
import {prepareReviewChanges} from '@/lib/finance/classification-review';
import {readClassificationReviewData,classificationResultFromRpc} from '@/lib/finance/classification-data';

const selection=z.object({
 key:z.string().min(1).max(1500),category_id:z.string().uuid(),remember:z.boolean(),
 transactions:z.array(z.object({id:z.string().uuid(),category_id:z.string().uuid().nullable(),manually_classified:z.boolean()})).min(1).max(10000),
});
export async function POST(request:Request){
 const timings:string[]=[];
 const elapsed=(name:string,start:number)=>timings.push(`${name};dur=${(performance.now()-start).toFixed(1)}`);
 try{
  assertSameOrigin(request);
  const authStart=performance.now();
  // The context RPC checks current workspace membership; avoid a separate
  // admin-context HTTP call before fetching that same protected context.
  const {db}=await signedIn();
  elapsed('auth',authStart);
  const body=z.object({groups:z.array(selection).min(1).max(10000)}).parse(await request.json());
  if(body.groups.reduce((n,g)=>n+g.transactions.length,0)>10000)throw Error('한 번에 10,000건까지 정리할 수 있습니다. 사업자나 계좌를 나누어 선택해주세요.');
  const readStart=performance.now();
  const {changes,rules}=prepareReviewChanges(await readClassificationReviewData(db,body.groups),body.groups);
  elapsed('review',readStart);
  if(rules.length>1000)throw Error('자동 학습할 규칙이 1,000개를 넘습니다. 계좌를 나누거나 자동 적용 체크를 끄고 정리해주세요.');
  const writeStart=performance.now();
  const {data,error}=await db.rpc('fd_apply_classification_review',{p_changes:changes,p_rules:rules});
  elapsed('save',writeStart);
  if(error){
   if(error.message.includes('UNAUTHORIZED'))throw Error('UNAUTHORIZED');
   if(error.message.includes('ADMIN_REQUIRED'))throw Error('ADMIN_REQUIRED');
   if(error.message.includes('CLASSIFICATION_RULE_CONFLICT'))throw Error('이 거래처의 기존 자동 규칙과 선택한 과목이 다릅니다. 자동 적용 체크를 끄면 이번 거래만 정리할 수 있습니다.');
   if(error.message.includes('CLASSIFICATION_STALE'))throw Error('다른 관리자가 거래를 수정했습니다. 새로고침 후 다시 확인해주세요.');
   throw Error('묶음 분류를 저장하지 못했습니다. 거래와 자동 분류 규칙은 함께 취소되었습니다.');
  }
  const resultStart=performance.now();
  const result=classificationResultFromRpc(data,changes.map(change=>change.id),rules.length);
  elapsed('result',resultStart);
  return Response.json(result,{headers:{'Cache-Control':'no-store','Server-Timing':timings.join(', ')}});
 }catch(error){return apiError(error);}
}
