import test from 'node:test';
import assert from 'node:assert/strict';
import {clobeDashboardSyncMonths,createClobeDashboardSyncCoordinator} from '../lib/finance/clobe-dashboard-sync-client';
import type {ClobeSyncApplied,ClobeSyncPrepared} from '../lib/clobe/import-types';
import type {ClobeImportSummary} from '../lib/finance/clobe-import';

const now=Date.parse('2026-03-15T12:00:00+09:00');
const actorKey='synthetic-session',accountId='10000000-0000-4000-8000-000000000001',skippedId='10000000-0000-4000-8000-000000000002';
const summary=(overrides:Partial<ClobeImportSummary>={}):ClobeImportSummary=>({inserted:0,referenced:0,unchanged:0,sourceDuplicates:0,blocked:0,updated:0,removed:0,...overrides});
const previewId=(month:string)=>`00000000-0000-4000-8000-${month.replace('-','').padStart(12,'0')}`;
function prepared(month:string,overrides:Partial<ClobeSyncPrepared>={},today='2026-03-15'):ClobeSyncPrepared{
 const last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
 const end=last<today?last:today;
 return {month,previewId:previewId(month),expiresAt:`${today}T13:00:00+09:00`,scope:{start_date:`${month}-01`,end_date:end,account_count:1,business_count:1,accounts:[{account_id:accountId,from:`${month}-01`,to:end,collected_at:`${today}T12:00:00+09:00`}]},summary:summary(),unclassified:0,conflicts:[],...overrides};
}
const applied=(month:string,overrides:Partial<ClobeSyncApplied>={}):ClobeSyncApplied=>({...summary(),run_id:previewId(month),unclassified:0,...overrides});
const balances=()=>({synced:1,unchanged:0,skipped:[],accounts:{fetchedAt:'2026-03-15T03:00:00Z',companies:[{name:'DO-NOT-RETAIN-SOURCE',accounts:[{balance:1234}]}]},plan_actuals:{synced_accounts:1,unchanged_accounts:0,saved_outflows:2,fetched_outflows:2,skipped:[],complete:true}});
type Wire={action?:string;month?:string;previewId?:string};
function fetcher(run:(path:string,body:Wire)=>Response|Promise<Response>){
 const calls:{path:string;body:Wire}[]=[];
 const requestFetch=(async(path,options)=>{
  assert.equal(options?.method,'POST');assert.equal(options?.cache,'no-store');
  assert.deepEqual(options?.headers,{'Content-Type':'application/json'});
  const body=JSON.parse(String(options?.body)) as Wire;
  assert.deepEqual(Object.keys(body).sort(),body.action==='sync_prepare'?['action','month']:body.action==='sync_apply'?['action','previewId']:[]);
  calls.push({path:String(path),body});return run(String(path),body);
 }) as typeof fetch;
 return {requestFetch,calls};
}
const monthOf=(body:Wire)=>body.month??`2026-${body.previewId!.slice(-2)}`;
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

test('automatic partitions include only last month and this month in KST without changing a selected plan period',()=>{
 const planPeriod={from:'2026-10-01',to:'2026-11-02'};
 assert.deepEqual(clobeDashboardSyncMonths(Date.parse('2026-10-14T12:00:00+09:00')),{from:'2026-09-01',to:'2026-10-14',months:['2026-09','2026-10']});
 assert.deepEqual(clobeDashboardSyncMonths(Date.parse('2026-09-30T15:00:00Z')),{from:'2026-09-01',to:'2026-10-01',months:['2026-09','2026-10']});
 assert.deepEqual(clobeDashboardSyncMonths(Date.parse('2026-12-31T15:00:00Z')),{from:'2026-12-01',to:'2027-01-01',months:['2026-12','2027-01']});
 assert.throws(()=>clobeDashboardSyncMonths(NaN),/기준 날짜/);
 assert.deepEqual(planPeriod,{from:'2026-10-01',to:'2026-11-02'});
});

