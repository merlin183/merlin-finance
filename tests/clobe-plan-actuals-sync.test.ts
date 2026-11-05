import test from 'node:test';
import assert from 'node:assert/strict';
import {syncClobePlanActuals,readClobePlanActualPage,type ClobePlanActualScope,type ClobePlanPage,type ClobePlanActualRow,type ClobePlanActualDependencies} from '../lib/clobe/plan-actuals-sync';
import {syncClobeBalances} from '../lib/clobe/balance-sync';
import type {ClobeReadSession} from '../lib/clobe/mcp';
import type {ClobeTransactionsRequest} from '../lib/clobe/types';

const account='10000000-0000-4000-8000-000000000001',second='10000000-0000-4000-8000-000000000002';
const mapping={company_id:'synthetic-company',external_account_id:'1',account_id:account};
const collected='2026-10-13T11:00:00',now=()=>Date.parse('2026-10-13T12:00:00+09:00');
const snapshot={...mapping,balance:900,balance_date:'2026-10-13',collected_at:collected};
const actual=(id='1',extra:Partial<ClobePlanActualRow>={}):ClobePlanActualRow=>({external_transaction_id:id,txn_date:'2026-10-02',txn_time:'10:00:00',amount:100,balance:900,description:'Synthetic company · Monthly fee',party:null,source_details:{basic:'Synthetic company',detail:'Monthly fee'},...extra});
const page=(rows=[actual()],extra:Partial<ClobePlanPage>={}):ClobePlanPage=>({fetchedAt:'2026-10-13T03:00:00Z',companyId:'synthetic-company',bankAccountId:1,startDate:'2026-10-01',endDate:'2026-10-13',rows:rows.map(row=>({id:row.external_transaction_id,date:row.txn_date,time:row.txn_time,amount:row.amount,balance:row.balance,description:row.description,party:row.party,category:'Provider category must not classify',memo:null,direction:'out',currency:'KRW'})),sourceRows:rows,hasNext:false,nextCursor:null,totalElements:rows.length,inAmountSum:0,outAmountSum:rows.reduce((sum,row)=>sum+row.amount,0),scraping:{status:'SUCCESS',lastCollectedAt:collected,error:null},...extra});
const status=async()=>({status:'SUCCESS',lastCollectedAt:collected,error:null});
const save=async(scopes:ClobePlanActualScope[])=>({synced_accounts:new Set(scopes.filter(scope=>scope.status==='complete').map(scope=>scope.account_id)).size,unchanged_accounts:0,saved_outflows:scopes.reduce((sum,scope)=>sum+scope.rows.length,0),skipped:[]});
const octoberScope=(scopes:ClobePlanActualScope[])=>scopes.find(scope=>scope.from==='2026-10-01')!;
/** Earlier fixtures exercise October failures; September is an independently
 * validated empty month, not an accidental duplicate of October's source. */
const withEmptySeptember=(read:ClobePlanActualDependencies['readPage']):ClobePlanActualDependencies['readPage']=>async(request,collectedAt)=>request.startDate==='2026-09-01'
 ?page([],{bankAccountId:request.bankAccountId,startDate:request.startDate,endDate:request.endDate})
 :read(request,collectedAt);

test('complete monthly bank pages store outflow evidence once without submitting category or ledger changes',async()=>{
 const requests:ClobeTransactionsRequest[]=[],saved:ClobePlanActualScope[]=[];
 const read=withEmptySeptember(async()=>page());
 const result=await syncClobePlanActuals({readPage:async(request,at)=>{requests.push(request);return read(request,at);},readStatus:status,save:async scopes=>{saved.push(...scopes);return save(scopes);},now},[mapping],[snapshot]);
 assert.deepEqual(requests,[{companyId:'synthetic-company',bankAccountId:1,startDate:'2026-09-01',endDate:'2026-09-30',size:100},{companyId:'synthetic-company',bankAccountId:1,startDate:'2026-10-01',endDate:'2026-10-13',size:100}]);
 assert.equal(result.complete,true);assert.equal(result.saved_outflows,1);assert.equal(octoberScope(saved).rows[0].source_details?.detail,'Monthly fee');assert.equal('category_id' in octoberScope(saved).rows[0],false);
});

