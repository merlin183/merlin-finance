// Local synthetic PostgreSQL only; no remote credentials or financial records.
import assert from 'node:assert/strict';
import {bootstrapSyntheticWorkspace} from './helpers/bootstrap-workspace.mjs';
import {readFile,readdir} from 'node:fs/promises';
import {buildCashPlanSeriesMonthly,buildCashPlanSeriesBreakdown} from '../lib/finance/cash-plan-series.ts';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan.ts';
import {readFixedCostSaveResult} from '../lib/finance/cash-plan-series-forward.ts';
import {fixedCostMemo} from '../lib/finance/cash-plan-series-memo.ts';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const owner='10000000-0000-4000-8000-000000000001',admin='10000000-0000-4000-8000-000000000002',outsider='10000000-0000-4000-8000-000000000003';
let checks=0;
const ok=(condition,label)=>{assert.ok(condition,label);checks++;};
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const asUser=async id=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
const denied=async(operation,pattern)=>{await assert.rejects(operation,pattern);checks++;};
const save=change=>scalar('select public.fd_save_cash_plan_series($1)',[JSON.stringify(change)]);
const monthSave=change=>scalar('select public.fd_save_cash_plan_edits($1)',[JSON.stringify([change])]);
const dataset=()=>scalar('select public.fd_read_finance_dataset()');
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
  await db.query('insert into auth.users values($1,$2,now())',[id,email]);await db.query("insert into auth.identities values($1,'google',$2)",[id,JSON.stringify({email,email_verified:true})]);
 }
 const directory=new URL('../supabase/migrations/',import.meta.url);
 for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort()){
  let sql=await readFile(new URL(name,directory),'utf8');
  await db.exec(sql);
 }
 await bootstrapSyntheticWorkspace(db,owner,'admin@example.test');
 await asUser(admin);await scalar('select public.fd_admin_context()');
 const business=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic company') returning id",[owner]);
 const otherBusiness=await scalar("insert into public.fd_businesses(owner_id,name) values($1,'Synthetic other company') returning id",[owner]);
 const account=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic bank') returning id",[owner,business]);
 const otherAccount=await scalar("insert into public.fd_accounts(owner_id,business_id,name) values($1,$2,'Synthetic other bank') returning id",[owner,otherBusiness]);
 const tx=await scalar("insert into public.fd_transactions(owner_id,business_id,account_id,txn_date,amount,direction,description,dedup_hash) values($1,$2,$3,'2026-10-01',10,'out','Synthetic original','synthetic-forward-original') returning id",[owner,business,account]);
 const ledger=await scalar('select to_jsonb(t) from public.fd_transactions t where id=$1',[tx]);
 const series=await scalar("insert into public.fd_cash_plan_series(owner_id,business_id,source_type,source_key,title,account_id,monthly_amount,start_month,day,kind,memo) values($1,$2,'estimated','synthetic-fixed-source','Synthetic fixed plan',$3,100,'2026-10',15,'operating','월 고정비 계획 · 급여 · 합성 근거') returning id",[owner,business,account]);
 const change=(month,extra={})=>({action:'save',id:crypto.randomUUID(),business_id:business,source_type:'estimated',source_key:'synthetic-fixed-source',month,title:'Synthetic fixed plan',account_id:account,plan_date:`${month}-15`,amount:150,memo:'Synthetic revised note',excluded:false,payment_kind:'general',version:0,...extra});
 const request=(month,expected,edit,extra={})=>({scope:'from-month',business_id:business,month,series_id:series,expected_series_version:expected,day:15,change:edit,...extra});
 const november=change('2026-11');let result=readFixedCostSaveResult(await save(request('2026-11',1,november)));
 ok(result.series.find(item=>item.id===series).version===2&&result.revisions.length===1,'first onward revision and month override commit atomically');
 ok(!Object.hasOwn(result.series[0],'revisions'),'old strict series JSON shape remains unchanged');
 const january=change('2027-01',{amount:300});result=readFixedCostSaveResult(await save(request('2027-01',2,january)));
 const december=change('2026-12',{amount:90});await monthSave(december);
 result=readFixedCostSaveResult(await save(request('2026-11',3,{...november,version:1,amount:160})));
 ok(result.series.find(item=>item.id===series).version===4,'series CAS covers edits in other effective months');
 ok(result.revisions.find(item=>item.effective_month==='2027-01').cancelled,'earlier onward change cancels a later included revision without deleting its history');
 let current=await dataset();let edits=await scalar('select public.fd_read_cash_plan_edits()');
 assert.deepEqual(buildCashPlanSeriesMonthly(current,edits,'2026-10',5).filter(row=>row.businessId===business).map(row=>row.operatingAmount),[100,160,90,300,160]);checks++;
 await monthSave({action:'delete',id:january.id,version:1});
 current=await dataset();edits=await scalar('select public.fd_read_cash_plan_edits()');
 ok(buildCashPlanSeriesMonthly(current,edits,'2027-01',1).find(row=>row.businessId===business).operatingAmount===160,'cancelled future base cannot revive after an explicit month override is removed');
 const before=JSON.stringify({series:await scalar('select public.fd_read_cash_plan_series()'),revisions:await scalar('select public.fd_read_cash_plan_series_revisions()'),edits});
 await denied(()=>save(request('2026-11',4,{...november,version:0,amount:999})),/CASH_PLAN_STALE/);
 await denied(()=>save(request('2026-11',3,{...november,version:2,amount:999})),/CASH_PLAN_SERIES_STALE/);
 assert.equal(JSON.stringify({series:await scalar('select public.fd_read_cash_plan_series()'),revisions:await scalar('select public.fd_read_cash_plan_series_revisions()'),edits:await scalar('select public.fd_read_cash_plan_edits()')}),before);checks++;
 result=readFixedCostSaveResult(await save(request('2026-11',4,{...november,version:2,excluded:true})));
 await monthSave({...december,version:1,amount:999,excluded:false});current=await dataset();edits=await scalar('select public.fd_read_cash_plan_edits()');
 ok(buildCashPlanSeriesMonthly(current,edits,'2027-01',1).find(row=>row.businessId===business).operatingAmount===0,'onward exclusion wins over future monthly false flags');
 ok(buildCashPlanSeriesMonthly(current,edits,'2026-10',1).find(row=>row.businessId===business).operatingAmount===100,'onward exclusion never affects earlier months');
 const excluded=buildCashPlanSeriesBreakdown(current,edits,business,'2026-12');ok(excluded.excludedRows[0].revisionExcludedFrom==='2026-11','exclusion provenance is returned to all read models');
 const frozen=buildEditableCashPlan(current,{from:'2026-12-01',to:'2026-12-31'},'2026-10-28',edits);ok(frozen.items.find(item=>item.seriesId===series).excluded&&frozen.estimates.businesses.find(item=>item.business.id===business).total===0,'legacy worksheet also keeps recurring exclusions excluded');
 await denied(()=>save(request('2026-12',5,{...december,version:2,excluded:false})),/CASH_PLAN_SERIES_EXCLUDED/);

 // Recurring additions use one stable manual identity; promotion preserves its past.
 const manual=crypto.randomUUID(),oldId=crypto.randomUUID(),nowId=crypto.randomUUID();
 const oldManual=change('2026-10',{id:oldId,source_type:'manual',source_key:manual,plan_date:null,amount:20,memo:fixedCostMemo('임차료','Synthetic old month')});await monthSave(oldManual);
 const nowManual=change('2026-11',{id:nowId,source_type:'manual',source_key:manual,plan_date:null,amount:25,memo:fixedCostMemo('임차료','Synthetic current month')});await monthSave(nowManual);
 result=readFixedCostSaveResult(await save(request('2026-11',0,{...nowManual,version:1,amount:35},{series_id:manual,day:null})));
 ok(result.series.some(item=>item.id===manual&&item.source_key===manual&&item.start_month==='2026-11'),'manual promotion uses its original source key as series id');
 current=await dataset();edits=result.edits;
 for(const [month,amount] of [['2026-10',20],['2026-11',35],['2026-12',35]]){
  const detail=buildCashPlanSeriesBreakdown(current,edits,business,month),rows=detail.includedRows.filter(row=>row.sourceKey===manual);
  ok(rows.length===1&&rows[0].currentAmount===amount&&rows[0].groupLabel==='임차료',`${month} keeps one original source and explicit group after promotion`);
 }
 const fresh=crypto.randomUUID(),freshEdit=change('2026-11',{id:fresh,source_type:'manual',source_key:fresh,plan_date:null,amount:30,memo:fixedCostMemo('기타 고정비','Synthetic new recurring')});
 result=readFixedCostSaveResult(await save(request('2026-11',0,freshEdit,{series_id:fresh,day:null})));
 ok(result.series.some(item=>item.id===fresh)&&result.revisions.some(item=>item.series_id===fresh),'save response includes newly inserted sources immediately');
 await denied(()=>save(request('2026-11',0,freshEdit,{series_id:fresh,day:null})),/CASH_PLAN_SERIES_STALE/);

 const vat=crypto.randomUUID();await db.query("insert into public.fd_cash_plan_series(id,owner_id,business_id,source_type,source_key,title,monthly_amount,start_month,end_month,day,kind) values($1::uuid,$2,$3,'manual',$1::text,'Synthetic finite installment',50,'2026-11','2027-01',18,'installment')",[vat,owner,business]);
 await denied(()=>save(request('2026-11',1,change('2026-11',{source_type:'manual',source_key:vat,plan_date:'2026-11-18'}),{series_id:vat,day:18})),/CASH_PLAN_SERIES_OPERATING_REQUIRED/);
 const days=await scalar("insert into public.fd_cash_plan_series(owner_id,business_id,source_type,source_key,title,monthly_amount,start_month,day,kind) values($1,$2,'estimated','synthetic-day31','Synthetic month end',60,'2026-10',31,'operating') returning id",[owner,business]);
 const feb=change('2027-02',{source_key:'synthetic-day31',plan_date:'2027-02-28',amount:70});
 result=readFixedCostSaveResult(await save(request('2027-02',1,feb,{series_id:days,day:31})));current=await dataset();
 ok(buildCashPlanSeriesBreakdown(current,result.edits,business,'2027-03').includedRows.find(row=>row.id===days).date==='2027-03-31','day31 survives a short-month amount update');
 await denied(()=>save(request('2027-02',2,{...feb,version:1},{series_id:days,day:27})),/CASH_PLAN_SERIES_DAY_REQUIRED/);
 await denied(()=>save(request('2027-03',2,change('2027-03',{source_key:'synthetic-day31',account_id:otherAccount,plan_date:'2027-03-31'}),{series_id:days,day:31})),/foreign key/);
 await denied(()=>save({...request('2027-03',2,change('2027-03',{source_key:'synthetic-day31'}),{series_id:days}),owner_id:outsider}),/CASH_PLAN_SERIES_INVALID_CHANGE/);
 const confirmationSeries=await scalar("insert into public.fd_cash_plan_series(owner_id,business_id,source_type,source_key,title,account_id,monthly_amount,start_month,day,kind) values($1,$2,'estimated','synthetic-confirmed-forward','Synthetic confirmed budget',$3,80,'2026-10',15,'operating') returning id",[owner,business,account]);
 const confirmedId=crypto.randomUUID(),confirm=change('2026-10',{id:confirmedId,source_key:'synthetic-confirmed-forward',action:'payment_confirmation',amount:80,confirmed_amount:10,confirmed_date:'2026-10-02',confirmation_complete:false,confirmation_memo:'Synthetic prior bank evidence'});delete confirm.payment_kind;
 await monthSave(confirm);
 result=readFixedCostSaveResult(await save(request('2026-10',1,change('2026-10',{id:confirmedId,source_key:'synthetic-confirmed-forward',amount:90,version:1}),{series_id:confirmationSeries})));
 const kept=result.edits.find(item=>item.id===confirmedId);
 ok(kept.version===2&&kept.confirmed_amount===10&&kept.confirmed_date==='2026-10-02'&&kept.confirmation_memo==='Synthetic prior bank evidence','onward save preserves prior month payment-confirmation metadata');
 current=await dataset();const confirmedPlan=buildEditableCashPlan(current,{from:'2026-10-01',to:'2026-10-31'},'2026-10-28',result.edits).items.find(item=>item.seriesId===confirmationSeries);
 ok(confirmedPlan.amount===90&&confirmedPlan.remainingAmount===80,'new recurring budget subtracts existing confirmation once');
 await denied(()=>db.query("insert into public.fd_cash_plan_series_revisions(owner_id,business_id,series_id,effective_month,title,monthly_amount) values($1,$2,$3,'2027-04','Forbidden direct write',1)",[owner,business,days]),/permission denied/);
 const ledgerAfter=await scalar('select to_jsonb(t) from public.fd_transactions t where id=$1',[tx]);assert.deepEqual(ledgerAfter,ledger);checks++;
 await asUser(outsider);await denied(()=>save(request('2026-11',1,november)),/ADMIN_REQUIRED/);await denied(()=>scalar('select public.fd_read_cash_plan_series_revisions()'),/ADMIN_REQUIRED/);
 await db.exec('reset role;set role anon');await denied(()=>save(request('2026-11',1,november)),/permission denied/);await denied(()=>scalar('select public.fd_read_cash_plan_series_revisions()'),/permission denied/);
 await db.exec('reset role');
 ok(await scalar("select not prosecdef from pg_proc where oid='public.fd_save_cash_plan_series(jsonb)'::regprocedure"),'public mutation wrapper remains SECURITY INVOKER');
 ok(!await scalar("select has_function_privilege('anon','private.fd_save_cash_plan_series_core(jsonb)','EXECUTE')"),'anonymous callers cannot execute the private scoped core');
 ok(await scalar("select relrowsecurity from pg_class where oid='public.fd_cash_plan_series_revisions'::regclass"),'revisions enforce RLS');
 console.log(`All ${checks} recurring fixed-cost transaction checks passed.`);
}catch(error){console.error({message:error.message,code:error.code,where:error.where});throw Error(error.message);}finally{await db.close();}