test('new classified and unmapped transactions apply before balances and refresh with no financial browser payload or retained bank rows',async()=>{
 const transport=fetcher((path,body)=>{
  if(path.endsWith('balance-sync'))return Response.json(balances());
  const month=monthOf(body),totals=month==='2026-02'?summary({inserted:2,referenced:1,sourceDuplicates:1}):summary({unchanged:2});
  return Response.json(body.action==='sync_prepare'?prepared(month,{summary:totals,unclassified:month==='2026-02'?1:0}):applied(month,{...totals,unclassified:month==='2026-02'?1:0}));
 });
 let reads=0,notifications=0;
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{notifications++;}});
 const result=await coordinator.start({actorKey,refresh:async()=>{reads++;}});
 assert.ok(result);assert.equal(result.fullSuccess,true);assert.equal(result.refreshed,true);
 assert.deepEqual(result.ledger,{inserted:2,referenced:1,unchanged:2,sourceDuplicates:1,blocked:0,updated:0,removed:0,unclassified:1});
 assert.equal(result.completedMonths,2);assert.equal(reads,1);assert.equal(notifications,1);
 assert.deepEqual(transport.calls.map(call=>call.body.action??'balances'),['sync_prepare','sync_apply','sync_prepare','sync_apply','balances']);
 assert.deepEqual(transport.calls.filter(call=>call.body.action==='sync_prepare').map(call=>call.body.month),['2026-02','2026-03']);
 assert.deepEqual(result.scope,{from:'2026-02-01',to:'2026-03-15'});
 assert.deepEqual(result.sourceThrough,{earliest:'2026-03-15',latest:'2026-03-15'});
 assert.doesNotMatch(JSON.stringify(coordinator.getSnapshot()),/DO-NOT-RETAIN-SOURCE|previewId|collected_at|"accounts"/);
 assert.equal(coordinator.getSnapshot().phase,'done');
});

test('two views join exactly the same in-flight promise and leaving either view cannot cancel its shared refresh',async()=>{
 const first=deferred<Response>();let requests=0,firstReads=0,secondReads=0;
 const transport=fetcher((path,body)=>{
  if(++requests===1)return first.promise;
  return Response.json(path.endsWith('balance-sync')?balances():body.action==='sync_prepare'?prepared(monthOf(body)):applied(monthOf(body)));
 });
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}});
 let displayed=0;const unsubscribe=coordinator.subscribe(()=>{displayed++;});
 const a=coordinator.start({actorKey,refresh:async()=>{firstReads++;}});
 const b=coordinator.start({actorKey,refresh:async()=>{secondReads++;}});
 assert.equal(a,b);assert.ok(a);unsubscribe();const seen=displayed;
 await Promise.resolve();first.resolve(Response.json(prepared('2026-02')));
 assert.equal((await a).refreshed,true);assert.equal(displayed,seen);
 assert.equal(firstReads,1);assert.equal(secondReads,0);assert.equal(transport.calls.length,5);
});

test('repeated synchronization detects zero new transactions and sends no category, note or plan overrides',async()=>{
 const ledger=new Set<string>();
 const transport=fetcher((path,body)=>{
  if(path.endsWith('balance-sync'))return Response.json(balances());
  const month=monthOf(body),totals=ledger.has(month)?summary({unchanged:1}):summary({inserted:1});
  if(body.action==='sync_apply')ledger.add(month);
  return Response.json(body.action==='sync_prepare'?prepared(month,{summary:totals}):applied(month,totals));
 });
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}}),options={actorKey,refresh:async()=>{}};
 assert.equal((await coordinator.start(options))?.ledger.inserted,2);
 const again=await coordinator.start(options);assert.equal(again?.ledger.inserted,0);assert.equal(again?.ledger.unchanged,2);assert.equal(ledger.size,2);
 assert.doesNotMatch(JSON.stringify(transport.calls),/category|choices|memo|amount|plan_date|from|to/);
});

test('partial month failure keeps successful saves, continues later months and balances, and always refreshes common data',async()=>{
 for(const stage of ['prepare','apply'] as const){
  let reads=0,applyMarch=0;
  const transport=fetcher((path,body)=>{
   if(path.endsWith('balance-sync'))return Response.json(balances());
   const month=monthOf(body);
   if(month==='2026-03'&&body.action==='sync_prepare'&&stage==='prepare')return Response.json({error:'provider PRIVATE FINANCIAL RAW TEXT'},{status:502});
   if(month==='2026-03'&&body.action==='sync_apply'){applyMarch++;return Response.json({error:'stale'},{status:409});}
   return Response.json(body.action==='sync_prepare'?prepared(month,{summary:summary({inserted:1})}):applied(month,{inserted:1}));
  });
  const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}});
  const result=await coordinator.start({actorKey,refresh:async()=>{reads++;}});assert.ok(result);
  assert.equal(result.fullSuccess,false);assert.equal(result.ledger.inserted,1);assert.equal(result.completedMonths,1);
  assert.deepEqual(result.failures.map(f=>[f.month,f.stage,f.uncertain]),[['2026-03',stage,false]]);
  assert.equal(applyMarch,stage==='apply'?1:0);assert.equal(result.balanceResult?.synced,1);assert.equal(result.refreshed,true);assert.equal(reads,1);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE FINANCIAL RAW TEXT/);
 }
});

