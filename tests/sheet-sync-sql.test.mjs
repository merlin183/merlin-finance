// Synthetic fixtures in an in-memory PostgreSQL. No network or live credentials.
import assert from 'node:assert/strict';
import {bootstrapSyntheticWorkspace} from './helpers/bootstrap-workspace.mjs';
import {readFile,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const owner='10000000-0000-4000-8000-000000000001';
const admin='00000000-0000-4000-8000-000000000001';
const outsider='00000000-0000-4000-8000-000000000002';
const token='synthetic_sheet_sync_capability_12345678901234567890';
const source='https://docs.google.com/spreadsheets/d/synthetic_sync_source_12345/edit';
const sheet='Synthetic operating account';
const json=JSON.stringify,sha=value=>createHash('sha256').update(value).digest('hex');
const fingerprintA=sha('identity-a')+':'+sha('source-row-a'),fingerprintB=sha('identity-b')+':'+sha('source-row-b');
const snapshotHashA=sha('complete-source-a'),snapshotHashB=sha('complete-source-b');
let checks=0,serial=0,sourceId,account,business,otherAccount,foreignAccount,foreignCategory,category;
const ok=(value,label)=>{assert.ok(value,label);checks++;console.log('PASS',label);};
const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0];
const asAdmin=async(id=admin)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
const asAnon=async()=>{await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','',false);set role anon");};
const asPostgres=async()=>{await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','',false)");};
const context=(key=token)=>scalar('select public.fd_sheet_sync_context($1)',[key]);
const probe=(key=token)=>scalar('select public.fd_sheet_sync_probe($1)',[key]);
const finish=(result,error=null,fingerprints=null,key=token,expected=null,sourceHash=null)=>scalar('select public.fd_sheet_sync_finish($1,$2,$3,$4,$5,$6)',[key,json(result),error,fingerprints===null?null:json(fingerprints),expected===null?null:json(expected),sourceHash]);
const sync=(changes,{key=token,run=randomUUID(),hash=sha(json(changes)),summary={},fingerprints=null,expected=null,snapshotHash=null}={})=>scalar('select public.fd_apply_sheet_sync($1,$2,$3,$4,$5,$6,$7,$8)',[key,run,hash,json(changes),json(summary),fingerprints===null?null:json(fingerprints),expected===null?null:json(expected),snapshotHash]);
const human=(changes,run=randomUUID())=>scalar('select public.fd_apply_sheet_import($1,$2,$3,$4,$5)',[run,source,sha(json(changes)),json(changes),'{}']);
const snapshot=async id=>scalar("select to_jsonb(t)-'owner_id'-'created_at' from public.fd_transactions t where id=$1",[id]);
const snapshotAsAdmin=async id=>{await asAdmin();const value=await snapshot(id);await asAnon();return value;};
const state=async()=>{
 await asPostgres();
 const value={transactions:await scalar("select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.fd_transactions t"),
  source:await scalar('select to_jsonb(s) from private.fd_sheet_sync_sources s where id=$1',[sourceId]),
  journals:await scalar('select count(*)::int from public.fd_sheet_imports'),audit:await scalar('select count(*)::int from public.fd_audit_log')};
 await asAnon();return value;
};
async function rejects(changes,pattern,options={}){
 const before=await state();await assert.rejects(sync(changes,options),pattern);assert.deepEqual(await state(),before);
 ok(true,'atomic rejection '+String(pattern));
}
function insert(accountId=account,patch={}){
 const row={txn_date:'2026-09-01',txn_time:'09:10:00',source_sheet:sheet,source_row:++serial,
  amount:100,direction:'out',description:'Synthetic payment '+serial,raw_gwamok:'Synthetic fee',category_id:category,
  is_internal:false,balance:10000-serial*100,tax_invoice:false,manually_classified:true,
  source_details:{basic:'Synthetic bank original',counterparty:'Synthetic recipient',provenance:{sheet,row:serial,url:source}},...patch};
 row.dedup_hash=patch.dedup_hash||sha(['v2',accountId,row.txn_date,row.amount,row.direction,row.description,row.balance].join('|'));
 return {kind:'insert',account_id:accountId,id:randomUUID(),expected:null,row,duplicates:[]};
}
function update(transaction,patch={},duplicates=[]){
 const {id,account_id,business_id,upload_id,...row}=transaction;
 return {kind:'update',account_id,id,expected:transaction,row:{...row,source_sheet:sheet,...patch},duplicates:duplicates.map(t=>({id:t.id,expected:t}))};
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
 const directory=new URL('../supabase/migrations/',import.meta.url);
 const wrappers=['fd_apply_sheet_import','fd_sheet_sync_context','fd_apply_sheet_sync','fd_sheet_sync_finish','fd_sheet_sync_status','fd_sheet_sync_probe'];
 for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')).sort()){
  let sql=await readFile(new URL(name,directory),'utf8');
  const movesWrappers=name.endsWith('_private_sheet_sync_wrappers.sql');
  const before=movesWrappers?(await db.query("select p.proname,p.prosrc,p.proargnames,p.pronargdefaults from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[]) order by p.proname",[wrappers])).rows:null;
  if(name.endsWith('_scoped_sheet_sync.sql')||movesWrappers)sql=sql.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n');
  await db.exec(sql);
  if(movesWrappers){
   const after=(await db.query("select p.proname,p.prosrc,p.proargnames,p.pronargdefaults from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname=any($1::text[]) order by p.proname",[wrappers])).rows;
   assert.deepEqual(after.filter(p=>['fd_apply_sheet_import','fd_sheet_sync_status'].includes(p.proname)),before.filter(p=>['fd_apply_sheet_import','fd_sheet_sync_status'].includes(p.proname)));
   for(const name of ['fd_apply_sheet_sync','fd_sheet_sync_finish']){
    const original=before.find(p=>p.proname===name),next=after.find(p=>p.proname===name);
    assert.deepEqual(next.proargnames.slice(0,-1),original.proargnames);
    assert.equal(next.pronargdefaults,original.pronargdefaults+1);
   }
   ok(true,'wrapper relocation preserves admin implementations and extends sync arguments only with trailing defaults');
  }
 }
 await bootstrapSyntheticWorkspace(db,owner,'admin@example.test');
 ok(true,'all migrations including full CRLF sync migration apply');
 const exposed=(await db.query("select p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])",[wrappers])).rows;
 ok(exposed.length===6&&exposed.every(p=>!p.prosecdef&&p.proconfig.includes('search_path=\"\"')),'all six public RPCs are SECURITY INVOKER with explicit empty search_path');
 const privateImplementations=(await db.query("select p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname=any($1::text[])",[wrappers])).rows;
 ok(privateImplementations.length===6&&privateImplementations.every(p=>p.prosecdef&&p.proconfig.includes('search_path=\"\"')),'only private checked implementations retain SECURITY DEFINER');
 const anonFunctions=(await db.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and has_function_privilege('anon',p.oid,'EXECUTE') order by p.proname")).rows.map(p=>p.proname);
 assert.deepEqual(anonFunctions,['fd_apply_sheet_sync','fd_sheet_sync_context','fd_sheet_sync_finish','fd_sheet_sync_probe']);
 ok(await scalar("select has_schema_privilege('anon','private','USAGE') and not has_schema_privilege('anon','private','CREATE')"),'anon schema usage exposes only the four explicitly granted token implementations');
 ok(!(await scalar("select has_function_privilege('authenticated','private.fd_apply_sheet_import_core(uuid,uuid,text,text,jsonb,jsonb)','EXECUTE')")),'authenticated role has no direct execution grant on unchecked merge core');
 await asAdmin(owner);await scalar('select public.fd_admin_context()');
 await asAdmin();await scalar('select public.fd_admin_context()');
 business=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic business') returning id",[owner]);
 account=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Allowed account') returning id",[owner,business]);
 otherAccount=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Excluded account') returning id",[owner,business]);
 category=await scalar("insert into public.fd_categories(owner_id,name,group_name) values($1,'Synthetic fee','영업지출') returning id",[owner]);
 await asPostgres();
 const foreignBusiness=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Other owner') returning id",[outsider]);
 foreignAccount=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Other owner bank') returning id",[outsider,foreignBusiness]);
 foreignCategory=await scalar("insert into public.fd_categories(owner_id,name,group_name) values($1,'Other category','영업지출') returning id",[outsider]);
 const mappings=[{sheet,account_id:account,selected:true},{sheet:'Excluded ledger',account_id:otherAccount,selected:false}];
 sourceId=await scalar('insert into private.fd_sheet_sync_sources(owner_id,created_by,token_hash,source_url,mappings,enabled) values($1,$2,$3,$4,$5,true) returning id',[owner,admin,sha(token),source,json(mappings)]);
 ok(await scalar("select relrowsecurity from pg_class where oid='private.fd_sheet_sync_sources'::regclass"),'private capability registry also enables RLS');
 await asAdmin();
 const excluded=insert(otherAccount);await human([excluded]);
 await scalar('select public.fd_save_merchant_note($1,$2,$3,$4,$5,0)',[otherAccount,'out','transaction:'+excluded.id,'Hidden subject','Hidden synthetic note']);
 const bootstrap=insert();await human([bootstrap]);
 await scalar('select public.fd_save_merchant_note($1,$2,$3,$4,$5,0)',[account,'out','transaction:'+bootstrap.id,'Allowed subject','Preserve this note']);
 await asAnon();
 for(const invalid of [null,'short','x'.repeat(64),token+' ',token+'!'])await assert.rejects(context(invalid),/SHEET_SYNC_UNAUTHORIZED/);
 ok(true,'anonymous missing, malformed and incorrect capabilities are rejected');
 await assert.rejects(db.query('select * from private.fd_sheet_sync_sources'),/permission denied/);
 await assert.rejects(db.query('select private.fd_sheet_sync_authorize($1)',[token]),/permission denied/);
 await assert.rejects(db.query('select private.fd_apply_sheet_import_core($1,$2,$3,$4,$5,$6)',[owner,randomUUID(),source,sha('x'),'[]','{}']),/permission denied/);
 await assert.rejects(scalar('select public.fd_sheet_sync_status()'),/permission denied/);
 await assert.rejects(human([]),/permission denied/);
 ok(true,'anonymous role cannot access registry, private core, admin status or human merge');
 const initial=await context();
 const initialProbe=await probe();
 assert.deepEqual(Object.keys(initialProbe).sort(),['last_result','last_source_hash','source_id','source_url']);
 ok(initialProbe.last_source_hash===null&&initialProbe.last_result===null&&json(initialProbe).length<400,'initial probe is small and contains no dataset, fingerprints or credential');
 await assert.rejects(probe('w'.repeat(64)),/SHEET_SYNC_UNAUTHORIZED/);
 assert.deepEqual(Object.keys(initial.dataset).sort(),['accounts','aliases','audit','businesses','categories','links','notes','recurring','rules','transactions','uploads'].sort());
 ok(initial.source_id===sourceId&&initial.source_url===source&&initial.dataset.accounts.length===1&&initial.dataset.accounts[0].id===account,'context returns fixed source and allowed account only');
 ok(initial.dataset.transactions.length===1&&initial.dataset.transactions[0].id===bootstrap.id&&initial.dataset.notes.length===1,'excluded account transactions and notes are never returned');
 ok(!json(initial).includes(sha(token))&&!json(initial).includes('Hidden synthetic note')&&!Object.hasOwn(initial,'owner_id'),'context contains no credential digest, owner identity or excluded memo');
 const added=insert();const run=randomUUID(),hash=sha(json([added]));
 const result=await sync([added],{run,hash,fingerprints:[fingerprintA],expected:[],snapshotHash:snapshotHashA});
 ok(result.inserted===1&&result.updated===0,'valid source capability inserts via shared atomic core');
 const saved=await snapshotAsAdmin(added.id);
 ok(saved.source_details.basic===added.row.source_details.basic&&saved.category_id===category&&saved.id===added.id,'sheet category and original source details survive automated import');
 assert.deepEqual((await context()).source_fingerprints,[fingerprintA]);
 ok((await probe()).last_source_hash===snapshotHashA&&(await context()).last_source_hash===snapshotHashA,'successful atomic apply advances cheap source snapshot and context together');
 const after=await state();
 assert.deepEqual(await sync([added],{run,hash,fingerprints:[fingerprintA],expected:[],snapshotHash:snapshotHashA}),result);
 const replay=await state();
 ok(replay.transactions.length===after.transactions.length&&replay.journals===after.journals&&replay.audit===after.audit,'retry returns same result without duplicate transaction or journal');
 await rejects([added],/SHEET_RUN_CONFLICT/,{run,hash:sha('different-run'),fingerprints:[fingerprintB],expected:[fingerprintA]});
 await rejects([insert(otherAccount)],/SHEET_SYNC_SCOPE_MISMATCH/,{fingerprints:[fingerprintB],expected:[fingerprintA]});
 await rejects([insert(foreignAccount)],/SHEET_SYNC_SCOPE_MISMATCH/);
 await rejects([insert(account,{source_sheet:'Unregistered sheet'})],/SHEET_SYNC_SCOPE_MISMATCH/);
 await rejects([insert(account,{source_details:{basic:'Test',provenance:{sheet,row:2,url:source+'?other=1'}}})],/SHEET_SYNC_SOURCE_MISMATCH/);
 await rejects([insert(account,{source_details:{basic:'Test',provenance:{sheet:'Different ledger',row:2,url:source}}})],/SHEET_SYNC_SOURCE_MISMATCH/);
 await rejects([insert(account,{owner_id:outsider})],/SHEET_SYNC_SCOPE_MISMATCH/);
 await rejects([insert(account,{category_id:foreignCategory})],/foreign key/,{fingerprints:[fingerprintB],expected:[fingerprintA]});
 await rejects([update(saved,{},[{...saved,id:excluded.id,account_id:otherAccount}])],/SHEET_SYNC_SCOPE_MISMATCH/);
 await rejects([{...update(saved),expected:{...saved,account_id:otherAccount}}],/SHEET_SYNC_SCOPE_MISMATCH/);
 await rejects([{...update(saved),id:excluded.id,expected:{...saved,id:excluded.id}}],/SHEET_SYNC_SCOPE_MISMATCH/);
 const conflict=update(saved,{raw_gwamok:'New sheet fee'});
 await asAdmin();await db.query('update public.fd_transactions set tax_invoice=true where id=$1',[saved.id]);await asAnon();
 await rejects([insert(),conflict],/SHEET_STALE/,{fingerprints:[fingerprintB],expected:[fingerprintA],snapshotHash:snapshotHashB});
 ok((await probe()).last_source_hash===snapshotHashA,'stale financial rollback also preserves source snapshot hash');
 await rejects([insert()],/SHEET_SYNC_INVALID_SNAPSHOT/,{fingerprints:[fingerprintB],expected:[fingerprintA],snapshotHash:'not-a-hash'});
 await rejects([insert()],/SHEET_SYNC_INVALID_SNAPSHOT/,{snapshotHash:snapshotHashB});
 ok((await context()).source_fingerprints[0]===fingerprintA,'failed financial transaction cannot advance source checkpoint');
 const fresh=await snapshotAsAdmin(saved.id);
 const upgraded=update(fresh,{source_details:{detail:'Additional original detail',provenance:{sheet,row:99,url:source}}});
 const upgradedResult=await sync([upgraded],{fingerprints:[fingerprintA,fingerprintB],expected:[fingerprintA]});
 const enriched=await snapshotAsAdmin(saved.id);
 ok(upgradedResult.updated===1&&enriched.source_details.basic===saved.source_details.basic&&enriched.source_details.detail==='Additional original detail','existing original fields are merged rather than erased');
 assert.deepEqual((await context()).source_fingerprints,[fingerprintA,fingerprintB]);
 await asAdmin();
 ok(await scalar('select count(*)::int from public.fd_merchant_notes where account_id=$1',[account])===1,'existing transaction memo remains attached');
 const duplicateA=insert(account,{description:'Exact repeat',balance:40000});
 const duplicateB=insert(account,{description:'Exact repeat',balance:40000,dedup_hash:sha('legacy-duplicate')});
 // Equal stored details establish valid duplicate evidence for the human RPC.
 duplicateB.row.source_details=duplicateA.row.source_details;
 await human([duplicateA,duplicateB]);
 const keep=await snapshot(duplicateA.id),remove=await snapshot(duplicateB.id);
 await asAnon();await rejects([update(keep,{},[remove])],/SHEET_SYNC_DUPLICATE_REVIEW/);
 await asAdmin();const humanCleanup=await human([update(keep,{},[remove])]);
 ok(humanCleanup.removed===1&&await scalar('select count(*)::int from public.fd_transactions where id=$1',[remove.id])===0,'human-authorized duplicate cleanup still uses original validation');
 const status=await scalar('select public.fd_sheet_sync_status()');
 ok(status.length===1&&status[0].source_id===sourceId&&status[0].enabled&&!json(status).includes(sha(token))&&!Object.hasOwn(status[0],'source_fingerprints'),'admin status is safe and excludes credentials and checkpoint storage');
 await assert.rejects(db.query('select * from private.fd_sheet_sync_sources'),/permission denied/);
 await assert.rejects(db.query('select private.fd_apply_sheet_import_core($1,$2,$3,$4,$5,$6)',[owner,randomUUID(),source,sha('x'),'[]','{}']),/permission denied/);
 ok(true,'authenticated administrators still cannot bypass wrappers or read token registry');
 await asAdmin(outsider);await assert.rejects(scalar('select public.fd_sheet_sync_status()'),/ADMIN_REQUIRED/);await assert.rejects(human([]),/ADMIN_REQUIRED/);
 ok(true,'ordinary signed-in users cannot use status or interactive merge');
 await asAnon();
 for(const fingerprints of [[fingerprintA,fingerprintA],['not-a-hash'],{},Array(20001).fill(fingerprintA)])await assert.rejects(sync([],{fingerprints}),/SHEET_SYNC_INVALID_FINGERPRINTS/);
 ok(true,'invalid, duplicate or oversized fingerprint checkpoints are rejected');
 const beforeWrong=await state();await assert.rejects(finish({inserted:1},null,[sha('wrong')],'w'.repeat(64)),/SHEET_SYNC_UNAUTHORIZED/);assert.deepEqual(await state(),beforeWrong);
 ok(true,'wrong token cannot record success or alter checkpoints');
 await finish({unchanged:2,status:'unchanged',transactions:[{private:'discard'}]},null,[fingerprintB],token,[fingerprintA,fingerprintB],snapshotHashB);
 assert.deepEqual((await context()).source_fingerprints,[fingerprintB]);
 ok((await probe()).last_source_hash===snapshotHashB,'successful no-op finish advances snapshot only with checkpoint compare-and-swap');
 const checkpointState=await state();
 await assert.rejects(finish({unchanged:1},null,[fingerprintA],token,[]),/SHEET_SYNC_STALE_CHECKPOINT/);
 assert.deepEqual(await state(),checkpointState);
 await rejects([insert()],/SHEET_SYNC_STALE_CHECKPOINT/,{fingerprints:[fingerprintA],expected:[]});
 await rejects([insert()],/SHEET_SYNC_STALE_CHECKPOINT/,{fingerprints:[fingerprintA]});
 ok(true,'stale no-op and apply checkpoints cannot rewind source progress');
 await asAdmin();const safeStatus=(await scalar('select public.fd_sheet_sync_status()'))[0];await asAnon();
 ok(safeStatus.last_result.unchanged===2&&!Object.hasOwn(safeStatus.last_result,'transactions'),'finish records only whitelisted aggregate result fields');
 await finish({status:'failed'},'private financial details must never be retained',[fingerprintA],token,null,snapshotHashA);
 assert.deepEqual((await context()).source_fingerprints,[fingerprintB]);
 ok((await probe()).last_source_hash===snapshotHashB,'error finish never advances source snapshot');
 await asAdmin();ok((await scalar('select public.fd_sheet_sync_status()'))[0].last_error==='SHEET_SYNC_FAILED','freeform errors become a safe generic code');await asAnon();
 await finish({status:'failed'},'SHEET_SYNC_FETCH_FAILED');
 await asAdmin();ok((await scalar('select public.fd_sheet_sync_status()'))[0].last_error==='SHEET_SYNC_FETCH_FAILED','bounded machine error code remains visible');await asAnon();
 await assert.rejects(finish({inserted:-1}),/SHEET_SYNC_INVALID_RESULT/);
 await assert.rejects(finish({updated:'123'}),/SHEET_SYNC_INVALID_RESULT/);
 await assert.rejects(finish({},null,null,token,null,snapshotHashA),/SHEET_SYNC_INVALID_SNAPSHOT/);
 await assert.rejects(finish({},null,[fingerprintB],token,[fingerprintB],'invalid'),/SHEET_SYNC_INVALID_SNAPSHOT/);
 await finish({status:'completed'});
 ok((await probe()).last_source_hash===snapshotHashB,'status-only finish preserves the committed source snapshot');
 await scalar('select public.fd_sheet_sync_finish($1,$2)',[token,'{}']);
 await scalar('select public.fd_apply_sheet_sync($1,$2,$3,$4,$5)',[token,randomUUID(),sha('legacy-defaults'),'[]','{}']);
 ok((await probe()).last_source_hash===snapshotHashB,'legacy RPC calls still resolve through trailing argument defaults');
 await asPostgres();await db.query('update private.fd_sheet_sync_sources set enabled=false where id=$1',[sourceId]);await asAnon();
 await assert.rejects(context(),/SHEET_SYNC_UNAUTHORIZED/);await assert.rejects(probe(),/SHEET_SYNC_UNAUTHORIZED/);await assert.rejects(sync([]),/SHEET_SYNC_UNAUTHORIZED/);await assert.rejects(finish({}),/SHEET_SYNC_UNAUTHORIZED/);
 ok(true,'disabling source immediately revokes read, write and finish capabilities');
 await asPostgres();await db.query('update private.fd_sheet_sync_sources set enabled=true where id=$1',[sourceId]);
 await db.query("update private.finance_administrators set status='revoked' where user_id=$1",[admin]);await asAnon();
 await assert.rejects(context(),/SHEET_SYNC_UNAUTHORIZED/);
 await assert.rejects(probe(),/SHEET_SYNC_UNAUTHORIZED/);
 ok(true,'revoking source creator also revokes unattended automation');
 await asPostgres();await db.query("update private.finance_administrators set status='active' where user_id=$1",[admin]);
 await assert.rejects(db.query('update private.fd_sheet_sync_sources set mappings=$1 where id=$2',[json([{sheet,account_id:foreignAccount,selected:true}]),sourceId]),/SHEET_SYNC_ACCOUNT_REQUIRED/);
 await assert.rejects(db.query('update private.fd_sheet_sync_sources set mappings=$1 where id=$2',[json([{sheet,account_id:account,selected:true},{sheet,account_id:account,selected:true}]),sourceId]),/SHEET_SYNC_INVALID_MAPPINGS/);
 await assert.rejects(db.query('update private.fd_sheet_sync_sources set source_url=$1 where id=$2',['https://example.test/private',sourceId]),/check constraint/);
 await db.query('update private.fd_sheet_sync_sources set mappings=$1 where id=$2',[json([{sheet,account_id:otherAccount,selected:true}]),sourceId]);
 ok((await scalar('select source_fingerprints from private.fd_sheet_sync_sources where id=$1',[sourceId])).length===0,'scope changes invalidate old source fingerprints');
 ok(await scalar('select last_source_hash is null from private.fd_sheet_sync_sources where id=$1',[sourceId]),'scope changes also invalidate the cheap source snapshot to force next full sync');
 await asAnon();ok((await context()).dataset.accounts[0].id===otherAccount,'scope changes affect the next token read without changing token identity');
 await asPostgres();await db.query('update private.finance_workspace set data_owner_id=$1',[outsider]);await asAnon();
 await assert.rejects(context(),/SHEET_SYNC_UNAUTHORIZED/);
 ok(true,'registry cannot continue across a changed workspace owner');
 console.log(`Completed ${checks} scoped sheet synchronization database checks.`);
}finally{await db.close();}