test('all pages include incoming rows for completeness but save only outgoing rows',async()=>{
 let count=0,saved:ClobePlanActualScope[]=[];
 const first=page([actual()],{hasNext:true,nextCursor:'page-2',totalElements:2});
 const incoming=page([],{rows:[{id:'2',date:'2026-10-03',time:'10:00:00',amount:50,balance:950,description:'Synthetic receipt',party:null,category:null,memo:null,direction:'in',currency:'KRW'}],totalElements:2});
 const result=await syncClobePlanActuals({readPage:withEmptySeptember(async request=>{count++;assert.equal(request.cursor,count===1?undefined:'page-2');return count===1?first:incoming;}),readStatus:status,save:async scopes=>{saved=scopes;return save(scopes);},now},[mapping],[snapshot]);
 assert.equal(result.complete,true);assert.equal(result.fetched_outflows,1);assert.equal(octoberScope(saved).rows.length,1);
});

test('exact repeated external id across pages deduplicates, but changed ids/content or missing totals hold whole account',async()=>{
 for(const scenario of ['exact','changed-id','same-id-changed','total-missing','cursor-loop']){
  let count=0;const first=page([actual()],{hasNext:true,nextCursor:'next',totalElements:null});
  const next=scenario==='exact'?page([actual()],{totalElements:null}):scenario==='changed-id'?page([actual('2')],{totalElements:null}):scenario==='same-id-changed'?page([actual('1',{amount:120})],{totalElements:null}):scenario==='total-missing'?page([],{totalElements:3}):page([],{hasNext:true,nextCursor:'next',totalElements:null});
  let saved:ClobePlanActualScope[]=[];const result=await syncClobePlanActuals({readPage:withEmptySeptember(async()=>++count===1?first:next),readStatus:status,save:async scopes=>{saved=scopes;return save(scopes);},now},[mapping],[snapshot]);
  assert.equal(result.complete,scenario==='exact');assert.equal(octoberScope(saved).rows.length,scenario==='exact'?1:0);if(scenario!=='exact')assert.equal(octoberScope(saved).status,'confirmation-needed');
 }
});

test('failed scraping, changed collection, fractional source, wrong scope or future row do not replace previous evidence',async()=>{
 for(const current of [page([actual('1',{amount:0.5})]),page([actual('1',{txn_date:'2026-10-14'})]),page([], {bankAccountId:9}),page([],{scraping:{status:'IN_PROGRESS',lastCollectedAt:collected,error:null}})]){
  let scopes:ClobePlanActualScope[]=[];const result=await syncClobePlanActuals({readPage:withEmptySeptember(async()=>current),readStatus:status,save:async rows=>{scopes=rows;return save(rows);},now},[mapping],[snapshot]);assert.equal(result.complete,false);assert.equal(octoberScope(scopes).status,'confirmation-needed');assert.deepEqual(octoberScope(scopes).rows,[]);
 }
 const result=await syncClobePlanActuals({readPage:withEmptySeptember(async()=>page()),readStatus:async()=>({status:'SUCCESS',lastCollectedAt:'2026-10-13T11:01:00',error:null}),save,now},[mapping],[snapshot]);assert.equal(result.complete,false);
});

test('one successful account and one failed account produce partial outcomes and failure scope without clearing rows',async()=>{
 const mappings=[mapping,{...mapping,external_account_id:'2',account_id:second}],snapshots=[snapshot,{...snapshot,external_account_id:'2',account_id:second}];let scopes:ClobePlanActualScope[]=[];
 const result=await syncClobePlanActuals({readPage:withEmptySeptember(async request=>{if(request.bankAccountId===2)throw Error('source offline');return page();}),readStatus:status,save:async values=>{scopes=values;return save(values);},now},mappings,snapshots);
 assert.equal(result.complete,false);assert.equal(result.saved_outflows,1);assert.equal(result.synced_accounts,2);assert.equal(scopes.find(scope=>scope.account_id===second&&scope.from==='2026-10-01')?.status,'confirmation-needed');
});