test('all ledger months may fail while independent balances still save and the response remains honestly incomplete',async()=>{
 let reads=0;
 const transport=fetcher(path=>Response.json(path.endsWith('balance-sync')?balances():{error:'계좌 연결을 확인해주세요.'},path.endsWith('balance-sync')?undefined:{status:409}));
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}});
 const result=await coordinator.start({actorKey,refresh:async()=>{reads++;}});assert.ok(result);
 assert.equal(result.failures.length,2);assert.ok(result.failures.every(f=>f.code==='mapping'));assert.equal(result.ledger.inserted,0);
 assert.equal(result.balanceResult?.synced,1);assert.equal(result.fullSuccess,false);assert.equal(reads,1);
 assert.equal(transport.calls.at(-1)?.path,'/api/clobe/balance-sync');
});

test('a failed balance request cannot hide saved ledger rows or prevent their refresh',async()=>{
 let reads=0;
 const transport=fetcher((path,body)=>path.endsWith('balance-sync')?Response.json({error:'synthetic failure'},{status:502}):Response.json(body.action==='sync_prepare'?prepared(monthOf(body),{summary:summary({inserted:1})}):applied(monthOf(body),{inserted:1})));
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}});
 const result=await coordinator.start({actorKey,refresh:async()=>{reads++;}});assert.ok(result);
 assert.equal(result.ledger.inserted,2);assert.equal(result.balanceResult,null);assert.ok(result.balanceError);assert.equal(result.fullSuccess,false);assert.equal(result.refreshed,true);assert.equal(reads,1);
});

test('a lost apply response retries the same opaque preview once and replay restores the prepared unmapped count',async()=>{
 let firstApply=true;const attempts:Wire[]=[];
 const transport=fetcher((path,body)=>{
  if(path.endsWith('balance-sync'))return Response.json(balances());
  const month=monthOf(body);
  if(body.action==='sync_prepare')return Response.json(prepared(month,{summary:summary({inserted:1}),unclassified:1}));
  attempts.push(body);
  if(firstApply){firstApply=false;throw Error('synthetic response loss after commit');}
  return Response.json(applied(month,{inserted:1,unclassified:month==='2026-02'?null:1,replayed:month==='2026-02'}));
 });
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}});
 const result=await coordinator.start({actorKey,refresh:async()=>{}});assert.ok(result);
 assert.deepEqual(attempts[0],attempts[1]);assert.equal(attempts.length,3);
 assert.equal(result.ledger.inserted,2);assert.equal(result.ledger.unclassified,2);assert.equal(result.failures.length,0);
});

test('a twice ambiguous saved result is recovered by its original preview before a new run detects existing source rows',async()=>{
 let unknown=true,commits=0;const saved=new Set<string>();
 const transport=fetcher((path,body)=>{
  if(path.endsWith('balance-sync'))return Response.json(balances());
  const month=monthOf(body);
  if(body.action==='sync_prepare')return Response.json(prepared(month,{summary:saved.has(month)?summary({unchanged:1}):summary({inserted:1}),unclassified:!saved.has(month)&&month==='2026-02'?1:0}));
  if(month==='2026-02'&&unknown){if(!saved.has(month)){saved.add(month);commits++;}throw Error('synthetic reply loss');}
  if(month==='2026-02'&&saved.has(month)&&commits===1){commits++;return Response.json(applied(month,{inserted:1,unclassified:null,replayed:true}));}
  if(saved.has(month))return Response.json(applied(month,{unchanged:1}));
  saved.add(month);return Response.json(applied(month,{inserted:1}));
 });
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}}),options={actorKey,refresh:async()=>{}};
 const first=await coordinator.start(options);assert.ok(first);assert.equal(first.failures[0].uncertain,true);assert.equal(first.ledger.inserted,1);assert.equal(first.fullSuccess,false);
 const previousCalls=transport.calls.length;unknown=false;
 const recovered=await coordinator.start(options);assert.ok(recovered);
 assert.deepEqual(transport.calls[previousCalls].body,{action:'sync_apply',previewId:previewId('2026-02')});
 assert.deepEqual(recovered.recoveredMonths,['2026-02']);assert.equal(recovered.ledger.inserted,1);assert.equal(recovered.ledger.unclassified,1);assert.equal(saved.size,2);assert.equal(recovered.fullSuccess,true);
});

