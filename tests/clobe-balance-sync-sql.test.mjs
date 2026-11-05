// Synthetic local PostgreSQL only. No real accounts, credentials or network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
test('signed collected balances preserve the ledger, shared-admin isolation and monotonic source observations',async()=>{
 const db=new PGlite(),owner='10000000-0000-4000-8000-000000000001',admin='10000000-0000-4000-8000-000000000002',outsider='10000000-0000-4000-8000-000000000003';
 const business='20000000-0000-4000-8000-000000000001',account='20000000-0000-4000-8000-000000000002',second='20000000-0000-4000-8000-000000000003',foreign='20000000-0000-4000-8000-000000000004';
 const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];let key,actor=admin;
 const asUser=async(id=admin)=>{actor=id;await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
 const row=(patch={})=>({company_id:'synthetic-company',external_account_id:'1',account_id:account,balance:900,balance_date:'2026-10-01',collected_at:'2026-10-01T10:00:00',...patch});
 const proof=(wire,purpose='balance-sync',forActor=actor,forOwner=owner)=>createHmac('sha256',key).update(`merlin:clobe-import:v1\n${purpose}\n${forActor}\n${forOwner}\n${wire}`).digest('hex');
 const sync=async(rows,options={})=>{const wire=JSON.stringify({snapshots:rows});return scalar('select public.fd_clobe_balance_sync($1,$2)',[wire,options.proof??proof(wire,options.purpose,options.actor,options.owner)]);};
 const rawState=()=>scalar("select jsonb_build_object('accounts',(select jsonb_agg(to_jsonb(a) order by a.id) from public.fd_accounts a),'transactions',(select jsonb_agg(to_jsonb(t) order by t.id) from public.fd_transactions t),'notes',(select jsonb_agg(to_jsonb(n)) from private.synthetic_notes n),'plans',(select jsonb_agg(to_jsonb(p)) from private.synthetic_plans p))");
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
   create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create table private.synthetic_admins(user_id uuid primary key,owner_id uuid not null,active boolean not null default true);
   create function private.finance_workspace_owner() returns uuid language sql stable security definer set search_path='' as $$select owner_id from private.synthetic_admins where user_id=auth.uid() and active$$;
   grant usage on schema public,private,auth to authenticated,anon;
   create table public.fd_accounts(id uuid primary key,owner_id uuid not null,business_id uuid not null,opening_balance bigint not null default 0,unique(owner_id,id),unique(owner_id,business_id,id));
   create table public.fd_categories(id uuid primary key,owner_id uuid not null,name text not null,is_internal boolean not null default false);
   create table public.fd_transactions(id uuid primary key,owner_id uuid not null,business_id uuid not null,account_id uuid not null,upload_id uuid,txn_date date not null,txn_time text,amount bigint not null,direction text not null,description text not null,raw_gwamok text not null,category_id uuid,is_internal boolean not null,balance bigint,tax_invoice boolean not null,dedup_hash text not null,manually_classified boolean not null,source_details jsonb,unique(owner_id,id),unique(account_id,dedup_hash));
   create table public.fd_audit_log(owner_id uuid,action text,detail text);
   create function private.fd_valid_source_details(v jsonb) returns boolean language sql immutable as $$select v is null or v='null'::jsonb or jsonb_typeof(v)='object'$$;
   create table private.synthetic_notes(memo text);insert into private.synthetic_notes values('Keep manual note');
   create table private.synthetic_plans(amount bigint);insert into private.synthetic_plans values(10000);
   create function public.fd_read_finance_dataset() returns jsonb language plpgsql stable security invoker set search_path='' as $$begin
    if auth.uid() is null or private.finance_workspace_owner() is null then raise exception 'ADMIN_REQUIRED';end if;
    return jsonb_build_object(
  'audit','[]'::jsonb);end$$;
   revoke all on function public.fd_read_finance_dataset() from public,anon;grant execute on function public.fd_read_finance_dataset() to authenticated;
   alter default privileges in schema private grant all on tables to anon,authenticated;`);
  for(const id of [owner,admin,outsider])await db.query('insert into auth.users values($1)',[id]);
  await db.query('insert into private.synthetic_admins(user_id,owner_id) values($1,$1),($2,$1)',[owner,admin]);
  await db.query('insert into public.fd_accounts(id,owner_id,business_id,opening_balance) values($1,$2,$3,500),($4,$2,$3,700),($5,$6,$3,200)',[account,owner,business,second,foreign,outsider]);
  await db.query("insert into public.fd_transactions(id,owner_id,business_id,account_id,txn_date,txn_time,amount,direction,description,raw_gwamok,is_internal,balance,tax_invoice,dedup_hash,manually_classified,source_details) values('30000000-0000-4000-8000-000000000001',$1,$2,$3,'2026-10-01',null,100,'out','Saved original','Manual classification',false,400,true,'saved-hash',true,'{\"memo\":\"Keep original\"}')",[owner,business,account]);
  await db.exec(await readFile(new URL('../supabase/migrations/20261007055220_clobe_append_import.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261008012613_clobe_balance_snapshots.sql',import.meta.url),'utf8'));
  key=Buffer.from(await scalar('select signing_key from private.fd_clobe_import_verifier where singleton'),'base64');
  await db.query("insert into private.fd_clobe_account_mappings(owner_id,company_id,external_account_id,account_id) values($1,'synthetic-company','1',$2),($1,'synthetic-company','2',$3)",[owner,account,second]);
  const original=await rawState();
  assert.equal(await scalar("select relrowsecurity from pg_class where oid='private.fd_clobe_balance_snapshots'::regclass"),true);
  for(const role of ['anon','authenticated'])assert.equal(await scalar(`select has_table_privilege('${role}','private.fd_clobe_balance_snapshots','SELECT')`),false);
  const functions=(await db.query("select n.nspname,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('fd_clobe_balance_sync','fd_clobe_balance_sync_core','fd_read_clobe_balance_snapshots','fd_read_finance_dataset')")).rows;
  assert.ok(functions.every(f=>f.proconfig.includes('search_path=""')));assert.equal(functions.find(f=>f.proname==='fd_clobe_balance_sync').prosecdef,false);assert.equal(functions.find(f=>f.proname==='fd_read_finance_dataset').prosecdef,false);
  assert.equal(await scalar("select has_function_privilege('anon','public.fd_clobe_balance_sync(text,text)','EXECUTE')"),false);
  await asUser();await assert.rejects(()=>db.query('select * from private.fd_clobe_balance_snapshots'),/permission denied/);
  assert.deepEqual(await scalar('select public.fd_read_finance_dataset()'),{audit:[],balance_snapshots:[]});
  assert.deepEqual(await sync([]),{synced:0,unchanged:0,skipped:[]});
  await assert.rejects(()=>sync([row()],{proof:'0'.repeat(64)}),/UNTRUSTED/);
  for(const options of [{purpose:'apply'},{actor:owner},{owner:outsider}])await assert.rejects(()=>sync([row()],options),/UNTRUSTED/);
  assert.deepEqual(await sync([row()]),{synced:1,unchanged:0,skipped:[]});
  let projected=await scalar('select public.fd_read_finance_dataset()');assert.equal(projected.balance_snapshots.length,1);
  const first=projected.balance_snapshots[0];assert.equal(first.balance,900);assert.equal(first.collected_at,'2026-10-01T10:00:00');assert.equal(first.balance_date,'2026-10-01');assert.equal(first.currency,'KRW');assert.equal(first.business_id,business);assert.ok(!('company_id' in first)&&!('collected_order' in first)&&!('owner_id' in first));
  assert.deepEqual(await sync([row()]),{synced:0,unchanged:1,skipped:[]});
  const older=await sync([row({balance:100,collected_at:'2026-10-01T09:00:00'})]);assert.equal(older.synced,0);assert.equal(older.skipped.length,1);
  const conflict=await sync([row({balance:1})]);assert.equal(conflict.synced,0);assert.equal(conflict.skipped.length,1);
  projected=await scalar('select public.fd_read_finance_dataset()');assert.deepEqual(projected.balance_snapshots[0],first);
  assert.equal((await sync([row({balance:1200,collected_at:'2026-10-02T11:00:00',balance_date:'2026-10-02'})])).synced,1);
  assert.equal((await scalar('select public.fd_read_finance_dataset()')).balance_snapshots[0].balance,1200);
  await assert.rejects(()=>sync([row({balance:1.5})]),/INVALID_PAYLOAD/);
  await assert.rejects(()=>sync([row({balance:9007199254740992})]),/INVALID_PAYLOAD/);
  await assert.rejects(()=>sync([row({currency:'USD'})]),/INVALID_PAYLOAD/);
  await assert.rejects(()=>sync([row({balance_date:'2026-10-02'})]),/INVALID_PAYLOAD/);
  await assert.rejects(()=>sync([row(),row()]),/INVALID_PAYLOAD/);
  await assert.rejects(()=>sync([row({collected_at:'2026-02-30T10:00:00',balance_date:'2026-02-30'})]),/date|range|INVALID_PAYLOAD/i);
  const beforeAtomic=await scalar('select public.fd_read_finance_dataset()');
  await assert.rejects(()=>sync([row({external_account_id:'2',account_id:second}),row({account_id:foreign,external_account_id:'3'})]),/SCOPE/);
  assert.deepEqual(await scalar('select public.fd_read_finance_dataset()'),beforeAtomic);
  await asUser(owner);assert.deepEqual(await scalar('select public.fd_read_finance_dataset()'),beforeAtomic);
  // Separate cash-plan bank observations, with no ledger/classification writes.
  await db.exec('reset role');
  await db.exec(await readFile(new URL('../supabase/migrations/20261013044017_clobe_plan_bank_actuals.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261102033417_sync_recent_month_plan_evidence.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261102034232_normalize_plan_evidence_source_spacing.sql',import.meta.url),'utf8'));
  for(const table of ['fd_clobe_plan_coverage','fd_clobe_plan_actuals']){
   assert.equal(await scalar(`select relrowsecurity from pg_class where oid='private.${table}'::regclass`),true);
   for(const role of ['anon','authenticated'])assert.equal(await scalar(`select has_table_privilege('${role}','private.${table}','SELECT')`),false);
  }
  const planFns=(await db.query("select n.nspname,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('fd_clobe_plan_actuals_sync','fd_clobe_plan_actuals_sync_core','fd_read_clobe_plan_coverage','fd_read_clobe_plan_actuals')")).rows;
  assert.ok(planFns.every(fn=>fn.proconfig.includes('search_path=""')));assert.equal(planFns.find(fn=>fn.proname==='fd_clobe_plan_actuals_sync').prosecdef,false);
  await asUser();
  const evidence={external_transaction_id:'10',txn_date:'2026-10-01',txn_time:'09:00:00',amount:100,balance:400,description:'Saved original',party:null,source_details:{basic:'Saved original'}};
  const scope={company_id:'synthetic-company',external_account_id:'1',account_id:account,from:'2026-10-01',to:'2026-10-02',collected_at:'2026-10-02T11:00:00',status:'complete',reason:null,rows:[evidence]};
  const actualSync=async(scopes,opts={})=>{
   const stamp=Date.now(),body={issued_at:new Date(stamp).toISOString(),expires_at:new Date(stamp+300000).toISOString(),scopes,...opts.body},wire=JSON.stringify(body);
   return scalar('select public.fd_clobe_plan_actuals_sync($1,$2)',[wire,opts.proof??proof(wire,opts.purpose??'plan-actuals-sync',opts.actor,opts.owner)]);
  };
  await assert.rejects(()=>db.query('select * from private.fd_clobe_plan_actuals'),/permission denied/);
  await assert.rejects(()=>actualSync([scope],{proof:'0'.repeat(64)}),/UNTRUSTED/);
  for(const opts of [{purpose:'balance-sync'},{actor:owner},{owner:outsider}])await assert.rejects(()=>actualSync([scope],opts),/UNTRUSTED/);
  await assert.rejects(()=>actualSync([scope],{body:{expires_at:new Date(Date.now()-1000).toISOString()}}),/EXPIRED/);
  await assert.rejects(()=>actualSync([scope],{body:{issued_at:new Date(Date.now()+3600000).toISOString(),expires_at:new Date(Date.now()+3900000).toISOString()}}),/EXPIRED/);
  assert.deepEqual(await actualSync([scope]),{synced_accounts:1,unchanged_accounts:0,saved_outflows:1,skipped:[]});
  let bankData=await scalar('select public.fd_read_finance_dataset()'),firstActual=bankData.bank_plan_actuals[0];
  assert.equal(bankData.bank_plan_coverage[0].status,'complete');assert.equal(firstActual.amount,100);assert.equal(firstActual.currency,'KRW');assert.equal(firstActual.source_details.basic,'Saved original');assert.equal(firstActual.transaction_id,null);
  assert.ok(!('owner_id' in firstActual)&&!('company_id' in firstActual));
  // A same-provider ledger reference must remain visible on conflicting time,
  // so the shared model can hold the conflict instead of double-counting it.
  await db.exec('reset role');
  await db.query("insert into private.fd_clobe_transaction_refs(owner_id,company_id,external_account_id,external_transaction_id,account_id,transaction_id,source_fingerprint) values($1,'synthetic-company','1','10',$2,'30000000-0000-4000-8000-000000000001',$3)",[owner,account,'0'.repeat(64)]);
  await asUser();bankData=await scalar('select public.fd_read_finance_dataset()');
  assert.equal(bankData.bank_plan_actuals[0].transaction_id,'30000000-0000-4000-8000-000000000001');
  firstActual=bankData.bank_plan_actuals[0];
  assert.deepEqual(await actualSync([scope]),{synced_accounts:0,unchanged_accounts:1,saved_outflows:1,skipped:[]});
  const badRows=[{...evidence,amount:0},{...evidence,amount:0.5},{...evidence,amount:9007199254740992},{...evidence,txn_date:'2026-10-03'},{...evidence,txn_time:'24:00:00'},{...evidence,source_details:{provenance:'forbidden'}},{...evidence,balance:9007199254740992}];
  for(const bad of badRows)await assert.rejects(()=>actualSync([{...scope,rows:[bad]}]),/INVALID_PAYLOAD/);
  await assert.rejects(()=>actualSync([{...scope,rows:[evidence,evidence]}]),/INVALID_PAYLOAD/);
  await assert.rejects(()=>actualSync([{...scope,rows:[evidence,{...evidence,external_transaction_id:'11'}]}]),/INVALID_PAYLOAD/);
  await assert.rejects(()=>actualSync([{...scope,account_id:foreign,external_account_id:'3'}]),/SCOPE/);
  await assert.rejects(()=>actualSync([{...scope,owner_id:outsider}]),/INVALID_PAYLOAD/);
  const failedScope={...scope,status:'confirmation-needed',reason:'Synthetic interrupted page',rows:[]};
  assert.equal((await actualSync([failedScope])).skipped.length,1);
  bankData=await scalar('select public.fd_read_finance_dataset()');assert.deepEqual(bankData.bank_plan_actuals,[firstActual]);assert.equal(bankData.bank_plan_coverage[0].status,'confirmation-needed');assert.equal(bankData.bank_plan_coverage[0].collected_at,scope.collected_at);
  assert.equal((await actualSync([scope])).unchanged_accounts,1);
  assert.equal((await actualSync([{...scope,rows:[{...evidence,amount:101}]}])).skipped.length,1);
  bankData=await scalar('select public.fd_read_finance_dataset()');assert.deepEqual(bankData.bank_plan_actuals,[firstActual]);
  // A later collection cannot rewrite a previously observed bank ID or drop it.
  await db.exec('reset role');await db.query("update private.fd_clobe_balance_snapshots set balance_date='2026-10-03',collected_at='2026-10-03T11:00:00',collected_order='2026-10-03T02:00:00Z' where account_id=$1",[account]);await asUser();
  const laterScope={...scope,to:'2026-10-03',collected_at:'2026-10-03T11:00:00'};
  assert.equal((await actualSync([{...laterScope,rows:[{...evidence,description:'Different counterparty'}]}])).skipped.length,1);
  assert.equal((await actualSync([{...laterScope,rows:[]}])).skipped.length,1);
  assert.deepEqual((await scalar('select public.fd_read_finance_dataset()')).bank_plan_actuals,[firstActual]);
  assert.equal((await actualSync([laterScope])).synced_accounts,1);
  // Preserve previous months when the current monthly scope is refreshed.
  await db.exec('reset role');await db.query("update private.fd_clobe_balance_snapshots set balance_date='2026-09-15',collected_at='2026-09-15T11:00:00',collected_order='2026-09-15T02:00:00Z' where account_id=$1",[account]);await asUser();
  const september={...scope,from:'2026-09-01',to:'2026-09-15',collected_at:'2026-09-15T11:00:00',rows:[{...evidence,external_transaction_id:'9',txn_date:'2026-09-01'}]};
  assert.equal((await actualSync([september])).synced_accounts,1);bankData=await scalar('select public.fd_read_finance_dataset()');assert.equal(bankData.bank_plan_actuals.length,2);assert.equal(bankData.bank_plan_coverage.length,2);
  await db.exec('reset role');await db.query("update private.fd_clobe_balance_snapshots set balance_date='2026-10-03',collected_at='2026-10-03T11:00:00',collected_order='2026-10-03T02:00:00Z' where account_id=$1",[account]);await asUser();
  assert.equal((await actualSync([laterScope])).unchanged_accounts,1);assert.equal((await scalar('select public.fd_read_finance_dataset()')).bank_plan_actuals.length,2);
  await asUser(owner);assert.equal((await scalar('select public.fd_read_finance_dataset()')).bank_plan_actuals.length,2);
  await db.exec('reset role');assert.deepEqual(await rawState(),original);await asUser();
  const stateBeforeBadBatch=await scalar('select public.fd_read_finance_dataset()');
  await assert.rejects(()=>actualSync([laterScope,{...scope,account_id:foreign,external_account_id:'3'}]),/SCOPE/);assert.deepEqual(await scalar('select public.fd_read_finance_dataset()'),stateBeforeBadBatch);
  await asUser(outsider);await assert.rejects(()=>actualSync([scope]),/ADMIN_REQUIRED/);await assert.rejects(()=>scalar('select private.fd_read_clobe_plan_actuals()'),/ADMIN_REQUIRED/);
  await db.exec('reset role');await db.query('update private.synthetic_admins set active=false where user_id=$1',[admin]);await asUser();await assert.rejects(()=>actualSync([scope]),/ADMIN_REQUIRED/);await db.exec('reset role');await db.query('update private.synthetic_admins set active=true where user_id=$1',[admin]);
  await asUser(outsider);await assert.rejects(()=>sync([row()]),/ADMIN_REQUIRED/);await assert.rejects(()=>scalar('select private.fd_read_clobe_balance_snapshots()'),/ADMIN_REQUIRED/);
  await db.exec('reset role;set role anon');await assert.rejects(()=>scalar('select public.fd_clobe_balance_sync($1,$2)',['{}','0'.repeat(64)]),/permission denied/);
  await db.exec('reset role');assert.deepEqual(await rawState(),original);
  assert.equal(await scalar("select count(*) from public.fd_audit_log where action='clobe_balance_sync'"),2);
  await db.query('delete from private.fd_clobe_account_mappings where owner_id=$1 and account_id=$2',[owner,account]);await asUser();
  assert.deepEqual((await scalar('select public.fd_read_finance_dataset()')).balance_snapshots,[]);
  assert.deepEqual((await scalar('select public.fd_read_finance_dataset()')).bank_plan_actuals,[]);assert.deepEqual((await scalar('select public.fd_read_finance_dataset()')).bank_plan_coverage,[]);
 }finally{await db.close();}
});