test('deadline, page cap, cancellation and storage failure cannot report full synchronization',async()=>{
 let clock=now();const result=await syncClobePlanActuals({readPage:withEmptySeptember(async()=>{clock+=43000;return page();}),readStatus:status,save,now:()=>clock},[mapping],[snapshot]);assert.equal(result.complete,false);
 const signal=AbortSignal.abort(),aborted=await syncClobePlanActuals({readPage:async()=>{throw Error('should never read');},readStatus:status,save,now,signal},[mapping],[snapshot]);assert.equal(aborted.complete,false);
 const storage=await syncClobePlanActuals({readPage:withEmptySeptember(async()=>page()),readStatus:status,save:async()=>{throw Error('storage unavailable');},now},[mapping],[snapshot]);assert.equal(storage.complete,false);assert.equal(storage.saved_outflows,0);assert.equal(storage.fetched_outflows,1);
 let count=0;const limited=await syncClobePlanActuals({readPage:withEmptySeptember(async()=>{count++;return page([actual(String(count),{amount:count,balance:1000-count})],{hasNext:true,nextCursor:`page-${count+1}`,totalElements:null});}),readStatus:status,save,now},[mapping],[snapshot]);
 assert.equal(count,20);assert.equal(limited.complete,false);assert.equal(limited.saved_outflows,0);assert.match(limited.skipped[0].reason,/상한/);
});

test('failure recorded by both reader and storage is shown once per account',async()=>{
 const result=await syncClobePlanActuals({readPage:async()=>{throw Error('query failed');},readStatus:status,save:async scopes=>({...await save(scopes),skipped:scopes.map(scope=>({account_id:scope.account_id,reason:scope.reason!}))}),now},[mapping],[snapshot]);
 assert.equal(result.skipped.length,1);assert.equal(result.complete,false);
});

test('safe raw source parser retains original basic/detail/counterparty and does not infer them from provider category',async()=>{
 const session:ClobeReadSession={close:async()=>{},call:async()=>({content:[{transactionId:1,accountId:1,transactionAt:'2026-10-02T10:00:00',transactionName:'Synthetic bank text',transactionDescription:'Synthetic detail',businessEntityName:'Explicit party',inAmount:0,outAmount:100,afterBalance:900,category:'Ignore provider category'}],hasNext:false,nextCursor:null,totalElements:1})};
 const result=await readClobePlanActualPage(session,{companyId:'synthetic-company',bankAccountId:1,startDate:'2026-10-01',endDate:'2026-10-13',size:100},collected);
 assert.deepEqual(result.sourceRows[0].source_details,{basic:'Synthetic bank text',detail:'Synthetic detail',counterparty:'Explicit party'});assert.equal('category' in result.sourceRows[0],false);
});

test('balance snapshot updates can succeed while plan evidence is explicitly partial',async()=>{
 const result=await syncClobeBalances({getMappings:async()=>[mapping],readAccounts:async()=>({fetchedAt:'2026-10-13T03:00:00Z',companies:[{id:mapping.company_id,name:'Synthetic',role:'MASTER',error:null,scraping:{status:'SUCCESS',lastCollectedAt:collected,error:null},accounts:[{id:1,name:'Synthetic account',bankName:'Bank',maskedNumber:'0001',currency:'KRW',balance:900,krwBalance:900,isHidden:false}]}]}),save:async()=>({synced:1,unchanged:0,skipped:[]}),now,planActuals:{readPage:async()=>{throw Error('query failed');},readStatus:status,save,now}});
 assert.equal(result.synced,1);assert.equal(result.plan_actuals?.complete,false);assert.equal(result.plan_actuals?.saved_outflows,0);
});

const novemberCollected='2026-11-02T11:00:00',novemberNow=()=>Date.parse('2026-11-02T12:00:00+09:00');
const novemberSnapshot={...snapshot,balance_date:'2026-11-02',collected_at:novemberCollected};
const scopedPage=(request:ClobeTransactionsRequest,at:string,rows:ClobePlanActualRow[]=[],extra:Partial<ClobePlanPage>={}):ClobePlanPage=>page(rows,{
 companyId:request.companyId,bankAccountId:request.bankAccountId,startDate:request.startDate,endDate:request.endDate,
 scraping:{status:'SUCCESS',lastCollectedAt:at,error:null},...extra,
});
const novemberStatus=async()=>({status:'SUCCESS',lastCollectedAt:novemberCollected,error:null});

