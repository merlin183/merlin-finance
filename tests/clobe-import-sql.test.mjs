// Synthetic local PostgreSQL: no network, credentials, real bank rows or writes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac,randomUUID} from 'node:crypto';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');

test('Clobe atomic import accepts server proofs only, preserves existing classifications, idempotency, isolation and rollback',async()=>{
 const db=new PGlite(),owner='10000000-0000-4000-8000-000000000001',admin='10000000-0000-4000-8000-000000000002',outsider='10000000-0000-4000-8000-000000000003';
 const business='20000000-0000-4000-8000-000000000001',account='20000000-0000-4000-8000-000000000002',other='20000000-0000-4000-8000-000000000003',category='30000000-0000-4000-8000-000000000001';
 let key,actor=admin,checks=0;
 const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
 const user=async(id=admin)=>{actor=id;await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
 const signed=async(action,payload,override={})=>{
  const wire=JSON.stringify(payload),proof=createHmac('sha256',key).update(`merlin:clobe-import:v1\n${action}\n${actor}\n${owner}\n${wire}`).digest('hex');
  return scalar('select public.fd_clobe_import($1,$2,$3)',[action,wire,override.proof??proof]);
 };
 const check=(value,label)=>{assert.ok(value,label);checks++;};
 const scope={connection_id:null,mappings:[{company_id:'synthetic-company',external_account_id:'1',account_id:account}],start_date:'2026-10-01',end_date:'2026-10-31'};
 const store=async(id=randomUUID(),s=scope)=>{await signed('store',{id,scope:s,expires_at:new Date(Date.now()+3600000).toISOString(),ciphertext:'v1.synthetic.synthetic.syntheticEncryptedOriginal'});return id;};
 const stateHash=value=>createHash('sha256').update(value).digest('hex');
 const row=(id=randomUUID(),patch={})=>({kind:'insert',company_id:'synthetic-company',external_account_id:'1',external_transaction_id:String(Math.floor(Math.random()*1e9)+1),account_id:account,transaction_id:id,source_fingerprint:'f'.repeat(64),expected_candidates_hash:stateHash(''),expected:null,row:{txn_date:'2026-10-02',txn_time:'12:34:56',amount:100,direction:'out',balance:900,description:'Synthetic bank original',raw_gwamok:'',category_id:category,is_internal:false,dedup_hash:id.replaceAll('-','').padEnd(64,'a'),tax_invoice:false,manually_classified:true,source_details:{basic:'Bank original',detail:'Salary channel',counterparty:'Synthetic recipient',memo:'Keep original'},...patch}});
 const apply=async(id,changes,patch={})=>signed('apply',{id,scope,request_hash:'a'.repeat(64),changes,summary:{unchanged:0,sourceDuplicates:0,blocked:0},...patch});
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;create schema private;
   create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create table private.synthetic_admins(user_id uuid primary key,owner_id uuid not null,active boolean not null default true);
   create function private.finance_workspace_owner() returns uuid language sql stable security definer set search_path='' as $$select owner_id from private.synthetic_admins where user_id=auth.uid() and active$$;
   grant usage on schema public,private,auth to authenticated,anon;
   create table public.fd_accounts(id uuid primary key,owner_id uuid not null,business_id uuid not null,unique(owner_id,id));
   create table public.fd_categories(id uuid primary key,owner_id uuid not null,name text not null,is_internal boolean not null default false);
   create table public.fd_transactions(id uuid primary key,owner_id uuid not null,business_id uuid not null,account_id uuid not null,upload_id uuid,txn_date date not null,txn_time text,amount bigint not null,direction text not null,description text not null,raw_gwamok text not null,category_id uuid,is_internal boolean not null,balance bigint,tax_invoice boolean not null,dedup_hash text not null,manually_classified boolean not null,source_details jsonb,unique(owner_id,id),unique(account_id,dedup_hash));
   create table public.fd_audit_log(owner_id uuid,action text,detail text);
   create function private.fd_valid_source_details(v jsonb) returns boolean language sql immutable as $$select v is null or v='null'::jsonb or jsonb_typeof(v)='object'$$;
   alter default privileges in schema private grant all on tables to anon,authenticated;`);
  for(const id of [owner,admin,outsider])await db.query('insert into auth.users values($1)',[id]);
  await db.query('insert into private.synthetic_admins(user_id,owner_id) values($1,$1),($2,$1)',[owner,admin]);
  await db.query('insert into public.fd_accounts values($1,$2,$3),($4,$5,$3)',[account,owner,business,other,outsider]);
  await db.query("insert into public.fd_categories(id,owner_id,name) values($1,$2,'지급수수료')",[category,owner]);
  await db.exec(await readFile(new URL('../supabase/migrations/20261007055220_clobe_append_import.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261007060540_clobe_candidate_financial_guard.sql',import.meta.url),'utf8'));
  key=Buffer.from(await scalar('select signing_key from private.fd_clobe_import_verifier where singleton'),'base64');
  check(key.length===32,'generated verifier is a random 32-byte server secret');
  const input='standard HMAC synthetic body with spaces {"a": 1}',expected=createHmac('sha256',key).update(input).digest('hex');
  assert.equal(await scalar('select private.fd_clobe_import_hmac($1,$2)',[input,key]),expected);checks++;
  const functions=(await db.query("select n.nspname,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('fd_clobe_import','fd_clobe_import_core')")).rows;
  check(functions.find(f=>f.nspname==='public').prosecdef===false,'public RPC is invoker');
  check(functions.find(f=>f.nspname==='private').prosecdef===true,'checked private implementation alone is definer');
  check(functions.every(f=>f.proconfig.includes('search_path=""')),'both functions fix empty search_path');
  for(const table of ['fd_clobe_import_verifier','fd_clobe_import_previews','fd_clobe_account_mappings','fd_clobe_transaction_refs']){
   check(await scalar(`select relrowsecurity from pg_class where oid='private.${table}'::regclass`),'private RLS '+table);
   check(!await scalar(`select has_table_privilege('authenticated','private.${table}','SELECT')`),'no direct browser SELECT '+table);
  }
  await user();await assert.rejects(()=>db.query('select * from private.fd_clobe_import_verifier'),/permission denied/);checks++;
  await assert.rejects(()=>signed('settings',{}, {proof:'0'.repeat(64)}),/CLOBE_IMPORT_UNTRUSTED/);checks++;
  await assert.rejects(()=>db.query('select private.fd_clobe_import_hmac($1,$2)',[input,key]),/permission denied/);checks++;
  assert.deepEqual(await signed('settings',{}),{mappings:[]});checks++;
  const firstPreview=await store(),first=row(),firstResult=await apply(firstPreview,[first]);
  check(firstResult.inserted===1&&firstResult.updated===0&&firstResult.removed===0,'new row committed without updates or deletes');
  assert.deepEqual(await apply(firstPreview,[first]),firstResult);checks++;
  await assert.rejects(()=>apply(firstPreview,[first],{request_hash:'b'.repeat(64)}),/RUN_CONFLICT/);checks++;
  await db.exec('reset role');const original=await scalar('select to_jsonb(t) from public.fd_transactions t where id=$1',[first.transaction_id]);await user();
  check(original.source_details.counterparty==='Synthetic recipient'&&original.raw_gwamok===''&&original.category_id===category,'original metadata and user category survive');
  assert.deepEqual((await signed('settings',{})).mappings,scope.mappings);checks++;
  check((await signed('refs',{account_ids:[account]})).length===1,'refs accessible only through signed server wrapper');
  // Linking a sheet/excel row does not rewrite any of its columns.
  const manualId=randomUUID();await db.exec('reset role');
  await db.query('insert into public.fd_transactions select $1::uuid,owner_id,business_id,account_id,upload_id,\'2026-10-05\'::date,txn_time,150,direction,description,\'User label\',category_id,is_internal,750,true,$2,true,source_details from public.fd_transactions where id=$3',[manualId,'d'.repeat(40),first.transaction_id]);
  const manualOriginal=await scalar('select to_jsonb(t) from public.fd_transactions t where id=$1',[manualId]);await user();
  const referencePreview=await store(),reference={...row(undefined,{txn_date:'2026-10-05',amount:150,balance:750,dedup_hash:'d'.repeat(40)}),kind:'reference',transaction_id:manualId,expected_candidates_hash:stateHash(manualId+'|12:34:56|750'),expected:Object.fromEntries(['account_id','txn_date','txn_time','amount','direction','balance','description','source_details'].map(k=>[k,manualOriginal[k]]))};
  const referenceResult=await apply(referencePreview,[reference]);check(referenceResult.referenced===1&&referenceResult.inserted===0,'identical source adds only association');
  await db.exec('reset role');assert.deepEqual(await scalar('select to_jsonb(t) from public.fd_transactions t where id=$1',[manualId]),manualOriginal);checks++;await user();
  // Multiple writes either all commit or none, including audit/mappings/refs.
  const failingPreview=await store(),newRow=row(undefined,{txn_date:'2026-10-03'}),staleRow=row();
  await assert.rejects(()=>apply(failingPreview,[newRow,staleRow]),/CLOBE_IMPORT_STALE/);checks++;
  await db.exec('reset role');check(await scalar('select count(*) from public.fd_transactions')===2,'stale batch rolled back first insert');check(await scalar('select count(*) from private.fd_clobe_transaction_refs')===2,'stale batch rolled back references');await user();
  const foreignScope={...scope,mappings:[{...scope.mappings[0],account_id:other}]};await assert.rejects(()=>store(undefined,foreignScope),/CLOBE_IMPORT_SCOPE/);checks++;
  const providerPreview=await store();await assert.rejects(()=>apply(providerPreview,[row(undefined,{txn_date:'2026-10-04',raw_gwamok:'Provider must not classify'})]),/INVALID_ROW/);checks++;
  const repeatedDatePreview=await store(),sameAmount1=row(undefined,{txn_date:'2026-10-06',txn_time:'10:00:00',balance:600}),sameAmount2=row(undefined,{txn_date:'2026-10-06',txn_time:'11:00:00',balance:500,description:'Different recipient'});
  check((await apply(repeatedDatePreview,[sameAmount1,sameAmount2])).inserted===2,'same date and amount with different time/balance are both valid payments');
  const racePreview=await store(),race=row(undefined,{txn_time:'15:00:00',balance:450});race.expected_candidates_hash=stateHash(first.transaction_id+'|12:34:56|900');
  await db.exec('reset role');await db.query("update public.fd_transactions set txn_time='15:00:00',balance=450 where id=$1",[first.transaction_id]);await user();
  await assert.rejects(()=>apply(racePreview,[race]),/CLOBE_IMPORT_STALE/);checks++;
  await user(owner);await assert.rejects(()=>signed('read',{id:providerPreview}),/EXPIRED/);checks++;
  await user(outsider);await assert.rejects(()=>signed('settings',{}),/ADMIN_REQUIRED/);checks++;
  await db.exec("reset role;set role anon");await assert.rejects(()=>db.query('select public.fd_clobe_import($1,$2,$3)',['settings','{}','0'.repeat(64)]),/permission denied/);checks++;
  console.log(`Clobe import SQL: ${checks} synthetic checks passed`);
 }finally{await db.close();}
});
