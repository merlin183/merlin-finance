// Synthetic fixtures in an in-memory PostgreSQL only. No remote database access.
// Set PGLITE_MODULE to an installed @electric-sql/pglite dist/index.js file URL.
import assert from 'node:assert/strict';
import {bootstrapSyntheticWorkspace} from './helpers/bootstrap-workspace.mjs';
import {readFile,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const owner='10000000-0000-4000-8000-000000000001';
const admin='00000000-0000-4000-8000-000000000001';
const outsider='00000000-0000-4000-8000-000000000002';
const source='https://docs.google.com/spreadsheets/d/synthetic_fixture_123/edit?gid=7#gid=7';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;console.log('PASS',label);};
const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0];
const json=JSON.stringify;
const sha=value=>createHash('sha256').update(value).digest('hex');
const asUser=async id=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
const snapshot=async id=>scalar("select to_jsonb(t)-'owner_id'-'created_at' from public.fd_transactions t where id=$1",[id]);
const state=async()=>scalar("select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.fd_transactions t");
function digest(a,row){
 const parts=[a,row.txn_date,row.amount,row.direction,row.description];
 return row.balance===null?createHash('sha1').update(parts.join('|')).digest('hex'):sha(['v2',...parts,row.balance].join('|'));
}
let serial=0;
function parsed(a,patch={}){
 const row={txn_date:'2026-09-01',txn_time:null,source_sheet:null,source_row:null,amount:100,direction:'out',
  description:'synthetic-'+(++serial),raw_gwamok:'',category_id:null,is_internal:false,balance:1000,
  tax_invoice:false,manually_classified:false,...patch};
 row.dedup_hash=patch.dedup_hash||digest(a,row);return row;
}
async function insertExisting(a,b,patch={},upload=null){
 const id=randomUUID(),row=parsed(a,patch);
 await db.query(`insert into public.fd_transactions(id,owner_id,business_id,account_id,upload_id,txn_date,txn_time,source_sheet,source_row,amount,direction,description,raw_gwamok,category_id,is_internal,balance,tax_invoice,dedup_hash,manually_classified)
 select $1,$2,$3,$4,$5,x.txn_date,x.txn_time,x.source_sheet,x.source_row,x.amount,x.direction,x.description,x.raw_gwamok,x.category_id,x.is_internal,x.balance,x.tax_invoice,x.dedup_hash,x.manually_classified
 from jsonb_to_record($6) x(txn_date date,txn_time text,source_sheet text,source_row int,amount bigint,direction text,description text,raw_gwamok text,category_id uuid,is_internal boolean,balance bigint,tax_invoice boolean,dedup_hash text,manually_classified boolean)`,
 [id,owner,b,a,upload,json(row)]);
 return snapshot(id);
}
function update(t,patch={},duplicates=[]){
 const row={...t,...patch};delete row.id;delete row.account_id;delete row.business_id;delete row.upload_id;
 row.dedup_hash=patch.dedup_hash||digest(t.account_id,row);
 return {kind:'update',account_id:t.account_id,id:t.id,expected:t,row,duplicates:duplicates.map(t=>({id:t.id,expected:t}))};
}
const insert=(account,patch={})=>({kind:'insert',account_id:account,id:randomUUID(),expected:null,row:parsed(account,patch),duplicates:[]});
async function apply(changes,{run=randomUUID(),url=source,hash=sha(json(changes)),summary={}}={}){
 return scalar('select public.fd_apply_sheet_import($1,$2,$3,$4,$5)',[run,url,hash,json(changes),json(summary)]);
}
async function rejectAtomic(changes,pattern,options={}){
 const before=await state(),run=options.run||randomUUID(),audit=await scalar('select count(*)::int from public.fd_audit_log');
 await assert.rejects(apply(changes,{...options,run}),pattern);
 assert.deepEqual(await state(),before,'failed import must not change transactions');
 assert.equal(await scalar('select count(*)::int from public.fd_sheet_imports where id=$1',[run]),0,'failed run must not leave a journal');
 assert.equal(await scalar('select count(*)::int from public.fd_audit_log'),audit,'failed run must not leave an audit entry');
 checks++;console.log('PASS atomic rejection',String(pattern));
}
try{
 await db.exec(`
 create role anon;create role authenticated;
 create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid references auth.users,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;
 create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
 grant usage on schema public,auth,storage to authenticated,anon;
 grant select,insert,delete on storage.objects to authenticated;
 `);
 for(const [id,email] of [[owner,'owner@example.test'],[admin,'admin@example.test'],[outsider,'outsider@example.test']]){
  await db.query('insert into auth.users values($1,$2,now())',[id,email]);
  await db.query("insert into auth.identities values($1,'google',$2)",[id,json({email,email_verified:true})]);
 }
 const migrations=new URL('../supabase/migrations/',import.meta.url);
 for(const name of (await readdir(migrations)).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,migrations),'utf8'));
 await bootstrapSyntheticWorkspace(db,owner,'admin@example.test');
 await asUser(owner);await scalar('select public.fd_admin_context()');
 await asUser(admin);ok((await scalar('select public.fd_admin_context()')).owner_id===owner,'verified second admin uses shared namespace');
 const b1=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic A') returning id",[owner]);
 const b2=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic B') returning id",[owner]);
 const a1=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic bank A') returning id",[owner,b1]);
 const a2=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic bank B') returning id",[owner,b2]);
 const category=await scalar("insert into public.fd_categories(owner_id,name,group_name) values($1,'Synthetic fee','영업지출') returning id",[owner]);
 const upload=await scalar("insert into public.fd_uploads(owner_id,account_id,filename,storage_path) values($1,$2,'fixture.csv','synthetic/fixture.csv') returning id",[owner,a1]);

 const original=await insertExisting(a1,b1,{description:'김민지'},upload);
 const note=await scalar('select public.fd_save_merchant_note($1,$2,$3,$4,$5,0)',[a1,'out','transaction:'+original.id,'김민지','preserve this administrator memo']);
 const updatedPlan=update(original,{category_id:category,raw_gwamok:'Synthetic fee',tax_invoice:true,manually_classified:true,source_sheet:'Ledger',source_row:2});
 const firstRun=randomUUID(),firstHash=sha(json([updatedPlan]));
 const first=await apply([updatedPlan],{run:firstRun,hash:firstHash});
 const after=await snapshot(original.id);
 ok(first.updated===1&&first.inserted===0&&after.id===original.id&&after.upload_id===null&&after.category_id===category&&after.tax_invoice,'sheet values update existing ID and detach old upload');
 ok(await scalar('select memo from public.fd_merchant_notes where id=$1',[note.id])===note.memo,'survivor transaction memo remains intact');
 const journal=await scalar('select changes from public.fd_sheet_imports where id=$1',[firstRun]);
 ok(journal.before[0].upload_id===upload&&journal.after[0].upload_id===null&&journal.request[0].id===original.id,'journal preserves request and complete before/after values');
 const auditBeforeRetry=await scalar('select count(*)::int from public.fd_audit_log');
 assert.deepEqual(await apply([updatedPlan],{run:firstRun,hash:firstHash}),first);
 ok(await scalar('select count(*)::int from public.fd_audit_log')===auditBeforeRetry,'same request retry returns stored result without second write');
 await assert.rejects(apply([updatedPlan],{run:firstRun,hash:'f'.repeat(64)}),/SHEET_RUN_CONFLICT/);checks++;
 await assert.rejects(apply([{...updatedPlan,row:{...updatedPlan.row,raw_gwamok:'changed'}}],{run:firstRun,hash:firstHash}),/SHEET_RUN_CONFLICT/);checks++;
 await assert.rejects(apply([updatedPlan],{run:firstRun,hash:firstHash,summary:{blocked:1}}),/SHEET_RUN_CONFLICT/);checks++;
 await db.query('delete from public.fd_uploads where id=$1',[upload]);
 ok((await snapshot(original.id)).id===original.id,'old upload cancellation cannot cascade-delete the merged survivor');
 ok((await apply([update(await snapshot(original.id))])).unchanged===1,'new run with already-identical values is a no-op');
 const summaryRun=randomUUID(),summaryPlan=[update(await snapshot(original.id))],summary={unchanged:7,sourceDuplicates:2,blocked:3};
 const summaryResult=await apply(summaryPlan,{run:summaryRun,summary});
 ok(summaryResult.unchanged===8&&summaryResult.sourceDuplicates===2&&summaryResult.blocked===3&&summaryResult.updated===0,'only whitelisted preview counts augment actual RPC counts');
 assert.deepEqual(await apply(summaryPlan,{run:summaryRun,summary}),summaryResult);checks++;

 const repeated=[insert(a1,{description:'Repeated payment',balance:900}),insert(a1,{description:'Repeated payment',balance:800})];
 ok((await apply(repeated)).inserted===2,'same day/amount/description with distinct bank balances retains both transactions');
 const repeatedBefore=await snapshot(repeated[0].id),repeatedOther=await snapshot(repeated[1].id);
 await rejectAtomic([update(repeatedBefore,{},[repeatedOther])],/SHEET_DUPLICATE_AMBIGUOUS/);
 const canonical=await insertExisting(a1,b1,{description:'Duplicate evidence',balance:2000});
 const duplicate=await insertExisting(a1,b1,{description:'Duplicate evidence',balance:null});
 const unrelated=await insertExisting(a1,b1,{description:'Duplicate evidence',balance:1900});
 const merged=await apply([update(canonical,{raw_gwamok:'from sheet'},[duplicate])]);
 ok(merged.removed===1&&!!(await snapshot(unrelated.id))&&!!(await snapshot(canonical.id)),'only explicitly proven duplicate is removed; same weak-key repetition survives');
 await assert.rejects(scalar('select public.fd_save_merchant_note($1,$2,$3,$4,$5,0)',[a1,'out','transaction:'+duplicate.id,'deleted duplicate','late note']),/NOTE_TRANSACTION_MISSING/);
 ok(await scalar('select count(*)::int from public.fd_merchant_notes where subject_key=$1',['transaction:'+duplicate.id])===0,'late note cannot attach to an already-removed duplicate');
 const early=await insertExisting(a1,b1,{description:'Same ending balance',txn_time:'09:00:00',balance:3000});
 const late=await insertExisting(a1,b1,{description:'Same ending balance',txn_time:'11:00:00',balance:3000,dedup_hash:sha('synthetic-v3-late')});
 await rejectAtomic([update(early,{},[late])],/SHEET_DUPLICATE_AMBIGUOUS/);

 const protectedCanonical=await insertExisting(a1,b1,{description:'김철수',balance:4000});
 const protectedDuplicate=await insertExisting(a1,b1,{description:'김철수',balance:null});
 await scalar('select public.fd_save_merchant_note($1,$2,$3,$4,$5,0)',[a1,'out','transaction:'+protectedDuplicate.id,'김철수','']);
 await rejectAtomic([update(protectedCanonical,{},[protectedDuplicate])],/SHEET_DUPLICATE_REFERENCED/);
 const outgoing=await insertExisting(a1,b1,{description:'Internal transfer',amount:500,is_internal:true,balance:5000});
 const incoming=await insertExisting(a2,b2,{description:'Internal transfer',amount:500,direction:'in',is_internal:true,balance:6000});
 const link=await scalar('insert into public.fd_inter_company_links(owner_id,out_transaction_id,in_transaction_id) values($1,$2,$3) returning id',[owner,outgoing.id,incoming.id]);
 await rejectAtomic([update(outgoing,{is_internal:false})],/SHEET_LINK_CONFLICT/);
 ok(await scalar('select count(*)::int from public.fd_inter_company_links where id=$1',[link])===1,'rejected merge preserves existing internal-transfer link');
 const linkedCanonical=await insertExisting(a1,b1,{description:'Internal transfer',amount:500,is_internal:true,balance:null});
 await rejectAtomic([update(linkedCanonical,{},[outgoing])],/SHEET_DUPLICATE_REFERENCED/);
 ok((await apply([update(outgoing,{raw_gwamok:'same linked movement'})])).updated===1,'non-link-affecting update preserves survivor reference');
 ok(await scalar('select count(*)::int from public.fd_inter_company_links where id=$1',[link])===1,'link still exists after permitted metadata update');

 const stale=await snapshot(original.id);
 await db.query("update public.fd_transactions set raw_gwamok='concurrent admin edit' where id=$1",[original.id]);
 await rejectAtomic([insert(a1),update(stale,{raw_gwamok:'stale preview'})],/SHEET_STALE/);
 const current=await snapshot(original.id);
 await rejectAtomic([update(current,{raw_gwamok:'should rollback'}),insert(a1,{category_id:randomUUID()})],/foreign key/);
 await rejectAtomic([update(current),update(current)],/SHEET_DUPLICATE_ID/);
 await rejectAtomic([update(current,{},[current])],/SHEET_DUPLICATE_ID/);
 await rejectAtomic([{...update(current),expected:{id:current.id}}],/SHEET_STALE/);
 await rejectAtomic([{...update(current),account_id:a2}],/SHEET_STALE/);
 await rejectAtomic([insert(randomUUID())],/SHEET_ACCOUNT_REQUIRED/);
 await rejectAtomic([insert(a1)],/SHEET_INVALID_PAYLOAD/,{url:'https://docs.google.com.evil.test/spreadsheets/d/id'});
 await rejectAtomic([],/SHEET_INVALID_SUMMARY/,{summary:{inserted:100}});
 await rejectAtomic([],/SHEET_INVALID_SUMMARY/,{summary:{blocked:-1}});
 await rejectAtomic([],/SHEET_INVALID_SUMMARY/,{summary:{blocked:20001}});
 await rejectAtomic([],/SHEET_INVALID_SUMMARY/,{summary:{unchanged:0.5}});
 await rejectAtomic([],/SHEET_INVALID_SUMMARY/,{summary:{sourceDuplicates:'1'}});
 await rejectAtomic(Array.from({length:20001},()=>insert(a1)),/SHEET_INVALID_PAYLOAD/);

 const bulk=Array.from({length:601},(_,i)=>insert(a1,{description:'Bulk fixture '+i,balance:10000+i}));
 const bulkResult=await apply(bulk);
 ok(bulkResult.inserted===601&&await scalar('select count(*)::int from public.fd_transactions where id=any($1::uuid[])',[bulk.map(c=>c.id)])===601,'single atomic RPC supports more than 500 rows');
 const bulkRollback=[...Array.from({length:501},(_,i)=>insert(a1,{description:'Rollback fixture '+i})),insert(a1,{category_id:randomUUID()})];
 await rejectAtomic(bulkRollback,/foreign key/);
 const optional=await snapshot(repeated[0].id);
 delete optional.txn_time;delete optional.source_sheet;delete optional.source_row;
 ok((await apply([update(optional,{raw_gwamok:'null optional fields'})])).updated===1,'omitted optional expected fields normalize to null');

 await asUser(outsider);
 ok((await scalar('select public.fd_admin_context()')).is_admin===false,'uninvited user stays outside the shared workspace');
 ok(await scalar('select count(*)::int from public.fd_sheet_imports')===0,'RLS hides sheet journals from ordinary accounts');
 await assert.rejects(apply([]),/ADMIN_REQUIRED/);checks++;
 await db.exec('reset role;set role anon');
 await assert.rejects(apply([]),/permission denied/);checks++;
 await assert.rejects(db.query('select * from public.fd_sheet_imports'),/permission denied/);checks++;
 await asUser(admin);
 await scalar('select public.fd_delete_my_data()');
 ok(await scalar('select count(*)::int from public.fd_sheet_imports')===0,'full finance reset clears import snapshots as well');
 console.log('All '+checks+' sheet-merge checks passed.');
}catch(error){console.error(error.message);if(error.where)console.error(error.where);process.exitCode=1;}
finally{await db.close();}
