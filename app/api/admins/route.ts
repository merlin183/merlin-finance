import {authenticated,apiError,assertSameOrigin} from '@/lib/supabase/server';
import {z} from 'zod';

const messages:Record<string,string>={
  ADMIN_REQUIRED:'ADMIN_REQUIRED',
  LAST_ADMIN:'마지막 관리자는 해제할 수 없습니다. 다른 관리자가 초대를 수락한 후 다시 시도하세요.',
  ALREADY_ADMIN:'이미 활성화된 관리자입니다.',
  INVALID_EMAIL:'Google 계정 이메일을 정확히 입력하세요.',
  MEMBER_NOT_FOUND:'관리자 정보를 찾지 못했습니다. 목록을 새로고침하세요.'
};
export async function GET(){
  try{
    const {db}=await authenticated();
    const {data,error}=await db.rpc('fd_admin_list');
    if(error)throw Error(messages[error.message]||'관리자 목록을 불러오지 못했습니다.');
    return Response.json(data,{headers:{'Cache-Control':'no-store'}});
  }catch(e){return apiError(e)}
}
export async function POST(request:Request){
  try{
    assertSameOrigin(request);
    const {db}=await authenticated();
    const body=await request.json() as Record<string,unknown>;
    if(body.action==='invite'){
      const email=z.string().trim().email().max(254).parse(body.email).toLowerCase();
      const {error}=await db.rpc('fd_admin_invite',{p_email:email});
      if(error)throw Error(messages[error.message]||'초대를 등록하지 못했습니다.');
      return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
    }
    if(body.action==='revoke'){
      const id=z.string().uuid().parse(body.id);
      const {error}=await db.rpc('fd_admin_revoke',{p_id:id});
      if(error)throw Error(messages[error.message]||'권한을 해제하지 못했습니다.');
      return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
    }
    throw Error('요청을 확인하세요.');
  }catch(e){return apiError(e)}
}
