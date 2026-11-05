// Fresh-install and authorization checks in local, in-memory PostgreSQL only.
// Supabase-owned Auth/Storage tables are minimal synthetic service fixtures;
// every application migration and the installer operation run without edits.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {bootstrapWorkspace} from './helpers/bootstrap-workspace.mjs';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const owner='20000000-0000-4000-8000-000000000001';
const outsider='20000000-0000-4000-8000-000000000002';
const missing='20000000-0000-4000-8000-000000000003';
const sqlDirectory=new URL('../supabase/migrations/',import.meta.url);
const bootstrapSql=await readFile(new URL('../supabase/operations/bootstrap_workspace.sql',import.meta.url),'utf8');
const scalar=async(sql,parameters=[])=>Object.values((await db.query(sql,parameters)).rows[0])[0];
const asUser=async id=>{
 await db.exec('reset role');
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
 await db.exec('set role authenticated');
};
let checks=0;
const ok=(condition,label)=>{assert.ok(condition,label);checks++;console.log('PASS',label);};
const denied=async(operation,pattern)=>{await assert.rejects(operation,pattern);checks++;};
// A rejected installer file has an explicit BEGIN; roll its failed transaction
// back so each following assertion observes the actual committed state.
const deniedBootstrap=async(sql,pattern)=>{
 await assert.rejects(db.exec(sql),pattern);
 await db.exec('rollback');
 checks++;
};
const configuredBootstrap=id=>bootstrapSql.replace('REPLACE_WITH_INITIAL_ADMIN_AUTH_USER_UUID',id);
try{
 await db.exec(`
  create role anon;create role authenticated;
  create schema auth;create schema storage;create schema private;
  create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
  create table auth.identities(user_id uuid references auth.users,provider text,identity_data jsonb);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
  grant usage on schema public,auth,storage to authenticated,anon;
  grant select,insert,delete on storage.objects to authenticated;
  -- Some installations inherit broad project defaults. Application SQL must
  -- explicitly revoke them as well as enabling RLS.
  alter default privileges in schema public grant all on tables to anon,authenticated;
  alter default privileges in schema private grant all on tables to anon,authenticated;
 `);
 const migrations=(await readdir(sqlDirectory)).filter(name=>name.endsWith('.sql')).sort();
 for(const name of migrations){
  const source=await readFile(new URL(name,sqlDirectory),'utf8');
  assert.doesNotMatch(source,/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,'migration contains no baked-in user email');
  assert.doesNotMatch(source,/https:\/\/[a-z0-9-]+\.(?:vercel\.app|supabase\.co)\b/i,'migration contains no deployment address');
  await db.exec(source);
 }
 ok(migrations.length>=30&&await scalar('select count(*)::int from auth.users')===0,'every migration installs with no preexisting Auth user');
 ok(await scalar('select count(*)::int from private.finance_workspace')===0&&await scalar('select count(*)::int from private.finance_administrators')===0,'schema installation creates no workspace or implicit administrator');
 const requiredFunctions=['fd_admin_context','fd_admin_invite','fd_apply_sheet_import','fd_read_finance_snapshot','fd_read_cash_plan_edits','fd_read_cash_plan_series','fd_apply_classification_review','fd_set_transaction_transfer_fee','fd_clobe_auth','fd_clobe_import','fd_clobe_plan_actuals_sync','fd_read_intercompany_register','fd_toss_settlements_read'];
 const installed=(await db.query("select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=any($1::text[])",[requiredFunctions])).rows.map(row=>row.proname);
 ok(requiredFunctions.every(name=>installed.includes(name)),'complete finance, import, planning and optional integration RPCs remain installed');
 const tables=(await db.query(`select c.oid::regclass::text as name,c.relrowsecurity,
   has_table_privilege('anon',c.oid,'select,insert,update,delete') as anonymous_access
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname in ('public','private') and c.relkind in ('r','p')
    and (left(c.relname,3)='fd_' or c.relname like 'finance_%')`)).rows;
 ok(tables.length>=20&&tables.every(table=>table.relrowsecurity&&!table.anonymous_access),'all application tables have RLS and no anonymous grants despite broad defaults');
 const exposedDefiners=await scalar("select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and left(p.proname,3)='fd_' and p.prosecdef");
 ok(exposedDefiners===0,'application public RPCs preserve SECURITY INVOKER');
 await deniedBootstrap(bootstrapSql,/BOOTSTRAP_USER_REQUIRED/);
 await deniedBootstrap(configuredBootstrap(missing),/BOOTSTRAP_VERIFIED_GOOGLE_USER_REQUIRED/);

 for(const [id,email] of [[owner,'installer@example.test'],[outsider,'outsider@example.test']]){
  await db.query('insert into auth.users values($1,$2,now())',[id,email]);
  await db.query("insert into auth.identities values($1,'google',$2)",[id,JSON.stringify({email,email_verified:true})]);
 }
 await db.exec('set role anon');
 await denied(db.query('select public.fd_admin_context()'),/permission denied/);
 await deniedBootstrap(configuredBootstrap(owner),/BOOTSTRAP_TRUSTED_SQL_REQUIRED/);
 await asUser(outsider);
 ok((await scalar('select public.fd_admin_context()')).is_admin===false,'first verified Google login does not become administrator');
 await denied(db.query('select public.fd_admin_invite($1)',['outsider@example.test']),/ADMIN_REQUIRED/);
 await denied(db.query('select * from private.finance_workspace'),/permission denied/);
 await deniedBootstrap(configuredBootstrap(outsider),/BOOTSTRAP_TRUSTED_SQL_REQUIRED/);
 await asUser(owner);
 ok((await scalar('select public.fd_admin_context()')).is_admin===false,'intended administrator also remains unauthorized until trusted bootstrap');
 ok(await scalar('select count(*)::int from public.fd_businesses')===0,'an authenticated user cannot see finance data before bootstrap');
 await denied(db.query("insert into public.fd_businesses(owner_id,name) values($1,'Not authorized')",[owner]),/row-level security/);
 await denied(db.query('select public.fd_read_finance_snapshot()'),/ADMIN_REQUIRED/);
 await db.exec('reset role');
 ok(await scalar('select count(*)::int from private.finance_workspace')===0,'normal login and rejected attempts leave the installation uninitialized');
 await db.query('update auth.users set email_confirmed_at=null where id=$1',[owner]);
 await deniedBootstrap(configuredBootstrap(owner),/BOOTSTRAP_VERIFIED_GOOGLE_USER_REQUIRED/);
 await db.query('update auth.users set email_confirmed_at=now() where id=$1',[owner]);
 await db.query("update auth.identities set identity_data=jsonb_set(identity_data,'{email_verified}','false') where user_id=$1",[owner]);
 await deniedBootstrap(configuredBootstrap(owner),/BOOTSTRAP_VERIFIED_GOOGLE_USER_REQUIRED/);
 await db.query("update auth.identities set identity_data=$2 where user_id=$1",[owner,JSON.stringify({email:'mismatched@example.test',email_verified:true})]);
 await deniedBootstrap(configuredBootstrap(owner),/BOOTSTRAP_VERIFIED_GOOGLE_USER_REQUIRED/);
 await db.query("update auth.identities set identity_data=$2 where user_id=$1",[owner,JSON.stringify({email:'installer@example.test',email_verified:true})]);
 await db.query("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic preexisting business')",[outsider]);
 await deniedBootstrap(configuredBootstrap(owner),/BOOTSTRAP_FOREIGN_DATA/);
 ok(await scalar('select count(*)::int from private.finance_workspace')===0,'foreign-data rejection is atomic');
 await db.query('delete from public.fd_businesses where owner_id=$1',[outsider]);
 await db.query("insert into storage.objects(bucket_id,name) values('finance-uploads',$1)",[`${outsider}/synthetic.csv`]);
 await deniedBootstrap(configuredBootstrap(owner),/BOOTSTRAP_FOREIGN_FILES/);
 await db.query('delete from storage.objects');

 await bootstrapWorkspace(db,owner);
 ok(await scalar('select data_owner_id from private.finance_workspace')===owner,'trusted installer creates the chosen single shared namespace');
 ok(await scalar("select count(*)::int from private.finance_administrators where user_id=$1 and email='installer@example.test' and status='active' and not bootstrap",[owner])===1,'only the selected verified Google user receives the initial administrator membership');
 ok(await scalar('select count(*)::int from private.finance_admin_events')===1,'trusted bootstrap records one audit event');
 await deniedBootstrap(configuredBootstrap(outsider),/BOOTSTRAP_ALREADY_INITIALIZED/);
 ok(await scalar('select data_owner_id from private.finance_workspace')===owner,'bootstrap cannot replace the established workspace or administrator');
 await asUser(owner);
 ok((await scalar('select public.fd_admin_context()')).owner_id===owner,'chosen administrator receives the shared namespace through the unchanged context RPC');
 await db.query("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic installed business')",[owner]);
 await db.query("insert into storage.objects(bucket_id,name) values('finance-uploads',$1)",[`${owner}/synthetic.csv`]);
 const snapshot=await scalar('select public.fd_read_finance_snapshot()');
 ok(snapshot.businesses.length===1,'newly installed administrator can use the existing finance read and write path');
 const self=(await scalar('select public.fd_admin_list()')).members.find(member=>member.is_self);
 await denied(db.query('select public.fd_admin_revoke($1)',[self.id]),/LAST_ADMIN/);
 await asUser(outsider);
 ok((await scalar('select public.fd_admin_context()')).is_admin===false,'an uninvited user stays unauthorized after bootstrap');
 ok(await scalar('select count(*)::int from public.fd_businesses')===0&&await scalar('select count(*)::int from storage.objects')===0,'RLS denies the outsider both installed finance rows and uploads');
 await denied(db.query('select public.fd_admin_list()'),/ADMIN_REQUIRED/);
 await denied(db.query("insert into public.fd_businesses(owner_id,name) values($1,'Forbidden namespace')",[outsider]),/row-level security/);
 await asUser(owner);await db.query('select public.fd_admin_invite($1)',['outsider@example.test']);
 await asUser(outsider);
 ok((await scalar('select public.fd_admin_context()')).owner_id===owner,'explicit administrator invitations still share the existing installation namespace');
 ok(await scalar('select count(*)::int from public.fd_businesses')===1,'invited administrator reads the same business without duplicating storage ownership');
 console.log(`All ${checks} open-source installation checks passed.`);
}finally{await db.close();}
