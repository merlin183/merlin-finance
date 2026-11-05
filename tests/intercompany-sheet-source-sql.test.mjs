// Isolated PostgreSQL fixtures only; no Supabase or Google connections.
import assert from 'node:assert/strict';
import {bootstrapSyntheticWorkspace} from './helpers/bootstrap-workspace.mjs';
import {readFile,readdir} from 'node:fs/promises';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();let checks=0;
const owner='10000000-0000-4000-8000-000000000001',admin='10000000-0000-4000-8000-000000000002',outsider='10000000-0000-4000-8000-000000000003';
const id='20000000-0000-4000-8000-000000000001',otherId='20000000-0000-4000-8000-000000000002',thirdId='20000000-0000-4000-8000-000000000003';
const operation='30000000-0000-4000-8000-000000000001',operation2='30000000-0000-4000-8000-000000000002';
const ok=(condition,label)=>{assert.ok(condition,label);checks++;console.log('PASS',label);};
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const asUser=async user=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');};
const denied=async(operation,pattern)=>{await assert.rejects(operation,pattern);checks++;};
const read=()=>scalar('select public.fd_read_intercompany_register()');
const save=change=>scalar('select public.fd_save_intercompany_register($1)',[JSON.stringify(change)]);
const begin=op=>scalar('select public.fd_begin_intercompany_sheet_sync($1)',[op]);
const end=token=>scalar('select public.fd_end_intercompany_sheet_sync($1)',[token]);
const apply=(context,snapshot,amendments=[])=>scalar('select public.fd_apply_intercompany_sheet_sync($1,$2,$3,$4,$5,$6)',[context.token,context.revision,context.baseline_hash,context.native_hash,JSON.stringify(snapshot),JSON.stringify(amendments)]);
const claim=(entry,syncToken)=>syncToken?scalar('select public.fd_claim_intercompany_sheet_for_sync($1,$2)',[entry,syncToken]):scalar('select public.fd_claim_intercompany_sheet($1)',[entry]);
const finish=(entry,lease,success=true)=>scalar('select public.fd_finish_intercompany_sheet($1,$2,$3,$4,$5)',[entry,lease.token,lease.lease_version,success,success?'':'Synthetic failure']);
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
 for(const [user,email] of [[owner,'owner@example.test'],[admin,'admin@example.test'],[outsider,'outsider@example.test']]){await db.query('insert into auth.users values($1,$2,now())',[user,email]);await db.query("insert into auth.identities values($1,'google',$2)",[user,JSON.stringify({email,email_verified:true})]);}
 const directory=new URL('../supabase/migrations/',import.meta.url);
 for(const file of (await readdir(directory)).filter(f=>f.endsWith('.sql')).sort()){
  let sql=await readFile(new URL(file,directory),'utf8');await db.exec(sql);
 }
 await bootstrapSyntheticWorkspace(db,owner,'admin@example.test');
 await asUser(admin);await scalar('select public.fd_admin_context()');
 const baseline={source_url:'https://docs.google.com/spreadsheets/d/synthetic-source-document/edit',gid:'1',mirror_gid:'2',mirror_sheet_name:'사업자간 대여금_대시보드기록',as_of:'2020-10-20',coverage_start:'2020-01-01',opening_balance_known:false,totals_include_additions:true,notes:['Synthetic original'],businesses:[{key:'a',name:'Synthetic A',business_id:null},{key:'b',name:'Synthetic B',business_id:null}],pairs:[{business_a:'a',business_b:'b',a_to_b:500,b_to_a:100,note:'Synthetic source'}],additions:[{id:'source-row-48',date:'2020-10-01',from_business:'a',to_business:'b',amount:50,kind:'loan',memo:'Original source'}]};
 await db.exec('reset role');await db.query('insert into public.fd_intercompany_baselines(owner_id,payload) values($1,$2)',[owner,JSON.stringify(baseline)]);await asUser(admin);
 const baselineBefore=await scalar('select to_jsonb(b) from public.fd_intercompany_baselines b where owner_id=$1',[owner]);
 const business=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic source business') returning id",[owner]);
 const account=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic account') returning id",[owner,business]);
 const transaction=await scalar("insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,amount,direction,description,dedup_hash) values($1,$2,$3,'2020-10-21',100,'out','Synthetic transfer','synthetic-source-only') returning id",[owner,business,account]);
 const ledgerBefore=await scalar('select to_jsonb(t) from public.fd_transactions t where id=$1',[transaction]);
 const create={action:'create',id,from_party:'a',to_party:'b',entry_date:'2020-10-21',amount:100,kind:'loan',memo:'Native memo'};
 await save(create);await save({...create,id:otherId});
 const nativeBefore=(await read()).entries.find(e=>e.id===id);
 ok(!('sheet_sync'in await read())&&!('source_row_key'in nativeBefore),'old strict clients see no new null fields before first source import');
 const inFlight=await claim(otherId);ok(!('previous_row'in inFlight),'ordinary old-client claim omits null previous-row field');
 await denied(()=>begin(operation),/INTERCOMPANY_SYNC_BUSY/);await finish(otherId,inFlight);
 let context=await begin(operation);
 ok(context.revision===0&&typeof context.token==='string'&&context.register.entries.length===2,'shared workspace lease returns current hashes and safe register');
 const renewed=await begin(operation);ok(renewed.token===context.token,'same operation renews its bounded lease without changing token');
 await denied(()=>begin(operation2),/INTERCOMPANY_SYNC_BUSY/);await denied(()=>save({...create,id:thirdId}),/INTERCOMPANY_SYNC_BUSY/);
 await denied(()=>save({action:'set_voided',id,version:1,voided:true}),/INTERCOMPANY_SYNC_BUSY/);await denied(()=>claim(id),/INTERCOMPANY_SYNC_BUSY/);
 await asUser(owner);await denied(()=>begin(operation2),/INTERCOMPANY_SYNC_BUSY/);ok(await end(context.token)===false,'another shared administrator cannot release the in-flight actor lease');await asUser(admin);
 const snapshot={fingerprint:'synthetic-source-v1',through_date:'2020-10-22',mirrored_max_row:8,historical_base_pairs:[{business_a:'a',business_b:'b',a_to_b:450,b_to_a:100}],rows:[
  {id:'source-row-48',source_row:48,date:'2020-10-01',from_business:'a',to_business:'b',amount:50,kind:'loan',memo:'Original source',native_id:null},
  {id,source_row:56,date:'2020-10-10',from_business:'a',to_business:'b',amount:120,kind:'loan',memo:'Changed source',native_id:id},
  {id:'independent-source',source_row:57,date:'2020-10-22',from_business:'a',to_business:'b',amount:100,kind:'loan',memo:'Distinct same-amount movement',native_id:null},
  {id:'mirror-import',source_row:8,date:'2020-10-22',from_business:'b',to_business:'a',amount:30,kind:'repayment',memo:'Mirror-only source',native_id:null,origin:'mirror',voided:false},
 ]};
 const previous=[id,'2020-10-21','Synthetic A','Synthetic B',100,'대여금','정상',1,'Native memo'];
 const amendment={id,version:1,source_row_key:id,entry_date:'2020-10-10',from_party:'a',to_party:'b',amount:120,kind:'loan',memo:'Changed source',voided:false,previous_row:previous};
 await denied(()=>apply({...context,revision:99},snapshot,[amendment]),/INTERCOMPANY_SYNC_STALE/);
 await denied(()=>apply({...context,native_hash:'stale'},snapshot,[amendment]),/INTERCOMPANY_SYNC_STALE/);
 await denied(()=>apply({...context,baseline_hash:'stale'},snapshot,[amendment]),/INTERCOMPANY_SYNC_STALE/);
 await denied(()=>apply(context,{...snapshot,historical_base_pairs:[{...snapshot.historical_base_pairs[0],a_to_b:-1}]},[amendment]),/INVALID_INTERCOMPANY_SYNC_PAIR/);
 await denied(()=>apply(context,{...snapshot,rows:[...snapshot.rows,snapshot.rows[0]]},[amendment]),/INVALID_INTERCOMPANY_SYNC_ROW/);
 await denied(()=>apply(context,{...snapshot,rows:[...snapshot.rows,{...snapshot.rows[0],id:'same-physical-row'}]},[amendment]),/INVALID_INTERCOMPANY_SYNC_ROW/);
 await denied(()=>apply(context,{...snapshot,mirrored_max_row:7},[amendment]),/INVALID_INTERCOMPANY_SYNC_ROW/);
 await denied(()=>apply(context,{...snapshot,rows:snapshot.rows.filter(r=>r.id!=='source-row-48')},[amendment]),/INTERCOMPANY_SYNC_KEY_MISSING/);
 await denied(()=>apply(context,{...snapshot,rows:[{...snapshot.rows[0],id:null}]},[]),/INVALID_INTERCOMPANY_SYNC_ROW/);
 await denied(()=>apply(context,snapshot,[{...amendment,version:2}]),/INTERCOMPANY_SYNC_STALE/);
 await denied(()=>apply(context,snapshot,[{...amendment,previous_row:[otherId,...previous.slice(1)]}]),/INVALID_INTERCOMPANY_SYNC_AMENDMENT/);
 ok(!('sheet_sync'in await read())&&(await read()).entries.find(e=>e.id===id).amount===100,'failed imports atomically roll back snapshot and every native change');
 let result=await apply(context,snapshot,[amendment]);
 let amended=result.register.entries.find(e=>e.id===id);
 ok(result.amended_entries===1&&result.register.sheet_sync.revision===1&&result.register.sheet_sync.rows.length===4,'one atomic import persists source rows and one amendment');
 ok(amended.amount===120&&amended.version===2&&amended.entry_date==='2020-10-10'&&amended.source_row_key===id,'source-linked actual finance can amend before baseline cutoff with version CAS');
 ok(amended.id===nativeBefore.id&&amended.sheet_row===nativeBefore.sheet_row&&amended.created_at===nativeBefore.created_at,'native ID, fixed mirror row and creation date remain immutable');
 ok(result.register.entries.length===2,'source-only records are not duplicated into native entries');
 assert.deepEqual(amended.sheet_previous_row,previous);
 ok(!('sheet_expected_previous_row'in amended)&&!('lease_token'in result.register.sheet_sync),'pending read exposes only the safe financial preimage alias and hides storage/lease metadata');
 result=await apply(context,snapshot,[amendment]);ok(result.unchanged&&result.register.entries.find(e=>e.id===id).version===2,'lost apply response retries idempotently without another version or audit');
 await denied(()=>apply(context,{...snapshot,fingerprint:'different'},[amendment]),/INTERCOMPANY_SYNC_STALE/);
 let transfer=await claim(id,context.token);assert.deepEqual(transfer.previous_row,previous);ok(transfer.lease_version===2&&!('sheet_previous_row'in transfer.entry),'sync-specific claim binds exact preimage separately while active syncing read hides the alias');
 result=await finish(id,transfer,false);assert.deepEqual(result.entries.find(e=>e.id===id).sheet_previous_row,previous);ok(result.entries.find(e=>e.id===id).sheet_status==='error','external failure preserves durable finance and safe preimage for later three-way conflict detection');
 transfer=await claim(id,context.token);assert.deepEqual(transfer.previous_row,previous);await finish(id,transfer);
 ok(await scalar('select sheet_expected_previous_row is null from public.fd_intercompany_entries where id=$1',[id]),'only successful current-version acknowledgement clears old preimage');
 ok(!('sheet_previous_row'in (await read()).entries.find(e=>e.id===id)),'successful synchronized read omits the temporary financial preimage');
 ok(await end(context.token),'same actor explicitly releases the source-sync lease');
 result=await save({...create,id:thirdId,amount:10});ok(result.entries.find(e=>e.id===thirdId).sheet_row===9,'normal app allocation skips standalone imported mirror rows');
 result=await save({action:'set_voided',id,version:2,voided:true});ok(result.entries.find(e=>e.id===id).voided&&result.entries.find(e=>e.id===id).version===3,'amended pre-baseline record can later be canceled normally');
 const cancelLease=await claim(id);await finish(id,cancelLease);
 await denied(()=>db.query('update public.fd_intercompany_entries set amount=200,version=version+1 where id=$1',[id]),/INTERCOMPANY_IDENTITY_IMMUTABLE/);
 context=await begin(operation2);
 const next=structuredClone(snapshot);next.fingerprint='synthetic-source-v2';next.rows[1].voided=true;
 await denied(()=>apply(context,{...next,rows:next.rows.filter(r=>r.native_id!==id)},[]),/INTERCOMPANY_SYNC_LINK_MISSING/);
 await denied(()=>apply(context,{...next,rows:next.rows.filter(r=>r.id!=='independent-source')},[]),/INTERCOMPANY_SYNC_KEY_MISSING/);
 await denied(()=>apply(context,{...next,rows:next.rows.map(r=>r.id==='independent-source'?{...r,id:'new-key-same-movement'}:r)},[]),/INTERCOMPANY_SYNC_KEY_MISSING/);
 const same=await apply(context,next,[]);ok(same.register.sheet_sync.revision===2&&same.register.entries.find(e=>e.id===id).version===3,'snapshot update preserves app cancellation and does not duplicate unchanged native rows');
 await end(context.token);
 context=await begin(operation);
 const basisOnly=structuredClone(next);basisOnly.fingerprint='synthetic-source-basis-only';basisOnly.historical_base_pairs[0].a_to_b=460;
 const basis=await apply(context,basisOnly,[]);ok(!basis.unchanged&&basis.changed_rows===0&&basis.register.sheet_sync.revision===3,'a historical basis-only edit is a real revision even when no individual source rows changed');
 await end(context.token);
 context=await begin(operation2);
 const repairPrevious=Array.from({length:9},()=> '');
 const repair={...amendment,version:3,voided:true,previous_row:repairPrevious};
 const repaired=await apply(context,basisOnly,[repair]);ok(repaired.register.entries.find(e=>e.id===id).sheet_status==='pending'&&repaired.register.entries.find(e=>e.id===id).version===3,'explicit missing fixed-row repair retains financial version and changes transport state only');
 const repairLease=await claim(id,context.token);assert.deepEqual(repairLease.previous_row,repairPrevious);await finish(id,repairLease);await end(context.token);
 const events=(await db.query("select detail from public.fd_audit_log where action='사업자간 대여금 시트 수정'")).rows;
 const audit=JSON.parse(events[0].detail);ok(events.length===1&&audit.before.amount===100&&audit.after.amount===120,'source amendment audit preserves exact old/new financial values');
 ok(await scalar('select count(*)::int from public.fd_intercompany_sheet_history')===3,'source revisions are append-only history');
 await denied(()=>db.query('update public.fd_intercompany_sheet_history set revision=99'),/permission denied/);
 assert.deepEqual(await scalar('select to_jsonb(b) from public.fd_intercompany_baselines b where owner_id=$1',[owner]),baselineBefore);
 assert.deepEqual(await scalar('select to_jsonb(t) from public.fd_transactions t where id=$1',[transaction]),ledgerBefore);
 ok(await scalar('select count(*)::int from public.fd_transactions')===1,'source import leaves original baseline, ledger and bank balances unchanged');
 context=await begin(operation);
 await db.exec('reset role');await db.query("update public.fd_intercompany_sheet_state set lease_until=now()-interval '1 second' where owner_id=$1",[owner]);await asUser(admin);
 await denied(()=>apply(context,next,[]),/INTERCOMPANY_SYNC_LEASE_STALE/);
 const replaced=await begin(operation2);ok(replaced.token!==context.token,'expired workspace lease is replaced rather than reused');await end(replaced.token);
 await asUser(outsider);ok(await scalar('select count(*)::int from public.fd_intercompany_sheet_state')===0,'uninvited user cannot read workspace source state');
 await denied(()=>begin(operation),/ADMIN_REQUIRED/);await denied(()=>apply(context,next,[]),/ADMIN_REQUIRED/);await denied(()=>claim(id,context.token),/ADMIN_REQUIRED/);
 await db.exec('reset role;set role anon');await denied(()=>begin(operation),/permission denied/);await denied(()=>apply(context,next,[]),/permission denied/);await denied(()=>db.query('select * from public.fd_intercompany_sheet_state'),/permission denied/);
 await db.exec('reset role');await db.query("update private.finance_administrators set status='revoked' where user_id=$1",[admin]);await asUser(admin);await denied(()=>begin(operation),/ADMIN_REQUIRED/);
 await asUser(owner);ok((await read()).sheet_sync.revision===3,'remaining authorized administrator retains imported data');
 const functions=(await db.query("select prosecdef,proconfig from pg_proc where proname in ('fd_begin_intercompany_sheet_sync','fd_end_intercompany_sheet_sync','fd_apply_intercompany_sheet_sync','fd_claim_intercompany_sheet_for_sync')")).rows;
 ok(functions.length===4&&functions.every(f=>!f.prosecdef&&f.proconfig.includes('search_path=""')),'new public RPCs are invoker functions with fixed search paths');
 // A fresh isolated fixture exercises the production parser/planner against the real SQL RPC.
 const {syntheticBaseline,syntheticRaw,refreshSyntheticRaw}=await import('./helpers/intercompany-source-fixture.ts');
 const {parseIntercompanySheetSource}=await import('../lib/finance/intercompany-sheet-source.ts');
 const {planIntercompanySheetSync}=await import('../lib/finance/intercompany-sheet-sync-plan.ts');
 const {intercompanyRegisterSchema,buildIntercompanyRegister}=await import('../lib/finance/intercompany-register.ts');
 await db.exec('reset role');await db.query('delete from public.fd_intercompany_baselines where owner_id=$1',[owner]);
 const freshBaseline=syntheticBaseline();await db.query('insert into public.fd_intercompany_baselines(owner_id,payload) values($1,$2)',[owner,JSON.stringify(freshBaseline)]);await asUser(owner);
 const fourthId='20000000-0000-4000-8000-000000000004';
 for(const [entryId,from,to,amount,kind] of [[id,'a','b',100,'loan'],[otherId,'a','b',100,'loan'],[thirdId,'a','b',100,'loan'],[fourthId,'b','a',300,'repayment']]){
  await save({action:'create',id:entryId,from_party:from,to_party:to,entry_date:'2020-10-21',amount,kind,memo:`native provenance ${entryId}`});const outbound=await claim(entryId);await finish(entryId,outbound);
 }
 const beforeImport=intercompanyRegisterSchema.parse(await read()),raw=syntheticRaw(beforeImport);
 for(const [entryId,rowIndex] of [[id,55],[thirdId,56],[fourthId,57]]){const value=beforeImport.entries.find(e=>e.id===entryId);raw.sourceValues[rowIndex]=[value.entry_date,value.from_party==='a'?'합성회사A':'합성회사B',value.to_party==='a'?'합성회사A':'합성회사B',value.amount,entryId,'원본 F열 근거',value.kind==='loan'?'대여금':'대여금 상환',entryId];}
 refreshSyntheticRaw(raw);const source=parseIntercompanySheetSource(raw,freshBaseline),initialPlan=planIntercompanySheetSync(beforeImport,source,raw);
 ok(initialPlan.amendments.length===4&&initialPlan.amendments.every(a=>a.source_row_key===a.id),'real first planner produces metadata bindings for all four legacy native records');
 assert.deepEqual(initialPlan.summary,{added:0,updated:0,unchanged:5,basisUpdated:0});
 context=await begin(operation);const initialApplied=await apply(context,initialPlan.snapshot,initialPlan.amendments),imported=intercompanyRegisterSchema.parse(initialApplied.register);
 ok(imported.entries.length===4&&imported.entries.every(e=>e.version===2&&e.source_row_key===e.id),'real first plan applies atomically with each existing native preserved and version-bound');
 ok(imported.entries.every(e=>e.memo===beforeImport.entries.find(old=>old.id===e.id).memo)&&imported.sheet_sync.rows.some(r=>r.native_id&&r.memo!==imported.entries.find(e=>e.id===r.native_id).memo),'source F/G provenance remains observed while initial native memos stay intact');
 const actualModel=buildIntercompanyRegister(imported,[]);ok(actualModel.pairs[0].aToB===Number(raw.sourceValues[8][2])&&actualModel.pairs[0].bToA===Number(raw.sourceValues[8][3]),'first parser→planner→actual SQL→model equals both source gross totals without merging independent equal transfers');
 for(const value of imported.entries){const outbound=await claim(value.id,context.token);assert.deepEqual(outbound.previous_row,raw.mirrorValues[value.sheet_row-1]);await finish(value.id,outbound);}
 await end(context.token);
 const synchronized=intercompanyRegisterSchema.parse(await read()),nextRaw=syntheticRaw(synchronized);nextRaw.sourceValues=raw.sourceValues.map(r=>[...r]);refreshSyntheticRaw(nextRaw);
 const repeatedPlan=planIntercompanySheetSync(synchronized,parseIntercompanySheetSource(nextRaw,freshBaseline),nextRaw);
 ok(repeatedPlan.amendments.length===0&&repeatedPlan.summary.added===0&&repeatedPlan.summary.updated===0,'second real planner pass creates no metadata amendments or duplicate movement');
 console.log(`All ${checks} source sync SQL checks passed.`);
}finally{await db.close();}
