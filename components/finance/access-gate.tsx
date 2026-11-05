"use client";
import {useState} from 'react';
import {ShieldCheck} from 'lucide-react';
import {Button} from '@/components/ui/button';

export function AccessGate({email,unavailable=false}:{email:string;unavailable?:boolean}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function switchAccount(){
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'logout'})});
      if(!response.ok)throw Error('로그아웃하지 못했습니다. 다시 시도하세요.');
      location.href='/login';
    }catch(e){setError(e instanceof Error?e.message:'다시 시도하세요.');setBusy(false)}
  }
  return <main className="min-h-screen flex items-center justify-center p-6 bg-muted/30"><section className="panel p-8 max-w-lg w-full text-center space-y-5">
    <ShieldCheck size={36} className="mx-auto text-primary"/>
    <p className="eyebrow">MERLIN FINANCE DESK</p>
    <h1 className="text-2xl font-semibold">{unavailable?'권한을 확인하지 못했습니다':'관리자 초대가 필요합니다'}</h1>
    <p className="break-all font-medium">{email}</p>
    <p className="muted">{unavailable?'잠시 후 다시 확인해주세요.':'공동 재무자료는 초대된 관리자만 이용할 수 있습니다. 초대받은 이메일의 Google 계정으로 로그인해주세요. 새 설치의 첫 관리자는 설치 안내에 따라 데이터베이스에서 등록해야 합니다.'}</p>
    <div className="flex flex-wrap justify-center gap-3"><Button disabled={busy} onClick={()=>void switchAccount()}>다른 Google 계정으로 로그인</Button><Button variant="outline" onClick={()=>location.reload()}>권한 다시 확인</Button></div>
    {error&&<p className="negative" role="alert">{error}</p>}
  </section></main>;
}
