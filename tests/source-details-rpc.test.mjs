// Synthetic fixtures and in-memory PostgreSQL only; never accesses a live DB.
// PGLITE_MODULE may point to an installed @electric-sql/pglite dist/index.js URL.
import assert from 'node:assert/strict';
import {bootstrapSyntheticWorkspace} from './helpers/bootstrap-workspace.mjs';
import {readFile,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const owner='10000000-0000-4000-8000-000000000001';
const admin='00000000-0000-4000-8000-000000000001';
const outsider='00000000-0000-4000-8000-000000000002';
const source='https://docs.google.com/spreadsheets/d/synthetic_source_details_123/edit';
const json=JSON.stringify,sha=value=>createHash('sha256').update(value).digest('hex');
let checks=0,serial=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;console.log('PASS',label);};
const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0];
const asUser=async id=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
const snapshot=async id=>scalar("select to_jsonb(t)-'owner_id'-'created_at' from public.fd_transactions t where id=$1",[id]);
const state=async()=>scalar("select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.fd_transactions t");
const enrich=changes=>scalar('select public.fd_update_transaction_source_details($1)',[json(changes)]);
const change=(transaction,source_details)=>({id:transaction.id,expected:transaction,source_details});
const sheetApply=(changes,run=randomUUID())=>scalar('select public.fd_apply_sheet_import($1,$2,$3,$4,$5)',[run,source,sha(json(changes)),json(changes),'{}']);
function row(account,patch={}){
 const value={txn_date:'2026-09-01',txn_time:null,source_sheet:null,source_row:null,amount:100,direction:'out',description:'Synthetic source '+(++serial),
  raw_gwamok:'',category_id:null,is_internal:false,balance:1000,tax_invoice:false,manually_classified:false,...patch};
 value.dedup_hash=patch.dedup_hash||sha(['v2',account,value.txn_date,value.amount,value.direction,value.description,value.balance].join('|'));
 return value;
}
function sheetInsert(account,patch={}){return {kind:'insert',account_id:account,id:randomUUID(),expected:null,row:row(account,patch),duplicates:[]};}
function sheetUpdate(transaction,patch={},duplicates=[]){
 const {id,account_id,business_id,upload_id,...parsed}=transaction;
 return {kind:'update',account_id,id,expected:transaction,row:{...parsed,...patch},duplicates:duplicates.map(t=>({id:t.id,expected:t}))};
}
const minimalExpected=t=>Object.fromEntries(['account_id','txn_date','amount','direction','description','dedup_hash','source_details'].map(k=>[k,t[k]]));
const withoutDetails=t=>{const {source_details,...other}=t;return other;};
async function rejectAtomic(changes,pattern){
 const before=await state(),audit=await scalar('select count(*)::int from public.fd_audit_log');
 await assert.rejects(enrich(changes),pattern);
 assert.deepEqual(await state(),before);
 assert.equal(await scalar('select count(*)::int from public.fd_audit_log'),audit);
 checks++;console.log('PASS atomic rejection',String(pattern));
}
async function rejectSheet(changes,pattern){
 const before=await state(),run=randomUUID(),audit=await scalar('select count(*)::int from public.fd_audit_log');
 await assert.rejects(sheetApply(changes,run),pattern);
 assert.deepEqual(await state(),before);
 assert.equal(await scalar('select count(*)::int from public.fd_sheet_imports where id=$1',[run]),0);
 assert.equal(await scalar('select count(*)::int from public.fd_audit_log'),audit);
 checks++;console.log('PASS sheet rejection',String(pattern));
}
try{
 await db.exec(`
 create role anon;create role authenticated;create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid references auth.users,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;
 create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
 grant usage on schema public,auth,storage to authenticated,anon;grant select,insert,delete on storage.objects to authenticated;
 `);
 for(const [id,email] of [[owner,'owner@example.test'],[admin,'admin@example.test'],[outsider,'outsider@example.test']]){
  await db.query('insert into auth.users values($1,$2,now())',[id,email]);
  await db.query("insert into auth.identities values($1,'google',$2)",[id,json({email,email_verified:true})]);
 }
 const migrations=new URL('../supabase/migrations/',import.meta.url);
 for(const name of (await readdir(migrations)).filter(n=>n.endsWith('.sql')).sort()){
  let sql=await readFile(new URL(name,migrations),'utf8');
  if(name==='20260918064000_source_details.sql'){
   // The browser SQL editor can submit the whole migration as CRLF, including
   // dollar-quoted patch anchors. Exercise that real input against the stored
   // function definitions before running every metadata/RPC behavior below.
   sql=sql.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n');
   assert.ok(sql.includes('\r\n')&&!/(?<!\r)\n/.test(sql),'migration fixture must use CRLF throughout');
  }
  await db.exec(sql);
  if(name==='20260918064000_source_details.sql')ok(true,'entire source-details migration applies with browser-editor CRLF line endings');
 }
 await bootstrapSyntheticWorkspace(db,owner,'admin@example.test');
 await asUser(owner);await scalar('select public.fd_admin_context()');
 await asUser(admin);ok((await scalar('select public.fd_admin_context()')).owner_id===owner,'second administrator shares the same namespace');
 const business=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic business') returning id",[owner]);
 const account=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic bank') returning id",[owner,business]);
 const secondAccount=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Second bank') returning id",[owner,business]);
 const category=await scalar("insert into public.fd_categories(owner_id,name,group_name) values($1,'급여','영업지출') returning id",[owner]);
 const upload=await scalar("insert into public.fd_uploads(owner_id,account_id,filename,storage_path) values($1,$2,'source-fixture.xlsx','fixture/source.xlsx') returning id",[owner,account]);
 const fileRows=[row(account,{description:'급여',category_id:category,balance:9000}),row(account,{description:'급여',category_id:category,balance:8900,source_details:{basic:'Original bank basic',detail:'Original details',provenance:{sheet:'Bank',row:3}}})];
 ok(await scalar('select public.fd_import_transactions($1,$2,$3)',[account,upload,json(fileRows)])===2,'old and new file-import payloads are both accepted');
 const old=await scalar("select to_jsonb(t)-'owner_id'-'created_at' from public.fd_transactions t where account_id=$1 and balance=9000",[account]);
 const imported=await scalar("select to_jsonb(t)-'owner_id'-'created_at' from public.fd_transactions t where account_id=$1 and balance=8900",[account]);
 ok(old.source_details===null&&imported.source_details.basic==='Original bank basic','new metadata column defaults to null and stores file source details');
 ok(imported.dedup_hash===fileRows[1].dedup_hash,'adding details does not change the v2 import digest');
 const duplicatePayload={...fileRows[1],source_details:{basic:'Must not overwrite through duplicate upload'}};
 ok(await scalar('select public.fd_import_transactions($1,$2,$3)',[account,upload,json([duplicatePayload])])===0&&(await snapshot(imported.id)).source_details.basic==='Original bank basic','file duplicate behavior remains unchanged');

 const memo=await scalar('select public.fd_save_merchant_note($1,$2,$3,$4,$5,0)',[account,'out','transaction:'+old.id,'급여','Keep the existing administrator memo']);
 const details={basic:'받는 분 홍길동',detail:'9월 급여',counterparty:'홍길동',record:'Bank record',memo:'Source memo',note:'Source note',provenance:{sheet:'Bank ledger',row:2,url:source}};
 ok((await enrich([change(old,details)])).updated===1,'metadata-only RPC enriches an existing transaction');
 const enriched=await snapshot(old.id);
 assert.deepEqual(withoutDetails(enriched),withoutDetails(old));
 ok(enriched.source_details.counterparty==='홍길동'&&enriched.upload_id===upload,'all financial fields, category, original description, ID, hash and upload remain unchanged');
 ok(await scalar('select memo from public.fd_merchant_notes where id=$1',[memo.id])===memo.memo,'transaction-specific administrator memo remains attached');
 ok((await snapshot(imported.id)).source_details.counterparty===undefined,'same-day same-amount salary with another balance is not enriched accidentally');
 const auditBeforeNoop=await scalar('select count(*)::int from public.fd_audit_log');
 ok((await enrich([change(enriched,details)])).unchanged===1,'identical source details are a no-op with a fresh expected snapshot');
 ok(await scalar('select count(*)::int from public.fd_audit_log')===auditBeforeNoop,'no-op enrichment does not write another audit event');
 for(const blank of [null,{}, {basic:'',detail:' \t\n',counterparty:'',provenance:{sheet:'Empty export',row:999}}]){
  const current=await snapshot(old.id);
  const result=await enrich([change(current,blank)]);
  assert.deepEqual((await snapshot(old.id)).source_details,details);
  ok(result.unchanged===1,'blank/missing fields never erase existing metadata or provenance');
 }
 const patch={counterparty:'홍길동 (확인)'};
 const minimal=await snapshot(old.id);
 ok((await enrich([{id:minimal.id,expected:minimalExpected(minimal),source_details:patch}])).updated===1,'documented minimal expected snapshot is accepted');
 const patched=await snapshot(old.id);
 ok(patched.source_details.basic===details.basic&&patched.source_details.counterparty===patch.counterparty&&patched.source_details.provenance.url===source,'partial metadata update preserves all omitted fields');
 await db.query('update public.fd_transactions set source_details=$2 where id=$1',[old.id,'{}']);
 ok((await snapshot(old.id)).source_details.counterparty===patch.counterparty,'table trigger also blocks accidental direct clearing');

 await rejectAtomic([change(old,{detail:'Stale preview'})],/SOURCE_DETAILS_STALE/);
 const latest=await snapshot(old.id),partialNested={...latest,source_details:{basic:latest.source_details.basic}};
 await rejectAtomic([change(partialNested,{detail:'Must not lose concurrent fields'})],/SOURCE_DETAILS_STALE/);
 const beforeFinancial=await snapshot(imported.id);
 await db.query('update public.fd_transactions set description=$2 where id=$1',[imported.id,'Updated bank description']);
 await rejectAtomic([change(await snapshot(old.id),{detail:'Must roll back'}),change(beforeFinancial,{detail:'Stale financial snapshot'})],/SOURCE_DETAILS_STALE/);
 await rejectAtomic([change({...latest,account_id:secondAccount},{note:'Wrong account'})],/SOURCE_DETAILS_STALE/);
 await rejectAtomic([change({...latest,id:randomUUID()},{note:'Missing transaction'})],/SOURCE_DETAILS_STALE/);
 await rejectAtomic([change(latest,{note:'One'}),change(latest,{note:'Two'})],/SOURCE_DETAILS_DUPLICATE_ID/);
 await rejectAtomic([{id:latest.id,expected:{id:latest.id},source_details:{note:'Missing expected fields'}}],/SOURCE_DETAILS_INVALID_CHANGE/);
 await rejectAtomic([{...change(latest,{note:'Forbidden foreign fields'}),owner_id:outsider}],/SOURCE_DETAILS_INVALID_CHANGE/);
 await rejectAtomic([],/SOURCE_DETAILS_INVALID_BATCH/);
 await rejectAtomic({},/SOURCE_DETAILS_INVALID_BATCH/);
 await rejectAtomic(Array(20001).fill(change(latest,{note:'Too many'})),/SOURCE_DETAILS_INVALID_BATCH/);
 for(const invalid of [[], 'text', {other:'unknown'}, {basic:123}, {basic:null}, {basic:'x'.repeat(1001)},
  {provenance:{}},{provenance:{sheet:'Bank',row:0}},{provenance:{sheet:'Bank',row:1.5}},
  {provenance:{sheet:'Bank',row:'2'}},{provenance:{sheet:'Bank',row:2147483648}},
  {provenance:{sheet:'',row:2}},{provenance:{sheet:'Bank',row:2,owner_id:outsider}},
  {provenance:{sheet:'Bank',row:2,url:'javascript:alert(1)'}}]){
  await rejectAtomic([change(latest,invalid)],/SOURCE_DETAILS_INVALID_CHANGE/);
 }
 await assert.rejects(db.query('update public.fd_transactions set source_details=$2 where id=$1',[old.id,json({id:outsider})]),/SOURCE_DETAILS_INVALID/);checks++;
 await assert.rejects(scalar('select public.fd_import_transactions($1,$2,$3)',[account,upload,json([row(account,{source_details:{basic:'x'.repeat(1001)}})])]),/SOURCE_DETAILS_INVALID/);checks++;

 const sheetNew=sheetInsert(account,{description:'New sheet recipient',source_details:{basic:'Sheet bank text',counterparty:'Synthetic recipient',provenance:{sheet:'Sheet A',row:9,url:source}}});
 const sheetResult=await sheetApply([sheetNew]);
 ok(sheetResult.inserted===1&&(await snapshot(sheetNew.id)).source_details.counterparty==='Synthetic recipient','sheet RPC persists metadata for new rows');
 const provenanceOnly=sheetInsert(account,{description:'Source location only',source_details:{provenance:{sheet:'Original source',row:12,url:source}}});
 await sheetApply([provenanceOnly]);
 ok((await snapshot(provenanceOnly.id)).source_details.provenance.row===12,'valid provenance-only metadata is retained on a new transaction');
 const sheetOriginal=await snapshot(sheetNew.id),sheetPlan=sheetUpdate(sheetOriginal,{source_details:{detail:'Added by link'}}),sheetRun=randomUUID();
 ok((await sheetApply([sheetPlan],sheetRun)).updated===1,'sheet RPC recognizes metadata-only changes');
 const sheetAfter=await snapshot(sheetNew.id);
 ok(sheetAfter.source_details.basic==='Sheet bank text'&&sheetAfter.source_details.detail==='Added by link','sheet metadata merges nonempty fields without erasing existing source text');
 const journal=await scalar('select changes from public.fd_sheet_imports where id=$1',[sheetRun]);
 ok(journal.before[0].source_details.counterparty==='Synthetic recipient'&&journal.after[0].source_details.detail==='Added by link','existing sheet journal records source details before and after');
 ok((await sheetApply([sheetPlan],sheetRun)).updated===1,'same-run retry returns prior metadata update result');
 await rejectSheet([sheetUpdate(sheetOriginal,{source_details:{note:'Stale sheet metadata'}})],/SHEET_STALE/);
 const omitted=sheetUpdate(await snapshot(sheetNew.id));delete omitted.row.source_details;
 ok((await sheetApply([omitted])).unchanged===1,'omitted row metadata preserves saved details and remains a no-op');
 const nullRow=sheetUpdate(await snapshot(sheetNew.id),{source_details:null});
 ok((await sheetApply([nullRow])).unchanged===1,'null row metadata also preserves saved details');
 const emptyNew=sheetInsert(account,{description:'No metadata yet'});await sheetApply([emptyNew]);
 const legacy=sheetUpdate(await snapshot(emptyNew.id),{raw_gwamok:'Legacy caller'});delete legacy.expected.source_details;delete legacy.row.source_details;
 ok((await sheetApply([legacy])).updated===1,'pre-migration expected payload remains compatible for an empty metadata row');
 const concurrent=sheetUpdate(await snapshot(sheetNew.id),{raw_gwamok:'Stale partial JSON'});delete concurrent.expected.source_details.detail;
 await rejectSheet([concurrent],/SHEET_STALE/);
 const duplicateA=sheetInsert(account,{description:'Duplicate fixture',balance:1500,source_details:{basic:'Same bank text'}});
 const duplicateB=sheetInsert(account,{description:'Duplicate fixture',balance:null,dedup_hash:sha('duplicate-fixture-null'),source_details:{counterparty:'Only this row knows recipient'}});
 await sheetApply([duplicateA,duplicateB]);
 await rejectSheet([sheetUpdate(await snapshot(duplicateA.id),{},[await snapshot(duplicateB.id)])],/SHEET_DUPLICATE_SOURCE_DETAILS/);
 ok((await sheetApply([sheetUpdate(await snapshot(duplicateA.id),{source_details:{counterparty:'Only this row knows recipient'}},[await snapshot(duplicateB.id)])])).removed===1,'explicitly preserved duplicate metadata permits an otherwise valid merge');
 const invalidSheet=sheetInsert(account,{source_details:{basic:4}});
 await rejectSheet([sheetUpdate(await snapshot(sheetNew.id),{raw_gwamok:'Must roll back'}),invalidSheet],/SOURCE_DETAILS_INVALID/);

 // The enrichment RPC must not invalidate a linked internal transfer.
 const otherBusiness=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Other business') returning id",[owner]);
 const otherAccount=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Other business bank') returning id",[owner,otherBusiness]);
 const outgoing=sheetInsert(account,{description:'Internal fixture',is_internal:true,balance:3000});
 const incoming=sheetInsert(otherAccount,{description:'Internal fixture',direction:'in',is_internal:true,balance:3100});
 await sheetApply([outgoing,incoming]);
 const link=await scalar('insert into public.fd_inter_company_links(owner_id,out_transaction_id,in_transaction_id) values($1,$2,$3) returning id',[owner,outgoing.id,incoming.id]);
 ok((await enrich([change(await snapshot(outgoing.id),{counterparty:'Other owned business'})])).updated===1&&await scalar('select count(*)::int from public.fd_inter_company_links where id=$1',[link])===1,'metadata enrichment preserves existing internal-transfer links');
 const bulk=Array.from({length:601},(_,i)=>sheetInsert(account,{description:'Bulk metadata '+i}));
 await sheetApply(bulk);
 const bulkChanges=[];for(const transaction of bulk)bulkChanges.push(change(await snapshot(transaction.id),{note:'One atomic batch'}));
 ok((await enrich(bulkChanges)).updated===601,'metadata enrichment supports more than 500 rows atomically');
 const bulkRollback=[];for(const transaction of bulk.slice(0,501))bulkRollback.push(change(await snapshot(transaction.id),{note:'Must roll back'}));
 bulkRollback.push(change({...await snapshot(old.id),dedup_hash:'0'.repeat(64)},{note:'Stale last row'}));
 await rejectAtomic(bulkRollback,/SOURCE_DETAILS_STALE/);

 // Seed an unrelated owner as the DB owner, then return to the authenticated
 // workspace admin: an external transaction ID never bypasses the RLS scope.
 await db.exec('reset role');
 const foreignBusiness=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Foreign fixture') returning id",[outsider]);
 const foreignAccount=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Foreign bank') returning id",[outsider,foreignBusiness]);
 const foreignId=await scalar("insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,amount,direction,description,dedup_hash) values($1,$2,$3,'2026-09-01',100,'out','Foreign fixture',$4) returning id",[outsider,foreignBusiness,foreignAccount,sha('foreign')]);
 const foreign=await snapshot(foreignId);await asUser(admin);
 await rejectAtomic([change(foreign,{note:'Cross-owner write'})],/SOURCE_DETAILS_STALE/);
 await asUser(outsider);
 ok(await scalar('select count(*)::int from public.fd_transactions')===0,'ordinary user cannot read any workspace source details');
 await assert.rejects(enrich([change(latest,{note:'Unauthorized'})]),/ADMIN_REQUIRED/);checks++;
 await db.exec('reset role;set role anon');
 await assert.rejects(enrich([change(latest,{note:'Anonymous'})]),/permission denied/);checks++;
 console.log('All '+checks+' source-details checks passed.');
}catch(error){console.error(error.message);if(error.where)console.error(error.where);process.exitCode=1;}
finally{await db.close();}