test('November synchronization refreshes the complete October scope with the true November collection time',async()=>{
 const requests:ClobeTransactionsRequest[]=[],saved:ClobePlanActualScope[]=[],before=structuredClone(novemberSnapshot);
 const result=await syncClobePlanActuals({readPage:async(request,at)=>{
  requests.push(request);assert.equal(at,novemberCollected);
  return scopedPage(request,at,[actual(request.startDate.slice(5,7),{txn_date:request.endDate})]);
 },readStatus:novemberStatus,save:async scopes=>{saved.push(...scopes);return save(scopes);},now:novemberNow},[mapping],[novemberSnapshot]);
 assert.deepEqual(requests.map(({startDate,endDate})=>[startDate,endDate]),[['2026-10-01','2026-10-31'],['2026-11-01','2026-11-02']]);
 assert.equal(result.complete,true);assert.equal(result.saved_outflows,2);assert.equal(result.synced_accounts,1);
 assert.ok(saved.every(scope=>scope.status==='complete'&&scope.collected_at===novemberCollected));
 assert.deepEqual(novemberSnapshot,before);
});

test('the recent two calendar months cross the year boundary without reading older history or future dates',async()=>{
 const at='2027-01-01T11:00:00',instant=()=>Date.parse('2027-01-01T12:00:00+09:00'),requests:ClobeTransactionsRequest[]=[];
 const result=await syncClobePlanActuals({readPage:async(request,collectedAt)=>{requests.push(request);return scopedPage(request,collectedAt);},
  readStatus:async()=>({status:'SUCCESS',lastCollectedAt:at,error:null}),save,now:instant},[mapping],[{...snapshot,balance_date:'2027-01-01',collected_at:at}]);
 assert.equal(result.complete,true);
 assert.deepEqual(requests.map(({startDate,endDate})=>[startDate,endDate]),[['2026-12-01','2026-12-31'],['2027-01-01','2027-01-01']]);
});

test('stale October collection cannot claim October month-end or any November bank coverage',async()=>{
 const at='2026-10-29T11:00:00',requests:ClobeTransactionsRequest[]=[];let saved:ClobePlanActualScope[]=[];
 const result=await syncClobePlanActuals({readPage:async(request,collectedAt)=>{requests.push(request);return scopedPage(request,collectedAt);},
  readStatus:async()=>({status:'SUCCESS',lastCollectedAt:at,error:null}),save:async scopes=>{saved=scopes;return save(scopes);},now:novemberNow},[mapping],[{...snapshot,balance_date:'2026-10-29',collected_at:at}]);
 assert.equal(result.complete,false);
 assert.deepEqual(requests.map(({startDate,endDate})=>[startDate,endDate]),[['2026-10-01','2026-10-29']]);
 assert.equal(octoberScope(saved).collected_at,at);assert.equal(octoberScope(saved).to,'2026-10-29');
 const november=saved.find(scope=>scope.from==='2026-11-01')!;
 assert.equal(november.to,'2026-11-02');assert.equal(november.collected_at,null);assert.equal(november.status,'confirmation-needed');assert.deepEqual(november.rows,[]);
});

test('missing, too-old or future collection creates failure scopes without reading or inventing a source time',async()=>{
 for(const snapshots of [[],[{...snapshot,balance_date:'2026-09-29',collected_at:'2026-09-29T11:00:00'}],[{...snapshot,balance_date:'2026-11-03',collected_at:'2026-11-03T11:00:00'}]]){
  let reads=0,saved:ClobePlanActualScope[]=[];
  const result=await syncClobePlanActuals({readPage:async()=>{reads++;throw Error('unexpected request');},readStatus:novemberStatus,
   save:async scopes=>{saved=scopes;return save(scopes);},now:novemberNow},[mapping],snapshots);
  assert.equal(result.complete,false);assert.equal(reads,0);assert.equal(saved.length,2);
  assert.ok(saved.every(scope=>scope.from<=scope.to&&scope.status==='confirmation-needed'&&scope.collected_at===null&&scope.rows.length===0));
 }
});

test('an incomplete previous month does not discard the independently complete current month',async()=>{
 let saved:ClobePlanActualScope[]=[];
 const result=await syncClobePlanActuals({readPage:async(request,at)=>request.startDate==='2026-10-01'
  ?scopedPage(request,at,[],{totalElements:1})
  :scopedPage(request,at,[actual('11',{txn_date:'2026-11-02'})]),readStatus:novemberStatus,
  save:async scopes=>{saved=scopes;return save(scopes);},now:novemberNow},[mapping],[novemberSnapshot]);
 assert.equal(result.complete,false);assert.equal(result.saved_outflows,1);
 assert.equal(octoberScope(saved).status,'confirmation-needed');assert.deepEqual(octoberScope(saved).rows,[]);
 assert.equal(saved.find(scope=>scope.from==='2026-11-01')?.status,'complete');assert.match(result.skipped[0].reason,/2026-10/);
});

