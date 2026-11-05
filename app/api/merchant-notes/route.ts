import {z} from 'zod';
import {authenticated,assertSameOrigin,apiError} from '@/lib/supabase/server';
import {noteSubject} from '@/lib/finance/merchant-notes';
import type {Transaction} from '@/lib/finance/types';
export async function POST(request:Request){
 const timings:string[]=[];
 const elapsed=(name:string,start:number)=>timings.push(`${name};dur=${(performance.now()-start).toFixed(1)}`);
 try{
  assertSameOrigin(request);const authStart=performance.now();const {db}=await authenticated();elapsed('auth',authStart);
  const body=z.object({transaction_id:z.string().uuid(),memo:z.string().max(2000),version:z.number().int().min(0)}).parse(await request.json());
  const readStart=performance.now();
  const {data:transaction,error:txError}=await db.from('fd_transactions').select('id,account_id,direction,description').eq('id',body.transaction_id).single();
  elapsed('subject',readStart);
  if(txError||!transaction)throw Error('메모를 연결할 거래를 찾지 못했습니다. 새로고침 후 확인해주세요.');
  const subject=noteSubject(transaction as Transaction);
  const saveStart=performance.now();
  const {data,error}=await db.rpc('fd_save_merchant_note',{p_account:subject.account_id,p_direction:subject.direction,p_subject:subject.subject_key,p_label:subject.label,p_memo:body.memo,p_version:body.version});
  elapsed('save',saveStart);
  if(error){
   if(error.message.includes('NOTE_STALE')){
    const {data:current}=await db.from('fd_merchant_notes').select('*').eq('account_id',subject.account_id).eq('direction',subject.direction).eq('subject_key',subject.subject_key).maybeSingle();
    return Response.json({error:'다른 관리자가 메모를 수정했습니다. 최신 메모를 확인한 뒤 저장해주세요.',current},{status:409,headers:{'Cache-Control':'no-store'}});
   }
   throw Error('메모를 저장하지 못했습니다. 작성한 내용을 유지했습니다. 다시 저장해주세요.');
  }
  return Response.json({note:data},{headers:{'Cache-Control':'no-store','Server-Timing':timings.join(', ')}});
 }catch(error){return apiError(error);}
}
