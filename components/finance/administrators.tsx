"use client";
import {useCallback,useEffect,useState,useSyncExternalStore,type FormEvent} from 'react';
import {Copy,RefreshCw,UserPlus,ShieldCheck} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {AlertDialog,AlertDialogTrigger,AlertDialogContent,AlertDialogHeader,AlertDialogTitle,AlertDialogDescription,AlertDialogFooter,AlertDialogCancel,AlertDialogAction} from '@/components/ui/alert-dialog';
import {toast} from 'sonner';
import {Panel,api} from './common';

type Member={id:string;email:string;status:'active'|'pending'|'expired'|'revoked';invited_at:string;expires_at:string|null;accepted_at:string|null;is_self:boolean};
type AdminEvent={action:string;subject_email:string;actor_email:string|null;created_at:string};
type AdminList={members:Member[];events:AdminEvent[]};
const statuses={active:'관리자',pending:'초대 대기',expired:'초대 만료',revoked:'권한 해제'};
const actions:Record<string,string>={bootstrap_admin:'최초 관리자 지정',retain_admin:'기존 관리자 유지',invite_admin:'관리자 초대',accept_invitation:'초대 수락',revoke_admin:'권한 해제',cancel_invitation:'초대 취소'};
const date=(value:string)=>new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
const subscribeLoginOrigin=()=>()=>{};
const loginAddress=()=>location.origin+'/login';
const serverLoginAddress=()=>'';