test('the same provider ID appearing in two different months holds both scopes',async()=>{
 let saved:ClobePlanActualScope[]=[];
 const result=await syncClobePlanActuals({readPage:async(request,at)=>scopedPage(request,at,[actual('99',{txn_date:request.endDate})]),
  readStatus:novemberStatus,save:async scopes=>{saved=scopes;return save(scopes);},now:novemberNow},[mapping],[novemberSnapshot]);
 assert.equal(result.complete,false);assert.equal(result.saved_outflows,0);assert.equal(result.fetched_outflows,0);
 assert.ok(saved.every(scope=>scope.status==='confirmation-needed'&&scope.rows.length===0));assert.equal(result.skipped.length,1);
});

test('monthly requests across multiple accounts keep upstream concurrency at two',async()=>{
 const mappings=[mapping,{...mapping,account_id:second,external_account_id:'2'},{...mapping,account_id:'10000000-0000-4000-8000-000000000003',external_account_id:'3'}];
 let active=0,maximum=0,requests=0;
 const result=await syncClobePlanActuals({readPage:async(request,at)=>{active++;maximum=Math.max(maximum,active);requests++;await Promise.resolve();active--;return scopedPage(request,at);},
  readStatus:novemberStatus,save,now:novemberNow},mappings,mappings.map(item=>({...novemberSnapshot,...item})));
 assert.equal(result.complete,true);assert.equal(requests,6);assert.equal(maximum,2);
});

test('different external IDs with padding-only bank label differences hold the whole month',async()=>{
 const first=actual('1',{description:'  Synthetic   monthly\tfee ',party:' Synthetic   payee ',source_details:{basic:' Synthetic   company ',detail:' Monthly\t fee ',counterparty:' Synthetic   payee '}});
 const second=actual('2',{description:'Synthetic monthly fee',party:'Synthetic payee',source_details:{basic:'Synthetic company',detail:'Monthly fee',counterparty:'Synthetic payee'}});
 const before=structuredClone([first,second]);let saved:ClobePlanActualScope[]=[];
 const result=await syncClobePlanActuals({readPage:withEmptySeptember(async()=>page([first,second])),readStatus:status,
  save:async scopes=>{saved=scopes;return save(scopes);},now},[mapping],[snapshot]);
 assert.equal(result.complete,false);assert.equal(octoberScope(saved).status,'confirmation-needed');assert.deepEqual(octoberScope(saved).rows,[]);
 assert.equal(result.saved_outflows,0);assert.deepEqual([first,second],before);
});

test('fingerprint whitespace comparison never rewrites the saved original bank labels',async()=>{
 const source=actual('1',{description:'  Synthetic   monthly\tfee ',party:' Synthetic   payee ',source_details:{basic:' Synthetic   company ',detail:' Monthly\t fee ',counterparty:' Synthetic   payee '}});
 const before=structuredClone(source);let saved:ClobePlanActualScope[]=[];
 const result=await syncClobePlanActuals({readPage:withEmptySeptember(async()=>page([source])),readStatus:status,
  save:async scopes=>{saved=scopes;return save(scopes);},now},[mapping],[snapshot]);
 assert.equal(result.complete,true);assert.deepEqual(octoberScope(saved).rows,[before]);assert.deepEqual(source,before);
});

test('bank label fingerprinting does not fold case, punctuation or Unicode width',async()=>{
 for(const [first,second] of [['Synthetic Fee','synthetic fee'],['Synthetic-Fee','Synthetic Fee'],['ＡＢＣ','ABC']]){
  let saved:ClobePlanActualScope[]=[];
  const result=await syncClobePlanActuals({readPage:withEmptySeptember(async()=>page([actual('1',{description:first}),actual('2',{description:second})])),
   readStatus:status,save:async scopes=>{saved=scopes;return save(scopes);},now},[mapping],[snapshot]);
  assert.equal(result.complete,true);assert.equal(octoberScope(saved).rows.length,2);
 }
});
