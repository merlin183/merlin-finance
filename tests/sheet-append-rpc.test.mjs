// Synthetic workbook and local PostgreSQL only. No external calls or real rows.
import assert from 'node:assert/strict';
import {bootstrapSyntheticWorkspace} from './helpers/bootstrap-workspace.mjs';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {utils,write} from '@e965/xlsx';
import {executeSheetAppendSync} from '../lib/finance/sheet-append-sync.ts';
import {buildSheetAppendPlan} from '../lib/finance/sheet-append.ts';
import {prepareSheetRows} from '../lib/finance/google-sheets.ts';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const owner=randomUUID(),email='append-sync@example.test';
const url='https://docs.google.com/spreadsheets/d/synthetic_append_sync_123456/edit';
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const state=()=>scalar("select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.fd_transactions t");
let checks=0;
const ok=(condition,label)=>{assert.ok(condition,label);checks++;console.log('PASS',label);};
function workbook(rows){const book=utils.book_new();utils.book_append_sheet(book,utils.aoa_to_sheet([['거래일자','거래시간','거래내용','입금금액(원)','출금금액(원)','거래 후 잔액(원)','계정과목'],...rows]),'Synthetic bank');return new Uint8Array(write(book,{type:'array',bookType:'xlsx'}));}
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
 await db.query('insert into auth.users values($1,$2,now())',[owner,email]);
 await db.query("insert into auth.identities values($1,'google',$2)",[owner,JSON.stringify({email,email_verified:true})]);
 const directory=new URL('../supabase/migrations/',import.meta.url);
 for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort()){
  const sql=(await readFile(new URL(name,directory),'utf8'));
  await db.exec(sql);
 }
 await bootstrapSyntheticWorkspace(db,owner);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await db.exec('set role authenticated');
 const business=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic business') returning id",[owner]);
 const account=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic bank') returning id",[owner,business]);
 const category=await scalar("insert into public.fd_categories(owner_id,name,group_name) values($1,'Synthetic fee','영업지출') returning id",[owner]);
 const source={url,mappings:[{sheet:'Synthetic bank',account_id:account,selected:true}]};
 let bytes=workbook([['2026-09-01','10:00:00','Synthetic recipient',0,100,900,'Synthetic fee']]);
 let calls=0;
 const deps={
  findRun:async id=>(await db.query('select source_url,source_hash,result from public.fd_sheet_imports where id=$1',[id])).rows[0]||null,
  fetchSource:async()=>({sourceUrl:url,bytes}),getDataset:()=>scalar('select public.fd_read_finance_dataset()'),
  apply:async payload=>{
   calls++;assert.ok(payload.p_changes.every(change=>change.kind==='insert'&&change.expected===null&&change.duplicates.length===0));
   try{return {data:await scalar('select public.fd_apply_sheet_import($1,$2,$3,$4,$5)',[payload.p_run,payload.p_source_url,payload.p_source_hash,JSON.stringify(payload.p_changes),JSON.stringify(payload.p_summary)]),error:null};}
   catch(error){return {data:null,error:{code:error.code,message:error.message}};}
  },
 };
 const firstId=randomUUID(),first=await executeSheetAppendSync(source,firstId,deps);
 ok(first.inserted===1&&first.updated===0&&first.removed===0,'real RPC accepts only new inserts and reports no updates/deletes');
 const transaction=(await state())[0];
 const upload=await scalar("insert into public.fd_uploads(owner_id,account_id,filename,storage_path) values($1,$2,'synthetic.xlsx','synthetic/bank.xlsx') returning id",[owner,account]);
 await db.query("update public.fd_transactions set raw_gwamok='Manually reviewed',category_id=$2,manually_classified=true,tax_invoice=true,upload_id=$3,source_details=source_details||'{\"memo\":\"saved original\"}'::jsonb where id=$1",[transaction.id,category,upload]);
 await scalar('select public.fd_save_merchant_note($1,$2,$3,$4,$5,0)',[account,'out','transaction:'+transaction.id,'Synthetic recipient','Preserve this note']);
 // Existing duplicate evidence has its own legacy identity; append must retain it.
 await db.query("insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,txn_time,amount,direction,description,raw_gwamok,category_id,balance,dedup_hash) values($1,$2,$3,'2026-09-01','10:00:00',100,'out','Synthetic recipient','Legacy review',$4,900,$5)",[owner,business,account,category,'f'.repeat(64)]);
 const before=await state(),notesBefore=await scalar('select jsonb_agg(to_jsonb(n)) from public.fd_merchant_notes n');
 bytes=workbook([['2026-09-01','10:00:00','Synthetic recipient',0,100,900,'Changed source category'],['2025-12-01','11:00:00','New historical payment',0,300,600,'Synthetic fee']]);
 const next=await executeSheetAppendSync(source,randomUUID(),deps),after=await state();
 ok(next.inserted===1&&next.updated===0&&next.removed===0,'historical additions save while existing duplicates and classifications remain');
 assert.deepEqual(after.filter(row=>before.some(saved=>saved.id===row.id)),before);checks++;
 assert.deepEqual(await scalar('select jsonb_agg(to_jsonb(n)) from public.fd_merchant_notes n'),notesBefore);checks++;
 const zeroId=randomUUID(),zero=await executeSheetAppendSync(source,zeroId,deps);
 ok(zero.inserted===0&&!!(await deps.findRun(zeroId)),'zero-change run is durably journaled');
 bytes=workbook([['2026-10-01','10:00:00','Later payment',0,500,500,'Synthetic fee']]);
 const replay=await executeSheetAppendSync(source,firstId,deps);
 ok(replay.inserted===1&&(await state()).length===3,'retry returns committed first result without importing later edits');
 const callsBefore=calls;
 ok((await executeSheetAppendSync(source,zeroId,deps)).inserted===0&&calls===callsBefore,'zero-change replay is idempotent too');
 // Prepare against an old snapshot, then commit a competing request before
 // the first RPC. The stale request must roll back, re-read and skip it.
 const original=deps.apply;let race=true;
 deps.apply=async payload=>{
  if(race){race=false;const other=await original({...payload,p_run:randomUUID()});assert.equal(other.error,null);}
  return original(payload);
 };
 const raceResult=await executeSheetAppendSync(source,randomUUID(),deps);
 ok(raceResult.inserted===0&&raceResult.unchanged===1&&(await state()).length===4,'real stale RPC rolls back and retry does not duplicate concurrent insert');
 // A rejected multi-row RPC must not leave the first valid insert behind.
 const loaded=await deps.getDataset();
 bytes=workbook([['2026-11-01','10:00:00','Atomic valid',0,700,700,'Synthetic fee'],['2026-11-02','10:00:00','Atomic invalid',0,800,800,'Synthetic fee']]);
 const prepared=await prepareSheetRows(bytes,loaded,source.mappings,url),plan=await buildSheetAppendPlan(loaded,prepared.incoming,prepared.sourceHash);
 plan.changes[1].row.category_id=randomUUID();
 const beforeFailure=await state(),failed=await original({p_run:randomUUID(),p_source_url:url,p_source_hash:'e'.repeat(64),p_changes:plan.changes,p_summary:{unchanged:0,blocked:0,sourceDuplicates:0}});
 assert.ok(failed.error);assert.deepEqual(await state(),beforeFailure);checks++;
 console.log(`Append-only RPC verification: ${checks} checks passed.`);
}finally{await db.close();}