test('latest successful month scope replaces recovered status counts while saved changes accumulate and a later failed scope retains recovered counts',async()=>{
 let unknown=true;
 const recoveredTotals=summary({inserted:1,referenced:1,unchanged:2,sourceDuplicates:3,blocked:1});
 const freshTotals=summary({inserted:1,referenced:1,unchanged:4,sourceDuplicates:2,blocked:1});
 const transport=fetcher((path,body)=>{
  if(path.endsWith('balance-sync'))return Response.json(balances());
  const month=monthOf(body);
  if(body.action==='sync_prepare'){
   if(!unknown&&month==='2026-03')return Response.json({error:'synthetic later source failure'},{status:502});
   return Response.json(prepared(month,{previewId:unknown?previewId(month):previewId(month).replace('00000000-0000','11111111-0000'),summary:unknown?recoveredTotals:freshTotals,unclassified:1}));
  }
  if(unknown)throw Error('synthetic apply reply loss');
  return Response.json(applied(month,{...(body.previewId!.startsWith('11111111')?freshTotals:recoveredTotals),run_id:body.previewId,unclassified:body.previewId!.startsWith('11111111')?1:null,replayed:!body.previewId!.startsWith('11111111')}));
 });
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}}),options={actorKey,refresh:async()=>{}};
 const first=await coordinator.start(options);assert.ok(first);assert.equal(first.failures.length,2);
 unknown=false;
 const result=await coordinator.start(options);assert.ok(result);
 assert.deepEqual(result.recoveredMonths,['2026-02','2026-03']);
 assert.deepEqual(result.ledger,{inserted:3,referenced:3,unclassified:3,unchanged:6,sourceDuplicates:5,blocked:2,updated:0,removed:0});
 assert.deepEqual(result.failures.map(f=>[f.month,f.stage]),[['2026-03','prepare']]);
 assert.equal(result.fullSuccess,false);assert.equal(result.refreshed,true);
});

test('refresh failure blocks all writes until read-only retry succeeds and does not lose completed counts',async()=>{
 let reads=0,fail=true;
 const transport=fetcher((path,body)=>Response.json(path.endsWith('balance-sync')?balances():body.action==='sync_prepare'?prepared(monthOf(body)):applied(monthOf(body))));
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{},wait:async()=>{}}),options={actorKey,refresh:async()=>{reads++;if(fail)throw Error('synthetic read failure');}};
 const first=await coordinator.start(options);assert.ok(first);assert.equal(first.refreshed,false);assert.equal(coordinator.getSnapshot().phase,'refresh-needed');
 const requests=transport.calls.length;assert.equal(coordinator.start(options),null);
 assert.equal((await coordinator.retryRefresh(options))?.refreshed,false);
 fail=false;const retry=coordinator.retryRefresh(options);assert.ok(retry);assert.equal(coordinator.retryRefresh(options),retry);
 const result=await retry;assert.equal(result.refreshed,true);assert.equal(result.fullSuccess,true);assert.equal(result.completedMonths,2);assert.equal(transport.calls.length,requests);assert.equal(reads,5);
});

test('one bounded automatic screen retry waits two seconds and only then broadcasts without reapplying saved transactions',async()=>{
 const events:string[]=[];let reads=0;
 const transport=fetcher((path,body)=>Response.json(path.endsWith('balance-sync')?balances():body.action==='sync_prepare'?prepared(monthOf(body),{summary:summary({inserted:1})}):applied(monthOf(body),{inserted:1})));
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{events.push('notify');},wait:async milliseconds=>{events.push(`wait:${milliseconds}`);}});
 const result=await coordinator.start({actorKey,refresh:async()=>{reads++;events.push(`read:${reads}`);if(reads===1)throw Error('synthetic statement timeout');}});assert.ok(result);
 assert.deepEqual(events,['read:1','wait:2000','read:2','notify']);assert.equal(result.refreshed,true);assert.equal(result.fullSuccess,true);
 assert.equal(result.ledger.inserted,2);assert.equal(transport.calls.filter(call=>call.body.action==='sync_apply').length,2);assert.equal(transport.calls.length,5);
});

