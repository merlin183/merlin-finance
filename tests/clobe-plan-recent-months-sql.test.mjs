// Synthetic local PostgreSQL only; never connects to Supabase or Clobe.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapSyntheticWorkspace} from './helpers/bootstrap-workspace.mjs';
import {readFile,readdir} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');

test('recent-month plan evidence keeps real collection batches and every source/access guard',async t=>{
 const db=new PGlite(),owner='10000000-0000-4000-8000-000000000001',admin='10000000-0000-4000-8000-000000000002',outsider='10000000-0000-4000-8000-000000000003';
 const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
 let actor=admin,key;
 const asUser=async id=>{actor=id;await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
 const sign=(wire,purpose='plan-actuals-sync',forActor=actor,forOwner=owner)=>createHmac('sha256',key).update(`merlin:clobe-import:v1\n${purpose}\n${forActor}\n${forOwner}\n${wire}`).digest('hex');
 const actualSync=async(scopes,options={})=>{
  const now=Date.now(),wire=JSON.stringify({issued_at:new Date(now).toISOString(),expires_at:new Date(now+300000).toISOString(),scopes,...options.body});
  return scalar('select public.fd_clobe_plan_actuals_sync($1,$2)',[wire,options.proof??sign(wire,options.purpose,options.actor,options.owner)]);
 };
 const balanceSync=async(snapshots)=>{const wire=JSON.stringify({snapshots});return scalar('select public.fd_clobe_balance_sync($1,$2)',[wire,sign(wire,'balance-sync')]);};
 const protectedTables=['fd_businesses','fd_accounts','fd_categories','fd_transactions','fd_merchant_notes','fd_cash_plan_edits','fd_cash_plan_series','fd_cash_plan_series_revisions'];
 const protectedState=async()=>{
  const state={};for(const table of protectedTables)state[table]=await scalar(`select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from public.${table} r`);
  return state;
 };
 const evidenceState=()=>scalar("select jsonb_build_object('coverage',(select coalesce(jsonb_agg(to_jsonb(c) order by c.account_id,c.month),'[]'::jsonb) from private.fd_clobe_plan_coverage c),'actuals',(select coalesce(jsonb_agg(to_jsonb(a) order by a.account_id,a.month,a.external_transaction_id),'[]'::jsonb) from private.fd_clobe_plan_actuals a))");
 const collected='2026-11-02T11:00:00';
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
  for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
  await bootstrapSyntheticWorkspace(db,owner,'admin@example.test');
  await asUser(admin);await scalar('select public.fd_admin_context()');
  const business=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic business') returning id",[owner]);
  await db.exec('reset role');
  const mappings=[];
  for(let index=1;index<=51;index++){
   const account_id=`40000000-0000-4000-8000-${String(index).padStart(12,'0')}`,mapping={company_id:'synthetic-company',external_account_id:String(index),account_id};
   mappings.push(mapping);
   await db.query('insert into public.fd_accounts(id,owner_id,business_id,name) values($1,$2,$3,$4)',[account_id,owner,business,`Synthetic account ${index}`]);
   await db.query('insert into private.fd_clobe_account_mappings(owner_id,company_id,external_account_id,account_id) values($1,$2,$3,$4)',[owner,mapping.company_id,mapping.external_account_id,account_id]);
  }
  const mapping=mappings[0],account=mapping.account_id;
  await db.query("insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,amount,direction,description,dedup_hash,manually_classified,source_details) values($1,$2,$3,'2026-10-01',100,'out','Synthetic saved ledger','synthetic-existing',true,'{\"memo\":\"Preserve synthetic source\"}')",[owner,business,account]);
  await db.query("insert into public.fd_cash_plan_edits(id,owner_id,business_id,source_type,source_key,month,title,account_id,plan_date,amount,memo,excluded) values('50000000-0000-4000-8000-000000000001',$1,$2,'manual','50000000-0000-4000-8000-000000000001','2026-10','Synthetic excluded salary',$3,'2026-10-15',999,'Preserve synthetic plan',true)",[owner,business,account]);
  key=Buffer.from(await scalar('select signing_key from private.fd_clobe_import_verifier where singleton'),'base64');
  const original=await protectedState();
  const bankRow=(id,date)=>({external_transaction_id:id,txn_date:date,txn_time:'10:00:00',amount:100,balance:900,description:'Synthetic fee',party:null,source_details:{basic:'Synthetic fee'}});
  const octoberRows=[bankRow('10','2026-10-01'),bankRow('11','2026-10-31')],novemberRows=[bankRow('12','2026-11-01')];
  const scope=(month,rows,extra={})=>({...mapping,from:`2026-${month}-01`,to:month==='10'?'2026-10-31':'2026-11-02',collected_at:collected,status:'complete',reason:null,rows,...extra});
  const october=scope('10',octoberRows),november=scope('11',novemberRows);
  await asUser(admin);
  await balanceSync(mappings.map(item=>({...item,balance:1000,balance_date:'2026-11-02',collected_at:collected})));

  await t.test('November collection verifies the complete previous month without faking its timestamp',async()=>{
   assert.deepEqual(await actualSync([october]),{synced_accounts:1,unchanged_accounts:0,saved_outflows:2,skipped:[]});
   const data=await scalar('select public.fd_read_finance_snapshot()'),coverage=data.bank_plan_coverage.find(row=>row.from==='2026-10-01');
   assert.equal(coverage.to,'2026-10-31');assert.equal(coverage.collected_at,collected);assert.equal(coverage.status,'complete');
   assert.ok(data.bank_plan_actuals.every(row=>row.collected_at===collected));
   assert.deepEqual(await actualSync([october,november]),{synced_accounts:1,unchanged_accounts:0,saved_outflows:3,skipped:[]});
   assert.deepEqual(await actualSync([october,november]),{synced_accounts:0,unchanged_accounts:1,saved_outflows:3,skipped:[]});
  });
  await t.test('collection before scope end, future collection, cross-month scopes and out-of-range rows reject atomically',async()=>{
   const before=await scalar('select public.fd_read_finance_snapshot()');
   for(const invalid of [
    {...october,collected_at:'2026-10-30T11:00:00'},
    {...october,collected_at:new Date(Date.now()+86400000).toISOString()},
    {...october,to:'2026-11-01'},
    {...october,rows:[bankRow('19','2026-11-01')]},
    {...november,to:'2026-11-03',rows:[bankRow('19','2026-11-03')]},
   ])await assert.rejects(actualSync([invalid]),/INVALID_PAYLOAD/);
   assert.deepEqual(await scalar('select public.fd_read_finance_snapshot()'),before);
  });
  await t.test('one account/provider ID cannot occur in both monthly scopes',async()=>{
   const before=await scalar('select public.fd_read_finance_snapshot()');
   await assert.rejects(actualSync([october,{...november,rows:[bankRow('10','2026-11-01')]}]),/INVALID_PAYLOAD/);
   assert.deepEqual(await scalar('select public.fd_read_finance_snapshot()'),before);
  });
  await t.test('a wider verified scope with unchanged rows still advances its completion boundary',async()=>{
   const other=mappings[1],partial={...october,...other,to:'2026-10-30',rows:[]};
   assert.equal((await actualSync([partial])).synced_accounts,1);
   assert.equal((await actualSync([{...partial,to:'2026-10-31'}])).synced_accounts,1);
   const data=await scalar('select public.fd_read_finance_snapshot()');
   assert.equal(data.bank_plan_coverage.find(row=>row.account_id===other.account_id&&row.from==='2026-10-01').to,'2026-10-31');
  });
  await t.test('102 monthly scopes count 51 accounts once and still enforce two scopes per account',async()=>{
   const scopes=mappings.flatMap(item=>[{...october,...item,rows:item.account_id===account?octoberRows:[]},{...november,...item,rows:item.account_id===account?novemberRows:[]}]);
   const result=await actualSync(scopes);
   assert.equal(result.synced_accounts,50);assert.equal(result.unchanged_accounts,1);assert.equal(result.saved_outflows,3);assert.deepEqual(result.skipped,[]);
   const replay=await actualSync(scopes);assert.equal(replay.synced_accounts,0);assert.equal(replay.unchanged_accounts,51);
   await assert.rejects(actualSync([october,november,{...october,from:'2026-09-01',to:'2026-09-30',rows:[]}]),/INVALID_PAYLOAD/);
   await assert.rejects(actualSync(Array.from({length:201},()=>october)),/INVALID_PAYLOAD/);
   const tooManyAccounts=Array.from({length:101},(_,index)=>({...october,account_id:`60000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,rows:[]}));
   await assert.rejects(actualSync(tooManyAccounts),/INVALID_PAYLOAD/);
   const tooManyRows=mappings.slice(0,4).map((item,index)=>({...october,...item,rows:Array.from({length:index===3?1504:1499},(_,row)=>bankRow(String(row+1),'2026-10-01'))}));
   await assert.rejects(actualSync(tooManyRows),/INVALID_PAYLOAD/);
  });
  await t.test('HMAC purpose/actor/owner, expiry, account mapping and public grants remain enforced',async()=>{
   for(const options of [{proof:'0'.repeat(64)},{purpose:'balance-sync'},{actor:owner},{owner:outsider}])await assert.rejects(actualSync([october],options),/UNTRUSTED/);
   await assert.rejects(actualSync([october],{body:{expires_at:new Date(Date.now()-1000).toISOString()}}),/EXPIRED/);
   await assert.rejects(actualSync([{...october,external_account_id:'99999'}]),/SCOPE/);
   await db.exec('reset role');
   const fns=(await db.query("select n.nspname,p.proname,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'execute') as anon,has_function_privilege('authenticated',p.oid,'execute') as authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('fd_clobe_plan_actuals_sync','fd_clobe_plan_actuals_sync_core')")).rows;
   assert.equal(fns.find(fn=>fn.nspname==='public').prosecdef,false);assert.equal(fns.find(fn=>fn.nspname==='private').prosecdef,true);
   assert.ok(fns.every(fn=>!fn.anon&&fn.authenticated&&fn.proconfig.includes('search_path=""')));
   await db.exec('set role anon');await assert.rejects(scalar('select public.fd_clobe_plan_actuals_sync($1,$2)',['{}','0'.repeat(64)]),/permission denied/);await db.exec('reset role');
   await db.query("select set_config('request.jwt.claim.sub','',false)");await assert.rejects(actualSync([october]),/ADMIN_REQUIRED/);
   await asUser(outsider);await assert.rejects(actualSync([october]),/ADMIN_REQUIRED/);
   await db.exec('reset role');await db.query("update private.finance_administrators set status='revoked',revoked_at=now() where user_id=$1",[admin]);await asUser(admin);await assert.rejects(actualSync([october]),/ADMIN_REQUIRED/);
   await db.exec('reset role');await db.query("update private.finance_administrators set status='active',revoked_at=null where user_id=$1",[admin]);await asUser(admin);
  });
  await t.test('same-batch padding and newly supplied counterparty labels preserve raw source text',async()=>{
   const other=mappings[2],stamp='2026-11-02T11:03:00';
   await balanceSync([{...other,balance:1000,balance_date:'2026-11-02',collected_at:stamp}]);
   const first={...bankRow('230','2026-10-05'),description:'Synthetic Platform USA',source_details:{basic:'Synthetic Platform USA',detail:'Monthly service'}};
   const second={...bankRow('231','2026-10-06'),description:'Synthetic Network（주）',source_details:{basic:'Synthetic Network（주）'}};
   const base={...october,...other,collected_at:stamp,rows:[first,second]};
   assert.equal((await actualSync([base])).synced_accounts,1);
   const padded={...first,description:' Synthetic             Platform  USA ',source_details:{basic:'\tSynthetic Platform         USA\t',detail:'Monthly    service'}};
   const enriched={...second,party:'Synthetic Network',source_details:{...second.source_details,counterparty:'Synthetic Network'}};
   const changed={...base,rows:[padded,enriched]};
   assert.deepEqual(await actualSync([changed]),{synced_accounts:1,unchanged_accounts:0,saved_outflows:2,skipped:[]});
   const stored=(await scalar('select public.fd_read_finance_snapshot()')).bank_plan_actuals.filter(row=>row.account_id===other.account_id);
   assert.equal(stored[0].description,padded.description);assert.deepEqual(stored[0].source_details,padded.source_details);
   assert.equal(stored[1].party,enriched.party);assert.equal(stored[1].source_details.counterparty,enriched.source_details.counterparty);
   assert.equal((await actualSync([changed])).unchanged_accounts,1);
   for(const rows of [
    [{...padded,description:'Different Platform USA'},enriched],
    [{...padded,description:'SYNTHETIC PLATFORM USA'},enriched],
    [{...padded,source_details:{...padded.source_details,basic:'Synthetic Platform-USA'}},enriched],
    [padded,{...enriched,party:'Different Network',source_details:{...enriched.source_details,counterparty:'Different Network'}}],
    [padded,{...enriched,party:null,source_details:{basic:enriched.source_details.basic}}],
    [{...padded,source_details:{basic:padded.source_details.basic}},enriched],
    [{...padded,party:'Synthetic A',source_details:{...padded.source_details,counterparty:'Synthetic B'}},enriched],
    ...['amount','balance','txn_time','txn_date','external_transaction_id'].map(field=>[{...padded,[field]:({amount:101,balance:901,txn_time:'11:00:00',txn_date:'2026-10-07',external_transaction_id:'232'})[field]},enriched]),
    [padded],
    [padded,enriched,bankRow('232','2026-10-07')],
   ])assert.equal((await actualSync([{...changed,rows}])).skipped.length,1);
   assert.deepEqual((await scalar('select public.fd_read_finance_snapshot()')).bank_plan_actuals.filter(row=>row.account_id===other.account_id),stored);
   assert.equal((await actualSync([changed])).unchanged_accounts,1);
   // The regular later-collection source-preservation check uses the same
   // safe comparison; the same-batch exception is not its only protection.
   const later='2026-11-02T11:04:00';
   await balanceSync([{...other,balance:1000,balance_date:'2026-11-02',collected_at:later}]);
   const normalized={...changed,collected_at:later,rows:[{...padded,description:'Synthetic Platform USA'},enriched]};
   assert.equal((await actualSync([normalized])).synced_accounts,1);
   const newest='2026-11-02T11:05:00';
   await balanceSync([{...other,balance:1000,balance_date:'2026-11-02',collected_at:newest}]);
   const genuineRecipientChange={...normalized,collected_at:newest,rows:[normalized.rows[0],{...enriched,party:'Different Network',source_details:{...enriched.source_details,counterparty:'Different Network'}}]};
   assert.equal((await actualSync([genuineRecipientChange])).skipped.length,1);
   const latest=(await scalar('select public.fd_read_finance_snapshot()')).bank_plan_actuals.filter(row=>row.account_id===other.account_id);
   assert.ok(latest.every(row=>row.collected_at===later));assert.equal(latest[1].party,'Synthetic Network');
  });
  await t.test('source comparison helpers are pure immutable invokers with no client execution grant',async()=>{
   await db.exec('reset role');
   const helpers=(await db.query("select p.proname,p.prosecdef,p.provolatile,p.proconfig,has_function_privilege('anon',p.oid,'execute') as anon,has_function_privilege('authenticated',p.oid,'execute') as authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('fd_clobe_plan_source_text','fd_clobe_plan_source_compatible')")).rows;
   assert.equal(helpers.length,2);assert.ok(helpers.every(fn=>!fn.prosecdef&&fn.provolatile==='i'&&fn.proconfig.includes('search_path=""')&&!fn.anon&&!fn.authenticated));
   await asUser(admin);await assert.rejects(scalar('select private.fd_clobe_plan_source_compatible($1,$2)',['{}','{}']),/permission denied/);
  });
  await t.test('older collections, changed or omitted prior rows and a mismatched saved batch retain complete evidence',async()=>{
   assert.equal((await actualSync([{...october,collected_at:'2026-10-31T11:00:00'}])).skipped.length,1);
   const later='2026-11-02T11:01:00';
   await balanceSync([{...mapping,balance:1000,balance_date:'2026-11-02',collected_at:later}]);
   for(const changed of [
    {...october,collected_at:later,rows:[octoberRows[0]]},
    {...october,collected_at:later,rows:[{...octoberRows[0],description:'Different synthetic original'},octoberRows[1]]},
    {...october,collected_at:later,to:'2026-10-30',rows:[octoberRows[0]]},
    {...october,collected_at:'2026-11-02T11:02:00'},
   ])assert.equal((await actualSync([changed])).skipped.length,1);
   const data=await scalar('select public.fd_read_finance_snapshot()');
   const stored=data.bank_plan_actuals.filter(row=>row.account_id===account&&row.txn_date.startsWith('2026-10'));
   assert.equal(stored.length,2);assert.ok(stored.every(row=>row.collected_at===collected&&row.description==='Synthetic fee'));
   assert.equal(data.bank_plan_coverage.find(row=>row.account_id===account&&row.from==='2026-10-01').to,'2026-10-31');
   assert.equal((await actualSync([{...october,collected_at:later}])).synced_accounts,1);
  });
  await t.test('one failed month retains its previous evidence while the other month can finish',async()=>{
   const later='2026-11-02T11:01:00';
   const result=await actualSync([{...october,collected_at:later},{...november,collected_at:later,status:'confirmation-needed',reason:'Synthetic interrupted monthly page',rows:[]}]);
   assert.equal(result.unchanged_accounts,1);assert.equal(result.skipped.length,1);
   const data=await scalar('select public.fd_read_finance_snapshot()'),current=data.bank_plan_coverage.find(row=>row.account_id===account&&row.from==='2026-11-01');
   assert.equal(current.status,'confirmation-needed');assert.equal(current.collected_at,collected);
   assert.equal(data.bank_plan_actuals.filter(row=>row.account_id===account&&row.txn_date.startsWith('2026-11')).length,1);
   const full=await actualSync([{...october,collected_at:later},{...november,collected_at:later}]);assert.equal(full.synced_accounts,1);assert.deepEqual(full.skipped,[]);
  });
  await t.test('all stored ledger, manual notes, plans and salary exclusions remain unchanged',async()=>{
   await db.exec('reset role');assert.deepEqual(await protectedState(),original);
   const before=await evidenceState();await asUser(admin);
   await assert.rejects(actualSync([{...october,collected_at:'2026-11-02T11:01:00'},{...november,account_id:'90000000-0000-4000-8000-000000000001',external_account_id:'99999'}]),/SCOPE/);
   await db.exec('reset role');assert.deepEqual(await evidenceState(),before);
  });
 }finally{await db.close();}
});
