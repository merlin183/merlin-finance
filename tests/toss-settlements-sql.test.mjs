import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac,randomUUID} from 'node:crypto';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');

test('Toss settlement storage is admin-scoped, proof-bound, atomic and idempotent without touching bank cash or plans',async()=>{
 const db=new PGlite(),owner='10000000-0000-4000-8000-000000000001',admin='10000000-0000-4000-8000-000000000002',outsider='10000000-0000-4000-8000-000000000003';
 const business='20000000-0000-4000-8000-000000000001',account='30000000-0000-4000-8000-000000000001',other='30000000-0000-4000-8000-000000000002',key=Buffer.alloc(32,13);
 let actor=admin,run=randomUUID();
 const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
 const asUser=async(id=admin)=>{actor=id;await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
 const wireProof=(action,wire,forActor=actor,forOwner=owner)=>createHmac('sha256',key).update(`merlin:clobe-import:v1\ntoss-settlements-${action}\n${forActor}\n${forOwner}\n${wire}`).digest('hex');
 const call=async(action,payload,opts={})=>{const wire=JSON.stringify(payload);return scalar('select public.fd_toss_settlements_sync($1,$2,$3)',[action,wire,opts.proof??wireProof(action,wire,opts.actor,opts.owner)]);};
 const meta=()=>({run_id:run,issued_at:new Date().toISOString()});
 const merchant={merchantId:'synthetic-mid',businessId:business,accountId:account,label:'합성 상점'};
 const row=(patch={})=>({merchant_id:'synthetic-mid',transaction_key:'opaque-a',payment_key:'opaque-pay',business_id:business,account_id:account,paid_out_date:'2026-11-05',sold_date:'2026-11-01',amount:1000,pay_out_amount:970,fee_amount:30,synced_at:new Date().toISOString(),...patch});
 const save=(rows,patch={})=>call('save',{...meta(),from:'2026-10-01',to:'2027-01-31',merchants:[merchant],settlements:rows,...patch});
 const reader=()=>scalar('select public.fd_toss_settlements_read()');
 const resetCooldown=async()=>{await db.exec('reset role');await db.query("update private.fd_toss_sync_state set started_at=clock_timestamp()-interval '21 seconds' where owner_id=$1",[owner]);await asUser();run=randomUUID();};
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
   create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create table private.admins(id uuid primary key,owner_id uuid not null);
   create function private.finance_workspace_owner() returns uuid language sql stable security definer set search_path='' as $$select owner_id from private.admins where id=auth.uid()$$;
   grant usage on schema public,auth,private to anon,authenticated;
   create table public.fd_accounts(owner_id uuid,id uuid,business_id uuid,opening_balance bigint,primary key(id),unique(owner_id,business_id,id));
   create table public.fd_transactions(id integer,amount bigint,description text);insert into public.fd_transactions values(1,500,'Original bank deposit');
   create table private.synthetic_plans(amount bigint,memo text);insert into private.synthetic_plans values(900,'Preserve edited plan');
   create table public.fd_audit_log(owner_id uuid,action text,detail text);
   create table private.fd_clobe_import_verifier(singleton boolean primary key,signing_key text not null);
   alter default privileges in schema private grant all on tables to authenticated,anon;`);
  for(const id of [owner,admin,outsider])await db.query('insert into auth.users values($1)',[id]);
  await db.query('insert into private.admins values($1,$1),($2,$1)',[owner,admin]);
  await db.query('insert into public.fd_accounts values($1,$2,$3,100),($4,$5,$3,200)',[owner,account,business,outsider,other]);
  await db.query('insert into private.fd_clobe_import_verifier values(true,$1)',[key.toString('base64')]);
  const original=await scalar("select jsonb_build_object('bank',(select jsonb_agg(to_jsonb(t)) from public.fd_transactions t),'accounts',(select jsonb_agg(to_jsonb(a) order by a.id) from public.fd_accounts a),'plans',(select jsonb_agg(to_jsonb(p)) from private.synthetic_plans p))");
  const originalMigration=await readFile(new URL('../supabase/migrations/20261007055220_clobe_append_import.sql',import.meta.url),'utf8');
  const hmac=originalMigration.match(/create function private\.fd_clobe_import_hmac[\s\S]+?end \$\$;/)?.[0];assert.ok(hmac);await db.exec(hmac);
  await db.exec(await readFile(new URL('../supabase/migrations/20261102003146_toss_settlements.sql',import.meta.url),'utf8'));
  for(const table of ['fd_toss_merchants','fd_toss_settlements','fd_toss_sync_state']){
   assert.equal(await scalar(`select relrowsecurity from pg_class where oid='private.${table}'::regclass`),true);
   for(const role of ['anon','authenticated'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal(await scalar(`select has_table_privilege('${role}','private.${table}','${privilege}')`),false);
  }
  for(const method of ['read()','sync(text,text,text)'])assert.equal(await scalar(`select has_function_privilege('anon','public.fd_toss_settlements_${method}','EXECUTE')`),false);
  await asUser();assert.deepEqual(await reader(),{merchants:[],settlements:[],lastSyncedAt:null,range:null});
  await assert.rejects(()=>call('claim',meta(),{proof:'0'.repeat(64)}),/UNTRUSTED/);
  await assert.rejects(()=>call('claim',meta(),{actor:owner}),/UNTRUSTED/);
  await assert.rejects(()=>call('claim',meta(),{owner:outsider}),/UNTRUSTED/);
  assert.deepEqual(await call('claim',meta()),{claimed:true});
  await assert.rejects(()=>call('claim',{...meta(),run_id:randomUUID()}),/BUSY/);
  await assert.rejects(()=>save([row(),row()]),/INVALID_REQUEST/);
  await assert.rejects(()=>save([row(),row({transaction_key:'bad',account_id:other})]),/INVALID_REQUEST/);
  assert.equal((await reader()).settlements.length,0);
  assert.deepEqual(await save([row(),row({transaction_key:'cancel',amount:-100,pay_out_amount:-97,fee_amount:-3})]),{saved:2,from:'2026-10-01',to:'2027-01-31'});
  const first=await reader();assert.equal(first.settlements.length,2);assert.equal(first.settlements.reduce((sum,r)=>sum+r.pay_out_amount,0),873);assert.ok(!JSON.stringify(first).includes('owner_id'));
  await assert.rejects(()=>save([row()]),/BUSY/);
  await resetCooldown();await call('claim',meta());
  // Complete refresh updates same IDs and removes source rows absent from this range.
  await save([row({pay_out_amount:900})]);assert.equal((await reader()).settlements.length,1);assert.equal((await reader()).settlements[0].pay_out_amount,900);
  const previous=await reader();await resetCooldown();await call('claim',meta());
  await assert.rejects(()=>save([row()],{merchants:[{...merchant,accountId:other}]}),/SCOPE/);
  await call('release',meta());assert.deepEqual(await reader(),previous);
  await asUser(owner);assert.deepEqual(await reader(),previous);
  await asUser(outsider);await assert.rejects(reader,/ADMIN_REQUIRED/);await assert.rejects(()=>call('claim',meta()),/ADMIN_REQUIRED/);
  await db.exec('reset role');assert.deepEqual(await scalar("select jsonb_build_object('bank',(select jsonb_agg(to_jsonb(t)) from public.fd_transactions t),'accounts',(select jsonb_agg(to_jsonb(a) order by a.id) from public.fd_accounts a),'plans',(select jsonb_agg(to_jsonb(p)) from private.synthetic_plans p))"),original);
 }finally{await db.close();}
});