test('a second read failure remains visible and signals other documents once after both attempts',async()=>{
 const events:string[]=[];let reads=0;
 const transport=fetcher((path,body)=>Response.json(path.endsWith('balance-sync')?balances():body.action==='sync_prepare'?prepared(monthOf(body)):applied(monthOf(body))));
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{events.push('notify');},wait:async milliseconds=>{events.push(`wait:${milliseconds}`);}});
 const result=await coordinator.start({actorKey,refresh:async()=>{reads++;events.push(`read:${reads}`);throw Error('synthetic still unavailable');}});assert.ok(result);
 assert.deepEqual(events,['read:1','wait:2000','read:2','notify']);assert.equal(reads,2);assert.equal(result.refreshed,false);
 assert.equal(coordinator.getSnapshot().phase,'refresh-needed');assert.equal(coordinator.start({actorKey,refresh:async()=>{}}),null);assert.equal(transport.calls.length,5);
});

test('logout during automatic read retry delay stops the next read and notification while preserving the no-repeat-write boundary',async()=>{
 const waiting=deferred<void>(),retryStarted=deferred<void>();let reads=0,notifications=0;
 const transport=fetcher((path,body)=>Response.json(path.endsWith('balance-sync')?balances():body.action==='sync_prepare'?prepared(monthOf(body)):applied(monthOf(body))));
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{notifications++;},wait:async milliseconds=>{assert.equal(milliseconds,2000);retryStarted.resolve();await waiting.promise;}});
 const task=coordinator.start({actorKey,refresh:async()=>{reads++;throw Error('synthetic first read failed');}});assert.ok(task);
 const rejected=assert.rejects(task,/로그인 계정이 변경/);await retryStarted.promise;coordinator.reset();waiting.resolve();await rejected;
 assert.equal(reads,1);assert.equal(notifications,0);assert.equal(transport.calls.length,5);assert.equal(coordinator.getSnapshot(),coordinator.getServerSnapshot());
});

test('reset on logout discards prior results and stops the old actor after its in-flight response without refreshing a new session',async()=>{
 const waiting=deferred<Response>();let first=true,oldReads=0,newReads=0;
 const transport=fetcher((path,body)=>{
  if(first){first=false;return waiting.promise;}
  return Response.json(path.endsWith('balance-sync')?balances():body.action==='sync_prepare'?prepared(monthOf(body)):applied(monthOf(body)));
 });
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}});
 const old=coordinator.start({actorKey,refresh:async()=>{oldReads++;}});assert.ok(old);
 const rejected=assert.rejects(old,/로그인 계정이 변경/);await Promise.resolve();coordinator.reset();
 assert.equal(coordinator.getSnapshot(),coordinator.getServerSnapshot());
 const next=coordinator.start({actorKey:'another-synthetic-session',refresh:async()=>{newReads++;}});assert.ok(next);
 waiting.resolve(Response.json(prepared('2026-02')));await rejected;assert.equal((await next).refreshed,true);
 assert.equal(oldReads,0);assert.equal(newReads,1);assert.equal(transport.calls.length,6);
});

test('mismatched prepare scope is never applied and unresolved duplicate observations prevent a full-success claim',async()=>{
 const transport=fetcher((path,body)=>{
  if(path.endsWith('balance-sync'))return Response.json({...balances(),plan_actuals:{...balances().plan_actuals,complete:false,skipped:[{account_id:accountId,reason:'원본 SOURCE PRIVATE DETAILS'}]}});
  const month=monthOf(body);
  if(body.action==='sync_prepare')return Response.json(prepared(month,month==='2026-02'?{scope:{...prepared(month).scope,end_date:'2026-03-15'}}:{summary:summary({blocked:1})}));
  return Response.json(applied(month,{blocked:1}));
 });
 const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}});
 const result=await coordinator.start({actorKey,refresh:async()=>{}});assert.ok(result);
 assert.equal(transport.calls.filter(call=>call.body.previewId===previewId('2026-02')).length,0);
 assert.equal(result.failures[0].stage,'prepare');assert.equal(result.ledger.blocked,1);assert.equal(result.fullSuccess,false);
 assert.equal(result.balanceResult?.plan_actuals?.skipped[0].account_id,accountId);assert.doesNotMatch(JSON.stringify(result),/SOURCE PRIVATE DETAILS/);
});

