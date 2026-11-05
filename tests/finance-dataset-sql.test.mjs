// Isolated synthetic PostgreSQL fixtures. No network, live users or finance data.
import assert from 'node:assert/strict';
import {bootstrapSyntheticWorkspace} from './helpers/bootstrap-workspace.mjs';
import {readFile,readdir} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const owner='10000000-0000-4000-8000-000000000001';
const admin='00000000-0000-4000-8000-000000000001';
const outsider='00000000-0000-4000-8000-000000000002';
const resources={
 businesses:['fd_businesses','id,name,representative,kind,reserve,color'],
 accounts:['fd_accounts','id,business_id,name,bank,masked_number,opening_balance,opening_balance_date'],
 categories:['fd_categories','id,name,group_name,is_operating,is_internal,is_fixed'],
 rules:['fd_category_rules','id,pattern,field,category_id,priority,is_internal,account_id,direction'],
 aliases:['fd_gwamok_aliases','id,raw_name,standard_name'],
 recurring:['fd_recurring_items','id,business_id,title,amount,direction,day,start_date,end_date,frequency'],
 transactions:['fd_transactions','id,business_id,account_id,upload_id,txn_date,txn_time,source_sheet,source_row,source_details,amount,direction,description,raw_gwamok,category_id,is_internal,balance,tax_invoice,dedup_hash,manually_classified,transfer_fee_amount,transfer_fee_category_id'],
 uploads:['fd_uploads','id,account_id,filename,storage_path,success_count,duplicate_count,error_count,created_at,errors'],
 links:['fd_inter_company_links','id,out_transaction_id,in_transaction_id'],
 notes:['fd_merchant_notes','id,account_id,direction,subject_key,label,memo,version,updated_at'],
 audit:['fd_audit_log','id,action,detail,created_at'],
};
let checks=0;
const ok=(condition,label)=>{assert.ok(condition,label);checks++;console.log('PASS',label);};
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const asUser=async id=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
const read=()=>scalar('select public.fd_read_finance_snapshot()');
const readCompatibility=()=>scalar('select public.fd_read_finance_dataset()');
async function denied(pattern){await assert.rejects(read(),pattern);checks++;}
async function legacy(){
 const at=await scalar('select statement_timestamp()::text');
 const raw={},projected={};let queries=0;
 for(const [key,[table,fields]] of Object.entries(resources)){
  const rows=[];let last=null;
  while(true){
   const page=(await db.query(`select to_jsonb(t) as row from public.${table} t where created_at<=$1 and ($2::uuid is null or id>$2) order by ${key==='audit'?'created_at desc,id':'id'} limit ${key==='audit'?100:1000}`,[at,last])).rows.map(r=>r.row);
   queries++;rows.push(...page);if(page.length<1000||key==='audit')break;last=page.at(-1).id;
  }
  if(key==='uploads')rows.sort((a,b)=>b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id));
  raw[key]=rows;projected[key]=rows.map(row=>Object.fromEntries(fields.split(',').map(field=>[field,row[field]])));
 }
 // Private bank observations are separate from legacy public resources.
 // This fixture has none, so their optional dataset arrays remain empty.
 projected.balance_snapshots=[];
 projected.bank_plan_actuals=[];
 projected.bank_plan_coverage=[];
 projected.cash_plan_series=[];
 projected.cash_plan_series_revisions=[];
 return {raw,projected,queries};
}
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
 for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
 await bootstrapSyntheticWorkspace(db,owner,'admin@example.test');
 const fn=(await db.query("select prosecdef,provolatile,proconfig,prorettype::regtype::text as return_type from pg_proc where oid='public.fd_read_finance_snapshot()'::regprocedure")).rows[0];
 ok(!fn.prosecdef&&fn.provolatile==='s'&&fn.proconfig.includes('search_path=""')&&fn.return_type==='json','JSON read RPC is STABLE SECURITY INVOKER with empty search_path');
 ok(await scalar("select has_function_privilege('authenticated','public.fd_read_finance_snapshot()','EXECUTE') and not has_function_privilege('anon','public.fd_read_finance_snapshot()','EXECUTE')"),'JSON execution is granted only to authenticated application role');
 await denied(/UNAUTHORIZED/);
 await asUser(admin);await scalar('select public.fd_admin_context()');
 ok(Object.values(await read()).every(rows=>Array.isArray(rows)&&rows.length===0),'empty dataset returns all resource arrays');
 const business=await scalar("insert into public.fd_businesses(owner_id,name,representative,reserve) values($1,'Synthetic business','Synthetic representative',500) returning id",[owner]);
 const otherBusiness=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic second business') returning id",[owner]);
 const account=await scalar("insert into public.fd_accounts(owner_id,business_id,name,bank,masked_number,opening_balance,opening_balance_date) values($1,$2,'Synthetic bank account','Test bank','123',9000,'2026-01-01') returning id",[owner,business]);
 const otherAccount=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic other bank') returning id",[owner,otherBusiness]);
 const category=await scalar("insert into public.fd_categories(owner_id,name,group_name,is_operating,is_fixed) values($1,'Synthetic fee','영업지출',true,true) returning id",[owner]);
 await db.query("insert into public.fd_category_rules(owner_id,pattern,field,category_id,account_id,direction) values($1,'Synthetic','description',$2,$3,'out')",[owner,category,account]);
 await db.query("insert into public.fd_gwamok_aliases(owner_id,raw_name,standard_name) values($1,'Synthetic raw','Synthetic fee')",[owner]);
 await db.query("insert into public.fd_recurring_items(owner_id,business_id,title,amount,direction,day,start_date) values($1,$2,'Synthetic recurring',100,'out',15,'2026-01-01')",[owner,business]);
 const upload=await scalar("insert into public.fd_uploads(owner_id,account_id,filename,storage_path,success_count,error_count,errors,created_at) values($1,$2,'synthetic.xlsx','synthetic/object.xlsx',8749,1,'[{\"row\":9,\"message\":\"synthetic warning\"}]','2026-01-01') returning id",[owner,account]);
 await db.query("insert into public.fd_uploads(owner_id,account_id,filename,storage_path,created_at) values($1,$2,'synthetic-new.xlsx','synthetic/new.xlsx','2026-02-01')",[owner,account]);
 await db.query(`insert into public.fd_transactions(owner_id,business_id,account_id,upload_id,txn_date,txn_time,source_sheet,source_row,source_details,amount,direction,description,raw_gwamok,category_id,balance,tax_invoice,dedup_hash,manually_classified)
 select $1,$2,$3,$4,'2026-09-01','09:30:00','Synthetic source',n,
 jsonb_build_object('basic','Synthetic source detail','detail','Synthetic recipient '||n,'memo','Synthetic memo','provenance',jsonb_build_object('url','https://docs.google.com/spreadsheets/d/synthetic-performance/edit','sheet','Synthetic source','row',n)),
 n,'out','Synthetic payment '||n,'Synthetic raw',$5,case when n%2=0 then null else 10000-n end,n%2=0,'synthetic-'||n,n%3=0 from generate_series(1,8749) n`,[owner,business,account,upload,category]);
 const outgoing=await scalar("insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,amount,direction,description,is_internal,dedup_hash) values($1,$2,$3,'2026-09-01',100,'out','Synthetic transfer',true,'synthetic-transfer-out') returning id",[owner,business,account]);
 const incoming=await scalar("insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,amount,direction,description,is_internal,dedup_hash) values($1,$2,$3,'2026-09-01',100,'in','Synthetic transfer',true,'synthetic-transfer-in') returning id",[owner,otherBusiness,otherAccount]);
 await db.query('insert into public.fd_inter_company_links(owner_id,out_transaction_id,in_transaction_id) values($1,$2,$3)',[owner,outgoing,incoming]);
 await db.query("select public.fd_save_merchant_note($1,'out','exact:synthetic','Synthetic payment','Synthetic shared memo',0)",[account]);
 await db.query("insert into public.fd_audit_log(owner_id,action,detail,created_at) select $1,'Synthetic audit','Entry '||n,'2026-01-01'::timestamptz+n*interval '1 second' from generate_series(1,125) n",[owner]);
 await db.query("insert into public.fd_businesses(owner_id,name,created_at) values($1,'Synthetic future row',now()+interval '1 day')",[owner]);
 await db.exec('reset role');
 await db.query("insert into public.fd_businesses(owner_id,name) values($1,'Foreign synthetic business')",[outsider]);
 await asUser(admin);
 const started=performance.now(),baseline=await legacy(),legacyMs=performance.now()-started;
 const rpcStart=performance.now();let dataset=await read();const rpcMs=performance.now()-rpcStart;
 const compatibilityStart=performance.now(),compatibility=await readCompatibility(),compatibilityMs=performance.now()-compatibilityStart;
 assert.deepEqual(dataset,compatibility);ok(true,'JSON reader exactly preserves every current compatibility RPC key, value and ordering');
 assert.deepEqual(dataset,baseline.projected);ok(true,'single snapshot exactly matches all legacy Dataset fields, ordering and limits');
 ok(dataset.bank_plan_actuals.length===0&&dataset.bank_plan_coverage.length===0,'legacy ledger transactions do not create private bank evidence or completeness scopes');
 ok(dataset.transactions.length===8751&&new Set(dataset.transactions.map(t=>t.id)).size===8751,'all 8751 transactions are returned once without a 1000-row response truncation');
 ok(dataset.audit.length===100&&dataset.audit[0].detail==='Entry 125'&&dataset.audit.at(-1).detail==='Entry 26','audit remains newest 100 entries');
 ok(dataset.uploads[0].filename==='synthetic-new.xlsx'&&dataset.links.length===1&&dataset.notes.length===1,'upload ordering, notes and transfer links are retained');
 ok(dataset.businesses.length===2&&dataset.accounts.length===2,'foreign owner and future-created rows remain excluded');
 ok(dataset.transactions.every(t=>!('owner_id' in t)&&!('created_at' in t)),'unneeded internal metadata is not transferred');
 ok(dataset.transactions.filter(t=>t.upload_id).every(t=>t.source_details?.provenance?.url&&t.source_row&&t.txn_time),'transaction source identity and original details are intact');
 // Populate the optional current contracts as well: parity must protect real
 // bank balances/evidence, transfer-fee allocations and continuing exclusions,
 // not just an empty array from each nested reader.
 await db.exec('reset role');
 const transferCategory=await scalar("insert into public.fd_categories(owner_id,name,group_name,is_internal) values($1,'Synthetic account transfer','Synthetic internal',true) returning id",[owner]);
 const feeTransaction=dataset.transactions.find(row=>row.upload_id&&row.amount>10).id;
 await db.query('update public.fd_transactions set category_id=$3,is_internal=true,manually_classified=true,transfer_fee_amount=5,transfer_fee_category_id=$2 where id=$1',[feeTransaction,category,transferCategory]);
 await db.query("insert into private.fd_clobe_account_mappings(owner_id,company_id,external_account_id,account_id) values($1,'synthetic-company','1',$2)",[owner,account]);
 await db.query("insert into private.fd_clobe_balance_snapshots(owner_id,account_id,business_id,company_id,external_account_id,balance,balance_date,collected_at,collected_order) values($1,$2,$3,'synthetic-company','1',12345,'2026-09-01','2026-09-01T12:00:00+09:00','2026-09-01T03:00:00Z')",[owner,account,business]);
 await db.query("insert into private.fd_clobe_plan_coverage(owner_id,account_id,business_id,month,company_id,external_account_id,scope_from,scope_to,collected_at,collected_order,status,rows_hash) values($1,$2,$3,'2026-09','synthetic-company','1','2026-09-01','2026-09-01','2026-09-01T12:00:00+09:00','2026-09-01T03:00:00Z','complete','synthetic-hash')",[owner,account,business]);
 await db.query("insert into private.fd_clobe_plan_actuals(owner_id,account_id,business_id,month,external_transaction_id,txn_date,txn_time,amount,balance,description,party,source_details,collected_at) values($1,$2,$3,'2026-09','1','2026-09-01','09:30:00',100,12345,'Synthetic bank evidence','Synthetic party','{\"basic\":\"Synthetic original\"}','2026-09-01T12:00:00+09:00')",[owner,account,business]);
 await db.query("insert into private.fd_clobe_transaction_refs(owner_id,company_id,external_account_id,external_transaction_id,account_id,transaction_id,source_fingerprint) values($1,'synthetic-company','1','1',$2,$3,repeat('a',64))",[owner,account,outgoing]);
 const series=await scalar("insert into public.fd_cash_plan_series(owner_id,business_id,source_type,source_key,title,account_id,monthly_amount,start_month,day,kind,memo,amount_overrides) values($1,$2,'estimated','synthetic-current-reader','Synthetic fixed plan',$3,100,'2026-09',15,'operating','Synthetic plan memo','{\"2026-11\":120}') returning id",[owner,business,account]);
 await db.query("insert into public.fd_cash_plan_series_revisions(owner_id,business_id,series_id,effective_month,title,monthly_amount,day,account_id,memo,excluded) values($1,$2,$3,'2026-11','Synthetic excluded payroll',100,15,$4,'Synthetic exclusion',true)",[owner,business,series,account]);
 await asUser(admin);dataset=await read();
 assert.deepEqual(dataset,await readCompatibility());ok(true,'nonempty balances, bank actuals/coverage, plan series/revisions and fees match the complete compatibility reader');
 ok(dataset.balance_snapshots[0].balance===12345&&dataset.bank_plan_actuals[0].transaction_id===outgoing&&dataset.bank_plan_coverage[0].status==='complete','collected balances and exact bank evidence remain available to cash planning');
 ok(dataset.cash_plan_series[0].amount_overrides['2026-11']===120&&dataset.cash_plan_series_revisions[0].excluded===true&&dataset.transactions.find(row=>row.id===feeTransaction).transfer_fee_amount===5,'current overrides, continuing exclusions and transfer fees remain intact');
 await asUser(owner);assert.deepEqual(await read(),dataset);ok(true,'different authorized administrator reads the same original owner namespace');
 await asUser(outsider);await denied(/ADMIN_REQUIRED/);
 await asUser('');await denied(/UNAUTHORIZED/);
 await db.exec('reset role;set role anon');await denied(/permission denied/);
 await db.exec('reset role');
 await db.exec('revoke select on public.fd_transactions from authenticated');
 await asUser(admin);await denied(/permission denied/);
 await db.exec('reset role;grant select on public.fd_transactions to authenticated');
 ok(true,'invoker RPC cannot bypass underlying table grants');
 await db.query("update private.finance_administrators set status='revoked' where user_id=$1",[admin]);
 await asUser(admin);await denied(/ADMIN_REQUIRED/);
 await asUser(owner);assert.deepEqual(await read(),dataset);ok(true,'revoked administrator is denied immediately while remaining administrator retains shared rows');
 const payload=JSON.stringify(dataset),oldPayload=JSON.stringify(baseline.raw);
 console.log(JSON.stringify({syntheticBenchmark:{transactions:8751,legacyDataQueries:baseline.queries,rpcDataQueries:1,legacyLocalMs:Math.round(legacyMs),rpcLocalMs:Math.round(rpcMs),compatibilityJsonbLocalMs:Math.round(compatibilityMs),legacyJsonBytes:Buffer.byteLength(oldPayload),rpcJsonBytes:Buffer.byteLength(payload),rpcGzipBytes:gzipSync(payload).length},checks}));
}finally{await db.close();}
