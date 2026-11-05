// Isolated synthetic database: no network, live users or finance records.
import assert from 'node:assert/strict';
import {bootstrapSyntheticWorkspace} from './helpers/bootstrap-workspace.mjs';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');

test('sheet context preserves full matching fields under authenticated shared-owner RLS without reading plan data',async()=>{
 const db=new PGlite(),owner='10000000-0000-4000-8000-000000000001',admin='10000000-0000-4000-8000-000000000002',outsider='10000000-0000-4000-8000-000000000003';
 const keys=['businesses','accounts','categories','rules','aliases','transactions','links','notes'];
 const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
 const asUser=async id=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
 const read=()=>scalar('select public.fd_read_sheet_import_context()');
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
  for(const [id,email] of [[owner,'owner@example.test'],[admin,'admin@example.test'],[outsider,'synthetic-outsider@example.test']]){
   await db.query('insert into auth.users values($1,$2,now())',[id,email]);
   await db.query("insert into auth.identities values($1,'google',$2)",[id,JSON.stringify({email,email_verified:true})]);
  }
  const directory=new URL('../supabase/migrations/',import.meta.url);
  for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
  await bootstrapSyntheticWorkspace(db,owner,'admin@example.test');
  const fn=(await db.query("select prosecdef,provolatile,proconfig,prosrc from pg_proc where oid='public.fd_read_sheet_import_context()'::regprocedure")).rows[0];
  assert.equal(fn.prosecdef,false);assert.equal(fn.provolatile,'s');assert.ok(fn.proconfig.includes('search_path=""'));
  assert.doesNotMatch(fn.prosrc,/fd_read_finance_dataset|fd_read_clobe|cash_plan_series|fd_uploads|fd_audit_log|fd_recurring_items/);
  assert.equal(await scalar("select has_function_privilege('authenticated','public.fd_read_sheet_import_context()','EXECUTE') and not has_function_privilege('anon','public.fd_read_sheet_import_context()','EXECUTE')"),true);
  await assert.rejects(read(),/UNAUTHORIZED/);
  await asUser(admin);await scalar('select public.fd_admin_context()');
  assert.deepEqual(Object.keys(await read()).sort(),[...keys].sort());
  assert.ok(Object.values(await read()).every(rows=>Array.isArray(rows)&&rows.length===0));
  const business=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic business') returning id",[owner]);
  const account=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic bank') returning id",[owner,business]);
  const otherBusiness=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic second business') returning id",[owner]);
  const otherAccount=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic second bank') returning id",[owner,otherBusiness]);
  const category=await scalar("insert into public.fd_categories(owner_id,name,group_name,is_fixed) values($1,'Synthetic expense','영업지출',true) returning id",[owner]);
  const transfer=await scalar("insert into public.fd_categories(owner_id,name,group_name,is_internal) values($1,'Synthetic transfer','내부이동',true) returning id",[owner]);
  await db.query("insert into public.fd_category_rules(owner_id,pattern,field,category_id,account_id,direction) values($1,'Synthetic','description',$2,$3,'out')",[owner,category,account]);
  await db.query("insert into public.fd_gwamok_aliases(owner_id,raw_name,standard_name) values($1,'Synthetic raw','Synthetic expense')",[owner]);
  await db.query(`insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,txn_time,source_sheet,source_row,source_details,amount,direction,description,raw_gwamok,category_id,balance,tax_invoice,dedup_hash,manually_classified)
   select $1,$2,$3,case when n%2=0 then '2025-01-01'::date else '2026-10-01'::date end,'12:34:56','Synthetic source',n,
   jsonb_build_object('basic','Synthetic original','detail','Synthetic detail '||n,'memo','Synthetic memo','provenance',jsonb_build_object('url','https://docs.google.com/spreadsheets/d/synthetic-context-source/edit','sheet','Synthetic source','row',n)),
   n,'out','Synthetic payment '||n,'Synthetic raw',$4,100000-n,n%2=0,'synthetic-context-'||n,n%3=0 from generate_series(1,1005) n`,[owner,business,account,category]);
  const feeRow=await scalar("insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,amount,direction,description,category_id,is_internal,manually_classified,transfer_fee_amount,transfer_fee_category_id,dedup_hash) values($1,$2,$3,'2026-10-01',100500,'out','Synthetic fee allocation',$4,true,true,500,$5,'synthetic-fee') returning id",[owner,business,account,transfer,category]);
  const outgoing=await scalar("insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,amount,direction,description,is_internal,dedup_hash) values($1,$2,$3,'2026-10-01',100,'out','Synthetic transfer out',true,'synthetic-out') returning id",[owner,business,account]);
  const incoming=await scalar("insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,amount,direction,description,is_internal,dedup_hash) values($1,$2,$3,'2026-10-01',100,'in','Synthetic transfer in',true,'synthetic-in') returning id",[owner,otherBusiness,otherAccount]);
  await db.query('insert into public.fd_inter_company_links(owner_id,out_transaction_id,in_transaction_id) values($1,$2,$3)',[owner,outgoing,incoming]);
  await db.query("select public.fd_save_merchant_note($1,'out','exact:synthetic','Synthetic payment','Synthetic shared memo',0)",[account]);
  await db.query("insert into public.fd_businesses(owner_id,name,created_at) values($1,'Synthetic future business',now()+interval '1 day')",[owner]);
  await db.exec('reset role');
  await db.query("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic foreign business')",[outsider]);
  await asUser(admin);
  const full=await scalar('select public.fd_read_finance_dataset()'),context=await read();
  assert.deepEqual(context,Object.fromEntries(keys.map(key=>[key,full[key]])));
  assert.equal(context.transactions.length,1008);assert.equal(context.transactions.filter(t=>t.txn_date<'2026-01-01').length,502);
  assert.equal(context.businesses.length,2);assert.equal(context.notes.length,1);assert.equal(context.links.length,1);
  assert.equal(context.transactions.find(t=>t.id===feeRow).transfer_fee_amount,500);
  assert.equal(context.transactions.find(t=>t.id===feeRow).transfer_fee_category_id,category);
  assert.ok(context.transactions.filter(t=>t.source_row).every(t=>t.txn_time&&t.source_details?.provenance?.url&&typeof t.manually_classified==='boolean'&&typeof t.tax_invoice==='boolean'));
  await asUser(owner);assert.deepEqual(await read(),context);
  await asUser(outsider);await assert.rejects(read(),/ADMIN_REQUIRED/);
  await asUser('');await assert.rejects(read(),/UNAUTHORIZED/);
  await db.exec('reset role;set role anon');await assert.rejects(read(),/permission denied/);
  await db.exec('reset role;revoke select on public.fd_transactions from authenticated');
  await asUser(admin);await assert.rejects(read(),/permission denied/);
  await db.exec('reset role;grant select on public.fd_transactions to authenticated');
  await db.query("update private.finance_administrators set status='revoked' where user_id=$1",[admin]);
  await asUser(admin);await assert.rejects(read(),/ADMIN_REQUIRED/);
  await asUser(owner);assert.deepEqual(await read(),context);
 }finally{await db.close();}
});