test('a failed account does not stop verified accounts in each month and retains only sanitized account/month metadata',async()=>{
 const transport=fetcher((path,body)=>{
  if(path.endsWith('balance-sync'))return Response.json(balances());
  const month=monthOf(body);
  return Response.json(body.action==='sync_prepare'?prepared(month,{scope:{...prepared(month).scope,configured_account_count:2},summary:summary({inserted:1}),unclassified:month==='2026-02'?1:0,skipped:[{account_id:skippedId,code:'collection',reason:'PRIVATE BANK USER SOURCE VALUES'}]}):applied(month,{inserted:1,unclassified:month==='2026-02'?1:0}));
 });
 let reads=0;const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}});
 const result=await coordinator.start({actorKey,refresh:async()=>{reads++;}});assert.ok(result);
 assert.equal(result.completedMonths,2);assert.equal(result.failures.length,0);assert.equal(result.ledger.inserted,2);assert.equal(result.ledger.unclassified,1);
 assert.deepEqual(result.monthScopes,['2026-02','2026-03'].map(month=>({month,configuredAccounts:2,verifiedAccounts:1})));
 assert.deepEqual(result.accountFailures.map(item=>[item.month,item.account_id,item.code]),['2026-02','2026-03'].map(month=>[month,skippedId,'collection']));
 assert.ok(result.accountFailures.every(item=>/수집이 완료되지 않아/.test(item.reason)));
 assert.equal(result.fullSuccess,false);assert.equal(result.refreshed,true);assert.equal(reads,1);assert.equal(transport.calls.filter(call=>call.body.action==='sync_apply').length,2);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE BANK USER SOURCE VALUES|collected_at|previewId/);
});

test('zero verified accounts yields failed-month account details without applying and still independently synchronizes balances',async()=>{
 const transport=fetcher(path=>path.endsWith('balance-sync')?Response.json(balances()):Response.json({error:'은행 수집 실패',configured_account_count:2,skipped:[{account_id:accountId,code:'collection',reason:'PRIVATE SOURCE'},{account_id:skippedId,code:'access',reason:'PRIVATE TOKEN'}]},{status:504}));
 let reads=0;const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}});
 const result=await coordinator.start({actorKey,refresh:async()=>{reads++;}});assert.ok(result);
 assert.equal(result.completedMonths,0);assert.equal(result.failures.length,2);assert.equal(result.accountFailures.length,4);
 assert.ok(result.monthScopes.every(scope=>scope.configuredAccounts===2&&scope.verifiedAccounts===0));
 assert.equal(transport.calls.filter(call=>call.body.action==='sync_apply').length,0);assert.equal(transport.calls.at(-1)?.path,'/api/clobe/balance-sync');
 assert.equal(result.balanceResult?.synced,1);assert.equal(result.fullSuccess,false);assert.equal(result.refreshed,true);assert.equal(reads,1);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE SOURCE|PRIVATE TOKEN/);
});

test('partial account scopes reject overlap, missing configured members and duplicate skipped IDs before any apply',async()=>{
 for(const issue of ['overlap','missing','duplicate']){
  const transport=fetcher((path,body)=>{
   if(path.endsWith('balance-sync'))return Response.json(balances());
   const month=monthOf(body),scope={...prepared(month).scope,configured_account_count:issue==='overlap'?2:3};
   const skipped=issue==='overlap'?[{account_id:accountId,code:'collection' as const,reason:'overlap'}]:issue==='missing'?[{account_id:skippedId,code:'timeout' as const,reason:'missing member'}]:[{account_id:skippedId,code:'timeout' as const,reason:'duplicate'},{account_id:skippedId,code:'timeout' as const,reason:'duplicate'}];
   return Response.json(prepared(month,{scope,skipped}));
  });
  const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}});
  const result=await coordinator.start({actorKey,refresh:async()=>{}});assert.ok(result);
  assert.equal(result.failures.length,2);assert.equal(transport.calls.filter(call=>call.body.action==='sync_apply').length,0);
  assert.equal(result.accountFailures.length,0);assert.equal(result.fullSuccess,false);assert.equal(result.refreshed,true);
 }
});