export function Administrators(){
  const [list,setList]=useState<AdminList|null>(null);
  const [email,setEmail]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [invited,setInvited]=useState('');
  const loginLink=useSyncExternalStore(subscribeLoginOrigin,loginAddress,serverLoginAddress);
  const load=useCallback(()=>fetch('/api/admins',{cache:'no-store'}).then(async response=>{
    const data=await response.json() as AdminList & {error?:string};
    if(!response.ok){if(response.status===401||response.status===403){setList(null);location.href='/login'}throw Error(data.error||'관리자 목록을 불러오지 못했습니다.')}
    setError('');setList(data);
  }).catch(error=>{setError(error instanceof Error?error.message:'다시 시도하세요.')}),[]);
  useEffect(()=>{void load()},[load]);
  async function invite(e:FormEvent){
    e.preventDefault();setBusy(true);setError('');
    try{await api('/api/admins',{action:'invite',email});setInvited(email.trim().toLowerCase());setEmail('');await load();toast.success('초대를 등록했습니다. 로그인 링크를 전달해주세요.')}
    catch(e){setError(e instanceof Error?e.message:'초대를 등록하지 못했습니다.')}
    finally{setBusy(false)}
  }
  async function copyLink(recipient?:string){
    try{await navigator.clipboard.writeText(recipient?`멀린 자금관리 관리자 초대\n${loginLink}\n${recipient} Google 계정으로 7일 안에 로그인해주세요.`:loginLink);toast.success('로그인 링크를 복사했습니다.')}
    catch{toast.error('복사하지 못했습니다. 아래 로그인 주소를 직접 복사해주세요.')}
  }
  async function revoke(member:Member){
    setBusy(true);setError('');
    try{await api('/api/admins',{action:'revoke',id:member.id});if(member.is_self){location.href='/login';return}await load();toast.success('관리자 권한과 대기 중 초대를 해제했습니다.')}
    catch(e){setError(e instanceof Error?e.message:'권한을 해제하지 못했습니다.')}
    finally{setBusy(false)}
  }
  const activeCount=list?.members.filter(m=>m.status==='active').length||0;
  return <div className="space-y-6">
    <Panel title="관리자 초대" subtitle="관리자는 같은 사업자·계좌·거래를 공동 관리하며, 다른 관리자를 초대하거나 해제할 수 있습니다.">
      <form className="flex flex-wrap items-end gap-3 p-5" onSubmit={e=>void invite(e)}>
        <label className="form-field flex-1 min-w-56">초대할 Google 계정 이메일<Input type="email" maxLength={254} placeholder="admin@example.com" value={email} onChange={e=>setEmail(e.target.value)} required disabled={busy}/></label>
        <Button type="submit" disabled={busy||!list}><UserPlus size={16}/>{busy?'처리 중…':'관리자 초대 등록'}</Button>
      </form>
      <div className="px-5 pb-5 space-y-3 text-sm"><p className="muted">초대는 7일 동안 유효합니다. 이메일은 자동 발송되지 않으므로, 등록 후 로그인 링크를 직접 전달해주세요. 등록된 이메일의 Google 계정으로 로그인하면 수락됩니다.</p>
        {invited&&<p className="positive" role="status">{invited}의 초대를 등록했습니다.</p>}
        <div className="flex flex-wrap items-center gap-2"><Input aria-label="관리자 초대 로그인 주소" readOnly value={loginLink} className="max-w-xl" onFocus={e=>e.target.select()}/><Button type="button" variant="outline" size="sm" onClick={()=>void copyLink(invited)}><Copy size={14}/>로그인 링크 복사</Button></div>
      </div>
    </Panel>
    {error&&<div role="alert" className="error-state"><p>{error}</p><Button variant="outline" onClick={()=>void load()}>다시 확인</Button></div>}
    <Panel title="관리자 명단" subtitle="권한을 해제하면 공동 자료 접근이 차단됩니다. 마지막 관리자는 해제할 수 없습니다." action={<Button variant="outline" size="sm" disabled={busy} onClick={()=>void load()}><RefreshCw size={14}/>새로고침</Button>}>
      {!list?<p className="p-5 muted">관리자 목록을 불러오는 중…</p>:<div className="table-scroll"><Table><TableHeader><TableRow><TableHead>Google 계정</TableHead><TableHead>상태</TableHead><TableHead>수락일 · 초대 만료일</TableHead><TableHead>관리</TableHead></TableRow></TableHeader><TableBody>
        {list.members.map(member=><TableRow key={member.id}>
          <TableCell className="font-medium">{member.email}{member.is_self&&<span className="ml-2 text-xs muted">나</span>}</TableCell>
          <TableCell><span className={member.status==='active'?'positive':'muted'}>{statuses[member.status]}</span></TableCell>
          <TableCell>{member.status==='active'&&member.accepted_at?date(member.accepted_at):member.status==='pending'||member.status==='expired'?member.expires_at?`${date(member.expires_at)}까지`:'첫 로그인 대기':'—'}</TableCell>
          <TableCell><div className="flex flex-wrap gap-2">
            {member.status==='pending'&&<Button size="sm" variant="ghost" onClick={()=>void copyLink(member.email)}><Copy size={14}/>링크 복사</Button>}
            {(member.status==='revoked'||member.status==='expired')&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>{setEmail(member.email);setInvited('')}}>다시 초대</Button>}
            {(member.status==='active'||member.status==='pending')&&(member.status==='active'&&activeCount===1?<span className="flex items-center gap-1 text-xs muted"><ShieldCheck size={14}/>마지막 관리자</span>:<AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="ghost" className="negative" disabled={busy}>{member.status==='pending'?'초대 취소':'권한 해제'}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>관리자 권한을 해제할까요?</AlertDialogTitle><AlertDialogDescription>{member.email}의 공동 재무자료 접근을 차단합니다. 이 관리자가 보낸 미수락 초대도 취소됩니다. 저장된 재무자료는 유지됩니다.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>돌아가기</AlertDialogCancel><AlertDialogAction onClick={()=>void revoke(member)}>권한 해제</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>)}
          </div></TableCell>
        </TableRow>)}
      </TableBody></Table></div>}
    </Panel>
    <Panel title="관리자 변경 기록"><div className="audit-list">{list?.events.map((event,index)=><div key={`${event.created_at}-${index}`}><span><strong>{actions[event.action]||event.action}</strong><small>{event.subject_email}{event.actor_email?` · 처리: ${event.actor_email}`:''}</small></span><time>{date(event.created_at)}</time></div>)}</div></Panel>
  </div>;
}
