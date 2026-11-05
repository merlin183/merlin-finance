import {publicConfig,serverClient} from '@/lib/supabase/server';
import {Login} from './login';
import {FinanceApp} from './workspace';
import {AccessGate} from './access-gate';

export async function FinanceRoot({children}:{children:React.ReactNode}){
  const {url,key}=publicConfig();
  if(!url||!key)return <Login url={url} apiKey={key}/>;
  const db=await serverClient();
  const {data:{user}}=await db.auth.getUser();
  if(!user)return <Login url={url} apiKey={key}/>;
  const {data,error}=await db.rpc('fd_admin_context');
  if(error)return <AccessGate email={user.email||''} unavailable/>;
  if(!data?.is_admin)return <AccessGate email={user.email||''}/>;
  return <FinanceApp key={user.id} email={user.email||''} userId={user.id} url={url} apiKey={key}>{children}</FinanceApp>;
}