test('opaque recovery retains skipped-account metadata after a later failed lookup and a fresh successful account scope can replace it',async()=>{
 for(const freshSuccess of [false,true]){
  let unknown=true;
  const transport=fetcher((path,body)=>{
   if(path.endsWith('balance-sync'))return Response.json(balances());
   const month=monthOf(body);
   if(month!=='2026-02')return Response.json(body.action==='sync_prepare'?prepared(month):applied(month));
   if(body.action==='sync_prepare'){
    if(!unknown&&!freshSuccess)return Response.json({error:'synthetic lookup failure'},{status:502});
    const base=prepared(month);
    return Response.json(unknown?prepared(month,{scope:{...base.scope,configured_account_count:2},summary:summary({inserted:1}),skipped:[{account_id:skippedId,code:'pagination',reason:'PRIVATE BANK SOURCE'}]}):prepared(month,{previewId:previewId(month).replace('00000000-0000','11111111-0000'),scope:{...base.scope,account_count:2,configured_account_count:2,accounts:[...base.scope.accounts,{...base.scope.accounts[0],account_id:skippedId}]},skipped:[]}));
   }
   if(unknown)throw Error('synthetic saved reply loss');
   return Response.json(applied(month,{run_id:body.previewId,inserted:body.previewId!.startsWith('11111111')?0:1,unclassified:null,replayed:!body.previewId!.startsWith('11111111')}));
  });
  const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>now,notify:()=>{}}),options={actorKey,refresh:async()=>{}};
  const first=await coordinator.start(options);assert.ok(first);assert.equal(first.accountFailures.length,1);assert.equal(first.failures[0].uncertain,true);
  unknown=false;const recovered=await coordinator.start(options);assert.ok(recovered);
  assert.deepEqual(recovered.recoveredMonths,['2026-02']);assert.equal(recovered.ledger.inserted,1);
  assert.equal(recovered.accountFailures.length,freshSuccess?0:1);assert.equal(recovered.fullSuccess,freshSuccess);
  assert.deepEqual(recovered.monthScopes.find(scope=>scope.month==='2026-02'),{month:'2026-02',configuredAccounts:2,verifiedAccounts:freshSuccess?2:1});
  assert.doesNotMatch(JSON.stringify(recovered),/PRIVATE BANK SOURCE/);
 }
});

test('an old ambiguous preview is only replayed by the same opaque ID when the window advances and never creates an old-month source request',async()=>{
 for(const outcome of ['committed','not-saved','unresolved']){
  let instant=now,unknown=true,physicalWrites=0;
  const transport=fetcher((path,body)=>{
   if(path.endsWith('balance-sync'))return Response.json(balances());
   const month=monthOf(body),today=new Date(instant+9*3600000).toISOString().slice(0,10);
   if(body.action==='sync_prepare')return Response.json(prepared(month,month==='2026-02'?{summary:summary({inserted:1}),unclassified:1}:{},today));
   if(month==='2026-02'){
    if(unknown){if(outcome==='committed')physicalWrites=1;throw Error('synthetic unknown original reply');}
    if(outcome==='not-saved')return Response.json({error:'old automatic scope stale'},{status:409});
    if(outcome==='unresolved')throw Error('synthetic still unknown old reply');
    return Response.json(applied(month,{inserted:1,unclassified:null,replayed:true}));
   }
   return Response.json(applied(month));
  });
  const coordinator=createClobeDashboardSyncCoordinator({...transport,now:()=>instant,notify:()=>{}}),options={actorKey,refresh:async()=>{}};
  const first=await coordinator.start(options);assert.ok(first);assert.equal(first.failures[0].uncertain,true);
  const before=transport.calls.length;instant=Date.parse('2026-04-15T12:00:00+09:00');unknown=false;
  const next=await coordinator.start(options);assert.ok(next);
  assert.deepEqual(transport.calls[before].body,{action:'sync_apply',previewId:previewId('2026-02')});
  assert.deepEqual(transport.calls.slice(before).filter(call=>call.body.action==='sync_prepare').map(call=>call.body.month),['2026-03','2026-04']);
  assert.deepEqual(next.scope,{from:'2026-03-01',to:'2026-04-15'});assert.equal(next.totalMonths,2);assert.equal(next.completedMonths,2);
  assert.equal(physicalWrites,outcome==='committed'?1:0);assert.equal(next.ledger.inserted,outcome==='committed'?1:0);
  assert.deepEqual(next.recoveredMonths,outcome==='committed'?['2026-02']:[]);
  assert.equal(next.failures.length,outcome==='unresolved'?1:0);assert.equal(next.fullSuccess,outcome!=='unresolved');
 }
});
