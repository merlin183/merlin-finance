import {z} from 'zod';
import {authenticated,apiError,assertSameOrigin} from '@/lib/supabase/server';
import {getData} from '@/lib/finance/data';
import {fetchGoogleSheet,prepareSheetRows} from '@/lib/finance/google-sheets';
import {buildSourceDetailsPlan} from '@/lib/finance/source-details-plan';

export const maxDuration=60;
const headers={'Cache-Control':'no-store'};
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('preview'),url:z.string().max(2000)}),
 z.object({action:z.literal('apply'),url:z.string().max(2000),sourceHash:hash,planHash:hash}),
]);
export async function POST(request:Request){
 try{
  assertSameOrigin(request);
  const {db}=await authenticated();
  const input=schema.parse(await request.json());
  const [source,data]=await Promise.all([fetchGoogleSheet(input.url),getData(db)]);
  const prepared=await prepareSheetRows(source.bytes,data,undefined,source.sourceUrl);
  const plan=await buildSourceDetailsPlan(data,prepared.incoming,prepared.sourceHash,source.sourceUrl);
  if(input.action==='preview')return Response.json({sourceUrl:source.sourceUrl,sourceHash:prepared.sourceHash,planHash:plan.planHash,summary:plan.summary,sample:plan.sample},{headers});
  if(input.sourceHash!==prepared.sourceHash||input.planHash!==plan.planHash)return Response.json({error:'원본 또는 기존 거래가 변경되었습니다. 원본 내역을 다시 확인해주세요.'},{status:409,headers});
  if(!plan.changes.length)return Response.json({updated:0,unchanged:plan.summary.unchanged},{headers});
  if(plan.changes.length>20000)throw Error('한 번에 20,000건까지 보완할 수 있습니다.');
  const {data:result,error}=await db.rpc('fd_update_transaction_source_details',{p_changes:plan.changes});
  if(error){console.error('source-details RPC failed',error.code);throw Error('원본 내역을 저장하지 못했습니다. 거래 변경 여부와 연결 상태를 확인한 뒤 다시 시도해주세요.');}
  return Response.json(result,{headers});
 }catch(error){return apiError(error);}
}
