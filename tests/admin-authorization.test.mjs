// Isolated PostgreSQL test only. Never creates users or records in Supabase.
// Uses the repository's pinned PGlite dependency; no external database needed.
import assert from 'node:assert/strict';
import {bootstrapSyntheticWorkspace} from './helpers/bootstrap-workspace.mjs';
import {readFile,readdir} from 'node:fs/promises';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const owner='10000000-0000-4000-8000-000000000001';
const first='00000000-0000-4000-8000-000000000001';
const second='00000000-0000-4000-8000-000000000002';
const outsider='00000000-0000-4000-8000-000000000003';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;console.log('PASS',label)};
async function asUser(id){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated')}
async function denied(sql,params=[],pattern){await assert.rejects(db.query(sql,params),pattern);checks++}
async function scalar(sql,params=[]){return Object.values((await db.query(sql,params)).rows[0])[0]}
try{
 await db.exec(`
 create role anon; create role authenticated;
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
 for(const [id,email] of [[owner,'owner@example.test'],[first,'admin@example.test'],[second,'second@example.test'],[outsider,'outsider@example.test']]){
  await db.query('insert into auth.users values($1,$2,now())',[id,email]);
  await db.query("insert into auth.identities values($1,'google',$2)",[id,JSON.stringify({email,email_verified:true})]);
 }
 const migrations=new URL('../supabase/migrations/',import.meta.url);
 const migrationNames=(await readdir(migrations)).filter(n=>n.endsWith('.sql')).sort();
 const sharedIndex=migrationNames.findIndex(n=>n.endsWith('_shared_workspace_administrators.sql'));
 assert.ok(sharedIndex>0);
 for(const name of migrationNames.slice(0,sharedIndex)){
  await db.exec(await readFile(new URL(name,migrations),'utf8'));
 }
 const biz=await scalar('insert into public.fd_businesses(owner_id,name) values($1,\'preserved business\') returning id',[owner]);
 const account=await scalar('insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,\'shared account\') returning id',[owner,biz]);
 const upload=await scalar('insert into public.fd_uploads(owner_id,account_id,filename,storage_path) values($1,$2,\'fixture.csv\',$3) returning id',[owner,account,`${owner}/fixture.csv`]);
 await db.query("insert into storage.objects(bucket_id,name) values('finance-uploads',$1)",[`${owner}/fixture.csv`]);
 for(const name of migrationNames.slice(sharedIndex)){
  await db.exec(await readFile(new URL(name,migrations),'utf8'));
 }

 await bootstrapSyntheticWorkspace(db,owner,'admin@example.test');
 await asUser(owner);
 ok((await scalar('select public.fd_admin_context()')).owner_id===owner,'existing administrator retains access and shared namespace');
 ok(await scalar('select count(*)::int from public.fd_businesses')===1,'existing administrator keeps access to preserved rows');
 ok(await scalar('select count(*)::int from storage.objects')===1,'existing administrator keeps access to original files');
 const ownerId=(await scalar('select public.fd_admin_list()')).members.find(m=>m.is_self).id;
 await denied('select public.fd_admin_revoke($1)',[ownerId],/LAST_ADMIN/);
 await denied('select public.fd_admin_invite($1)',['OWNER@EXAMPLE.TEST'],/ALREADY_ADMIN/);
 await asUser(outsider);
 ok((await scalar('select public.fd_admin_context()')).is_admin===false,'uninvited verified Google user is denied');
 ok(await scalar('select count(*)::int from public.fd_businesses')===0,'uninvited user cannot read shared rows');
 ok(await scalar('select count(*)::int from storage.objects')===0,'uninvited user cannot read original files');
 await denied('select public.fd_admin_invite($1)',['outsider@example.test'],/ADMIN_REQUIRED/);
 await denied('select public.fd_admin_list()',[],/ADMIN_REQUIRED/);
 await denied('select * from private.finance_administrators',[],/permission denied/);
 await denied('insert into public.fd_businesses(owner_id,name) values($1,\'forbidden\')',[owner],/row-level security/);
 await denied('select public.fd_delete_my_data()',[],/Unauthorized/);

 await asUser(first);
 ok((await scalar('select public.fd_admin_context()')).owner_id===owner,'explicit invitation binds verified Google user to shared namespace');
 ok(await scalar('select count(*)::int from public.fd_businesses')===1,'new admin reads preserved previous-owner rows');
 ok(await scalar('select count(*)::int from storage.objects')===1,'new admin reads shared storage');
 const firstId=(await scalar('select public.fd_admin_list()')).members.find(m=>m.email==='admin@example.test').id;
 ok((await scalar('select public.fd_admin_list()')).members.filter(m=>m.status==='active').length===2,'both requested administrators coexist');
 await denied('select public.fd_admin_invite($1)',['ADMIN@EXAMPLE.TEST'],/ALREADY_ADMIN/);
 await denied('select public.fd_admin_invite($1)',['bad-address'],/INVALID_EMAIL/);

 await db.query('select public.fd_admin_invite($1)',['  SECOND@EXAMPLE.TEST  ']);
 await asUser(outsider);
 ok((await scalar('select public.fd_admin_context()')).is_admin===false,'wrong Google email cannot accept another email invitation');
 await db.exec('reset role');
 await db.query("update private.finance_administrators set expires_at=now()-interval '1 second' where email='second@example.test'");
 await asUser(second);
 ok((await scalar('select public.fd_admin_context()')).is_admin===false,'expired invitation cannot be accepted');
 await asUser(first);await db.query('select public.fd_admin_invite($1)',['second@example.test']);
 await db.exec('reset role');
 await db.query("update auth.identities set identity_data=jsonb_set(identity_data,'{email_verified}','false') where user_id=$1",[second]);
 await asUser(second);
 ok((await scalar('select public.fd_admin_context()')).is_admin===false,'unverified provider email cannot accept invitation');
 await db.exec('reset role');
 await db.query("update auth.identities set identity_data=jsonb_set(identity_data,'{email_verified}','true') where user_id=$1",[second]);
 await asUser(second);
 ok((await scalar('select public.fd_admin_context()')).owner_id===owner,'second administrator accepts and shares same data namespace');
 await db.query('insert into public.fd_businesses(owner_id,name) values($1,\'created by second admin\')',[owner]);
 await denied('insert into public.fd_businesses(owner_id,name) values($1,\'wrong namespace\')',[second],/row-level security/);
 await db.query("insert into public.fd_audit_log(owner_id,actor_id,action) values($1,$2,'test')",[owner,first]);
 ok(await scalar('select actor_id from public.fd_audit_log limit 1')===second,'audit actor is actual caller, not supplied actor');
 await denied('update public.fd_audit_log set actor_id=$1',[first],/permission denied/);
 ok(await scalar('select public.fd_import_transactions($1,$2,$3)',[account,upload,JSON.stringify([{txn_date:'2026-09-17',amount:100,direction:'in',description:'fixture',raw_gwamok:'',category_id:null,is_internal:false,balance:100,tax_invoice:false,dedup_hash:'test-shared-import'}])])===1,'import RPC writes shared owner namespace');
 const transaction=await scalar('select id from public.fd_transactions limit 1');
 const saveNote=(memo,version)=>scalar('select public.fd_save_merchant_note($1,$2,$3,$4,$5,$6)',[account,'in','exact:fixture','fixture',memo,version]);
 const note=await saveNote('서비스 역할\n고객 안내에 사용',0);
 ok(note.memo==='서비스 역할\n고객 안내에 사용'&&note.version===1&&note.updated_by===second,'note preserves multiline content and actual administrator');
 await denied('select public.fd_save_merchant_note($1,$2,$3,$4,$5,$6)',[account,'in','exact:fixture','fixture','stale',0],/NOTE_STALE/);
 await asUser(first);
 ok(await scalar('select memo from public.fd_merchant_notes limit 1')===note.memo,'another administrator reads shared merchant note');
 ok((await saveNote('다른 관리자의 메모',1)).version===2,'another administrator updates shared note');
 await asUser(second);
 await denied('select public.fd_save_merchant_note($1,$2,$3,$4,$5,$6)',[account,'in','exact:fixture','fixture','stale',1],/NOTE_STALE/);
 ok((await saveNote('',2)).version===3,'clearing memo retains revision to prevent stale overwrites');
 await denied('select public.fd_save_merchant_note($1,$2,$3,$4,$5,$6)',[account,'in','exact:fixture','fixture','x'.repeat(2001),3],/INVALID_NOTE/);
 await asUser(outsider);
 ok(await scalar('select count(*)::int from public.fd_merchant_notes')===0,'non-admin cannot read notes');
 await denied('select public.fd_save_merchant_note($1,$2,$3,$4,$5,$6)',[account,'in','exact:fixture','fixture','forbidden',3],/ADMIN_REQUIRED/);
 await denied("insert into public.fd_merchant_notes(owner_id,account_id,direction,subject_key,label,memo) values($1,$2,'out','forbidden','forbidden','test')",[owner,account],/row-level security/);
 await asUser(second);
 ok(await scalar('select public.fd_reclassify_transactions($1)',[JSON.stringify([{id:transaction,category_id:null,is_internal:true}])])===1,'reclassification RPC sees shared transactions');

 await asUser(first);
 ok(await scalar('select count(*)::int from public.fd_businesses')===2,'administrators see each other writes');
 await db.query('select public.fd_admin_invite($1)',['outsider@example.test']);
 await asUser(second);await db.query('select public.fd_admin_revoke($1)',[firstId]);
 // Exercise explicit revocation of the initial installation administrator.
 await db.query('select public.fd_admin_revoke($1)',[ownerId]);
 const secondId=(await scalar('select public.fd_admin_list()')).members.find(m=>m.is_self).id;
 await denied('select public.fd_admin_revoke($1)',[secondId],/LAST_ADMIN/);
 await asUser(owner);
 ok((await scalar('select public.fd_admin_context()')).is_admin===false,'data owner identity alone does not restore explicitly revoked membership');
 ok(await scalar('select count(*)::int from public.fd_businesses')===0,'explicitly revoked data owner cannot read shared data');
 await asUser(first);
 ok((await scalar('select public.fd_admin_context()')).is_admin===false,'revoked bootstrap administrator is not re-granted');
 ok(await scalar('select count(*)::int from public.fd_transactions')===0,'revoked existing session cannot read finance data');
 ok(await scalar('select count(*)::int from public.fd_merchant_notes')===0,'revoked administrator cannot read merchant notes');
 ok(await scalar('select count(*)::int from storage.objects')===0,'revoked existing session cannot read files');
 await denied("insert into storage.objects(bucket_id,name) values('finance-uploads',$1)",[`${owner}/denied.csv`],/row-level security/);
 await denied('select public.fd_admin_invite($1)',['outsider@example.test'],/ADMIN_REQUIRED/);
 await asUser(outsider);
 ok((await scalar('select public.fd_admin_context()')).is_admin===false,'revoked inviter cannot leave an accepted pending invitation');
 await db.exec('reset role');
 await denied('delete from auth.users where id=$1',[owner],/foreign key/);
 await db.exec('set role anon');
 await denied('select public.fd_admin_context()',[],/permission denied/);
 await denied('select * from public.fd_businesses',[],/permission denied/);
 await denied('select * from public.fd_merchant_notes',[],/permission denied/);
 await asUser(second);
 await db.query('select public.fd_delete_my_data()');
 ok(await scalar('select count(*)::int from public.fd_businesses')===0,'admin shared-data reset deletes shared finance rows');
 ok(await scalar('select count(*)::int from public.fd_merchant_notes')===0,'shared-data reset also removes account notes');
 ok((await scalar('select public.fd_admin_context()')).is_admin===true,'shared-data reset preserves administrator membership');
 console.log(`All ${checks} authorization checks passed.`);
}finally{await db.close()}
