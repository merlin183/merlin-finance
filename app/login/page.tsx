import {Login} from '@/components/finance/login';
import {publicConfig} from '@/lib/supabase/server';

export const dynamic='force-dynamic';

export default function LoginPage(){
 const {url,key}=publicConfig();
 return <Login url={url} apiKey={key}/>;
}
