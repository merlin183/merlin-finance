// Synthetic local PostgreSQL only. No production identifiers or connections.
import assert from 'node:assert/strict';
import {bootstrapSyntheticWorkspace} from './helpers/bootstrap-workspace.mjs';
import {readFile,readdir} from 'node:fs/promises';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const owner='10000000-0000-4000-8000-000000000001',admin='10000000-0000-4000-8000-000000000002',outsider='10000000-0000-4000-8000-000000000003';
let checks=0;
const ok=(condition,label)=>{assert.ok(condition,label);checks++;};
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const asUser=async id=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
const denied=async(operation,pattern)=>{await assert.rejects(operation,pattern);checks++;};
try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid references auth.users,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;
 create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
 grant usage on schema public,auth,storage to authenticated,anon;grant select,insert,delete on storage.objects to authenticated;`);
 for(const [id,email] of [[owner,'owner@example.test'],[admin,'admin@example.test'],[outsider,'outsider@example.test']]){
  await db.query('insert into auth.users values($1,$2,now())',[id,email]);
  await db.query("insert into auth.identities values($1,'google',$2)",[id,JSON.stringify({email,email_verified:true})]);
 }
 const directory=new URL('../supabase/migrations/',import.meta.url);
 for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort()){
  let sql=await readFile(new URL(name,directory),'utf8');
  await db.exec(sql);
 }
 await bootstrapSyntheticWorkspace(db,owner,'admin@example.test');
 await asUser(admin);await scalar('select public.fd_admin_context()');
 const business=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic company') returning id",[owner]);
 const secondBusiness=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic other company') returning id",[owner]);
 const account=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic bank') returning id",[owner,business]);
 const secondAccount=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic other bank') returning id",[owner,secondBusiness]);
 const tid=await scalar("insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,amount,direction,description,dedup_hash) values($1,$2,$3,'2026-10-01',10,'out','Synthetic original','synthetic-plan-series') returning id",[owner,business,account]);
 const ledgerBefore=await scalar('select to_jsonb(t) from public.fd_transactions t where id=$1',[tid]);
 const insert=(extra={})=>{
  const item={id:crypto.randomUUID(),owner_id:owner,business_id:business,source_type:'estimated',source_key:crypto.randomUUID(),title:'Synthetic recurring budget',account_id:account,monthly_amount:100,start_month:'2026-11',end_month:null,day:null,kind:'operating',memo:'Synthetic note',amount_overrides:{},...extra};
  const columns='id,owner_id,business_id,source_type,source_key,title,account_id,monthly_amount,start_month,end_month,day,kind,memo,amount_overrides';
  return scalar(`insert into public.fd_cash_plan_series(${columns}) select ${columns.split(',').map(column=>'r.'+column).join(',')} from jsonb_populate_record(null::public.fd_cash_plan_series,$1) r returning id`,[JSON.stringify(item)]);
 };
 ok((await scalar('select public.fd_read_cash_plan_series()')).length===0,'empty schedules are an explicit array');
 const id=await insert();
 let rows=await scalar('select public.fd_read_cash_plan_series()');
 ok(rows.length===1&&rows[0].day===null&&rows[0].end_month===null,'nullable payment day and perpetual monthly budget persist');
 ok(!('owner_id' in rows[0])&&!('updated_by' in rows[0]),'read projection excludes private ownership metadata');
 ok(await scalar('select updated_by from public.fd_cash_plan_series where id=$1',[id])===admin,'authenticated actor is recorded');
 const manual=crypto.randomUUID();
 await insert({id:manual,source_type:'manual',source_key:manual,monthly_amount:30,day:18,kind:'installment',end_month:'2027-01',amount_overrides:{'2027-01':29}});
 rows=await scalar('select public.fd_read_cash_plan_series()');
 ok(rows.length===2&&rows.some(row=>row.amount_overrides['2027-01']===29),'finite schedule retains the final payment adjustment');
 const dataset=await scalar('select public.fd_read_finance_dataset()');
 assert.deepEqual(dataset.cash_plan_series,rows);checks++;
 ok(dataset.transactions.length===1&&dataset.businesses.length===2,'single dataset includes schedules and preserves original resources');
 await denied(()=>insert({account_id:secondAccount}),/foreign key/);
 await denied(()=>insert({owner_id:outsider}),/row-level security/);
 await denied(()=>insert({source_type:'manual'}),/check constraint/);
 for(const extra of [{monthly_amount:-1},{day:0},{end_month:'2026-10'},{amount_overrides:{'2026-10':1}},{amount_overrides:{'2026-11':1.5}},{amount_overrides:{'2026-11':-1}},{amount_overrides:{'2026-11':'100'}},{amount_overrides:[]},{amount_overrides:{'2026-11':9007199254740992}}])await denied(()=>insert(extra),/check constraint/);
 await denied(()=>db.query('update public.fd_cash_plan_series set monthly_amount=110 where id=$1',[id]),/CASH_PLAN_SERIES_STALE/);
 await denied(()=>db.query("update public.fd_cash_plan_series set source_key='changed',version=version+1 where id=$1",[id]),/CASH_PLAN_SERIES_IDENTITY_IMMUTABLE/);
 await db.query('update public.fd_cash_plan_series set monthly_amount=110,version=version+1 where id=$1',[id]);
 ok(await scalar('select monthly_amount from public.fd_cash_plan_series where id=$1',[id])===110,'versioned budget update is allowed');
 await asUser(owner);ok((await scalar('select public.fd_read_cash_plan_series()')).length===2,'second authorized administrator shares the same schedule data');
 await asUser(outsider);await denied(()=>scalar('select public.fd_read_cash_plan_series()'),/ADMIN_REQUIRED/);
 await db.exec('reset role;set role anon');await denied(()=>scalar('select public.fd_read_cash_plan_series()'),/permission denied/);await denied(()=>db.query('select * from public.fd_cash_plan_series'),/permission denied/);
 await db.exec('reset role');
 const fn=(await db.query("select prosecdef,provolatile from pg_proc where oid='public.fd_read_cash_plan_series()'::regprocedure")).rows[0];
 ok(fn.prosecdef===false&&fn.provolatile==='s','read function is stable SECURITY INVOKER');
 ok(await scalar("select relrowsecurity from pg_class where oid='public.fd_cash_plan_series'::regclass"),'RLS is enabled');
 const definition=await scalar("select pg_get_functiondef('public.fd_read_finance_dataset()'::regprocedure)");
 ok(definition.includes("'cash_plan_series',public.fd_read_cash_plan_series()"),'dataset uses the same authenticated source RPC');
 const migration=await readFile(new URL('../supabase/migrations/20261028031740_cash_plan_series.sql',import.meta.url),'utf8');
 const guard=migration.slice(migration.indexOf('do $$declare definition text;'),migration.indexOf("notify pgrst"));
 await denied(()=>db.exec(guard),/CASH_PLAN_SERIES_DATASET_ANCHOR_MISSING/);
 const anchor=definition.replace("  'cash_plan_series',public.fd_read_cash_plan_series(),\n",'').replace("  'audit',","  'other-audit',");
 await db.exec(anchor);
 await denied(()=>db.exec(guard),/CASH_PLAN_SERIES_DATASET_ANCHOR_MISSING/);
 ok(await scalar("select pg_get_functiondef('public.fd_read_finance_dataset()'::regprocedure)")===anchor,'missing or duplicate anchor leaves dataset definition unchanged');
 assert.deepEqual(await scalar('select to_jsonb(t) from public.fd_transactions t where id=$1',[tid]),ledgerBefore);checks++;
 console.log(`All ${checks} cash-plan-series storage checks passed.`);
}finally{await db.close();}
