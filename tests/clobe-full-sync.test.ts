import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareClobeSync,applyClobeSync,applyClobeImport,previewClobeImport,clobeSyncMonthRange,parseClobeImportInput,type ClobeImportDependencies} from '../lib/clobe/import-service';
import {fetchClobeSyncRows,verifyClobeSyncSource} from '../lib/clobe/import-source';
import {clobeImportHandlers} from '../lib/clobe/import-route';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';
import type {ClobeImportRow,ClobeImportScope} from '../lib/finance/clobe-import';
import type {ClobeReadSession} from '../lib/clobe/mcp';

const account='10000000-0000-4000-8000-000000000001',business='10000000-0000-4000-8000-000000000002',fee='10000000-0000-4000-8000-000000000003',salary='10000000-0000-4000-8000-000000000004';
const now=()=>Date.parse('2026-10-13T12:00:00+09:00'),collected='2026-10-13T11:00:00';
const mapping={company_id:'synthetic-company',external_account_id:'1',account_id:account};
const scope:ClobeImportScope={connection_id:null,mappings:[mapping],start_date:'2026-10-01',end_date:'2026-10-13'};
const collections=[{account_id:account,from:scope.start_date,to:scope.end_date,collected_at:collected}];
const incoming=(patch:Partial<ClobeImportRow>={}):ClobeImportRow=>({...mapping,external_transaction_id:'11',currency:'KRW',txn_date:'2026-10-02',txn_time:'12:00:00',amount:100,balance:900,direction:'out',description:'Synthetic service',source_details:{basic:'Synthetic service',note:'Provider label: salary'},...patch});
const dataset=():Dataset=>({...emptyDataset,accounts:[{id:account,business_id:business,name:'Synthetic',bank:'Bank',masked_number:'0001',opening_balance:0,opening_balance_date:null}],categories:[{id:fee,name:'지급수수료',group_name:'영업지출',is_operating:true,is_internal:false},{id:salary,name:'급여',group_name:'영업지출',is_operating:true,is_internal:false}],rules:[{id:'rule',pattern:'^Synthetic service$',field:'description',category_id:fee,priority:1,is_internal:false,account_id:account,direction:'out'}]});
const ledger=(patch:Partial<Transaction>={}):Transaction=>({id:'20000000-0000-4000-8000-000000000001',business_id:business,account_id:account,upload_id:null,txn_date:'2026-10-02',txn_time:'12:00:00',amount:100,balance:900,direction:'out',description:'Original manual row',raw_gwamok:'급여',category_id:salary,is_internal:false,tax_invoice:true,manually_classified:true,dedup_hash:'a'.repeat(40),...patch});
function fixture(data=dataset(),rows=[incoming()]){
 let stored:Record<string,unknown>|undefined,applies=0,fetches=0,validations=0,mappings=[mapping];const payloads:Record<string,unknown>[]=[];
 const deps:ClobeImportDependencies={userId:account,ownerId:business,now,getDataset:async()=>data,getRefs:async()=>[],fetchSource:async()=>rows,fetchSyncSource:async()=>{fetches++;return {rows,accounts:collections};},validateSyncSource:async()=>{validations++;},seal:value=>JSON.stringify(value),open:value=>JSON.parse(value),rpc:async(action,payload)=>{
  if(action==='settings')return {mappings};
  if(action==='store'){stored={...payload,request_hash:null,result:null};return {};}
  if(action==='read')return stored;
  if(action==='apply'){applies++;payloads.push(payload);const changes=payload.changes as {kind:string}[],summary=payload.summary as Record<string,number>;const result={run_id:payload.id,inserted:changes.filter(c=>c.kind==='insert').length,referenced:changes.filter(c=>c.kind==='reference').length,...summary,updated:0,removed:0};stored={...stored,ciphertext:'emptied',request_hash:payload.request_hash,result};return result;}
  throw Error('unexpected RPC');
 }};
 return {deps,data,payloads,get applies(){return applies;},get fetches(){return fetches;},get validations(){return validations;},get stored(){return stored;},setMappings:(value:typeof mappings)=>{mappings=value;}};
}

test('automatic monthly scope uses server mappings and fixed saved-rule choices with no financial HTTP rows',async()=>{
 const f=fixture(),before=structuredClone(f.data),prepared=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},f.deps);
 assert.equal(prepared.summary.inserted,1);assert.equal(prepared.unclassified,0);assert.equal(prepared.scope.account_count,1);assert.equal(prepared.scope.business_count,1);assert.deepEqual(prepared.scope.accounts,collections);
 assert.equal('rows' in prepared,false);assert.equal('ciphertext' in prepared,false);assert.equal('choices' in prepared,false);
 const encrypted=JSON.parse(f.stored!.ciphertext as string);assert.equal(encrypted.mode,'automatic');assert.equal(encrypted.choices[0].category_id,fee);
 // Rule changes after a frozen preparation do not replace that run's choices.
 f.data.rules[0].category_id=salary;
 const result=await applyClobeSync({action:'sync_apply',previewId:prepared.previewId},f.deps);
 const changes=f.payloads[0].changes as {row:{category_id:string}}[];assert.equal(changes[0].row.category_id,fee);assert.equal(result.unclassified,0);assert.equal(result.updated,0);assert.equal(result.removed,0);
 f.data.rules[0].category_id=fee;assert.deepEqual(f.data,before);assert.equal(f.validations,1);
});

test('unmatched new rows remain unclassified and completed run replay needs no source or ciphertext',async()=>{
 const f=fixture(dataset(),[incoming({description:'Unmatched service',source_details:{note:'Provider salary'}})]),prepared=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},f.deps);
 assert.equal(prepared.unclassified,1);const input={action:'sync_apply' as const,previewId:prepared.previewId};
 const first=await applyClobeSync(input,f.deps);assert.equal(first.unclassified,1);assert.equal((f.payloads[0].changes as {row:{category_id:null;manually_classified:boolean}}[])[0].row.category_id,null);
 const replay=await applyClobeSync(input,f.deps);assert.equal(replay.replayed,true);assert.equal(replay.unclassified,null);assert.equal(f.applies,1);assert.equal(f.fetches,1);assert.equal(f.validations,1);
});

test('existing manual classifications are reference-only and ambiguous account-day remains blocked',async()=>{
 const data=dataset(),original=ledger();data.transactions=[original];const f=fixture(data,[incoming(),incoming({external_transaction_id:'12',txn_date:'2026-10-03',amount:300,balance:600})]);
 const prepared=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},f.deps);assert.equal(prepared.summary.referenced,1);assert.equal(prepared.summary.inserted,1);
 await applyClobeSync({action:'sync_apply',previewId:prepared.previewId},f.deps);assert.deepEqual(data.transactions,[original]);
 const blocked=fixture(data,[incoming({txn_time:null,balance:null}),incoming({external_transaction_id:'12',amount:200,balance:700}),incoming({external_transaction_id:'13',txn_date:'2026-10-03',amount:300,balance:400})]);
 const review=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},blocked.deps);assert.equal(review.summary.blocked,2);assert.equal(review.summary.inserted,1);assert.ok(review.conflicts.some(c=>c.code==='partial-day'));
});

test('manual and automatic snapshots cannot cross apply; unsupported browser fields rejected',async()=>{
 const manual=fixture(),review=await previewClobeImport({action:'preview',start_date:scope.start_date,end_date:scope.end_date,mappings:[mapping]},manual.deps);
 await assert.rejects(()=>applyClobeSync({action:'sync_apply',previewId:review.previewId},manual.deps),{code:'invalid_request'});assert.equal(manual.applies,0);
 const auto=fixture(),prepared=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},auto.deps);
 await assert.rejects(()=>applyClobeImport({action:'apply',previewId:prepared.previewId,choices:[]},auto.deps),{code:'invalid_request'});assert.equal(auto.applies,0);
 for(const input of [{action:'sync_prepare',month:'2026-10',mappings:[mapping]},{action:'sync_prepare',month:'2026-10',start_date:'2026-01-01'},{action:'sync_apply',previewId:account,choices:[]},{action:'sync_apply',previewId:account,amount:10}])assert.throws(()=>parseClobeImportInput(input));
});

test('month policy, deleted categories, expired previews and concurrent saved rows prevent automatic writes',async()=>{
 assert.deepEqual(clobeSyncMonthRange('2026-09',now()),{start_date:'2026-09-01',end_date:'2026-09-30'});assert.equal(clobeSyncMonthRange('2026-10',now()).end_date,'2026-10-13');
 for(const month of ['2025-12','2026-11','2026-13','2026-1'])assert.throws(()=>clobeSyncMonthRange(month,now()));
 for(const mode of ['category','concurrent','expired','mappings','collection']){
  const f=fixture(),prepared=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},f.deps);
  if(mode==='category')f.data.categories=[];if(mode==='concurrent')f.data.transactions=[ledger()];if(mode==='expired')f.deps.now=()=>now()+3*3600000;if(mode==='mappings')f.setMappings([]);if(mode==='collection')f.deps.validateSyncSource=async()=>{throw Error('source changed');};
  await assert.rejects(()=>applyClobeSync({action:'sync_apply',previewId:prepared.previewId},f.deps));assert.equal(f.applies,0,mode);
 }
});

test('automatic preparation rejects older months while committed opaque replay remains recoverable outside the new window',async()=>{
 const f=fixture();await assert.rejects(()=>prepareClobeSync({action:'sync_prepare',month:'2026-08'},f.deps),{code:'invalid_request'});assert.equal(f.stored,undefined);
 const committed=fixture(),prepared=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},committed.deps),input={action:'sync_apply' as const,previewId:prepared.previewId};
 await applyClobeSync(input,committed.deps);committed.deps.now=()=>Date.parse('2027-01-02T12:00:00+09:00');
 const recovered=await applyClobeSync(input,committed.deps);assert.equal(recovered.replayed,true);assert.equal(committed.applies,1);
 // Simulate a still-valid automatic snapshot created by the former wider
 // policy, without generating or importing any historical financial record.
 const old=fixture(),recent=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},old.deps);
 const stored=old.stored!,snapshot=JSON.parse(stored.ciphertext as string);snapshot.scope.start_date='2026-08-01';snapshot.scope.end_date='2026-08-31';stored.ciphertext=JSON.stringify(snapshot);
 await assert.rejects(()=>applyClobeSync({action:'sync_apply',previewId:recent.previewId},old.deps),{code:'stale'});assert.equal(old.applies,0);assert.equal(old.validations,0);
});

test('the recent automatic window does not restrict a manually selected historical preview',async()=>{
 const f=fixture(dataset(),[incoming({txn_date:'2026-01-02'})]);
 const prepared=await previewClobeImport({action:'preview',start_date:'2026-01-01',end_date:'2026-01-31',mappings:[mapping]},f.deps);
 assert.equal(prepared.summary.inserted,1);
 assert.equal((await applyClobeImport({action:'apply',previewId:prepared.previewId,choices:prepared.rows.filter(r=>r.kind==='insert').map(r=>({key:r.key,category_id:fee}))},f.deps)).inserted,1);
});

test('mapping JSON key order does not change a server-confirmed automatic scope',async()=>{
 const f=fixture(),prepared=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},f.deps);
 f.setMappings([{account_id:account,external_account_id:'1',company_id:'synthetic-company'}]);
 assert.equal((await applyClobeSync({action:'sync_apply',previewId:prepared.previewId},f.deps)).inserted,1);
});

test('all six server-confirmed accounts across four businesses are prepared without client scope selection',async()=>{
 const f=fixture(),mappings=[mapping];
 for(let i=1;i<6;i++){
  const id=`10000000-0000-4000-8000-${String(20+i).padStart(12,'0')}`;
  f.data.accounts.push({...f.data.accounts[0],id,business_id:i<3?business:`10000000-0000-4000-8000-${String(50+i).padStart(12,'0')}`});
  mappings.push({...mapping,external_account_id:String(i+1),account_id:id});
 }
 f.setMappings(mappings);f.deps.fetchSyncSource=async()=>({rows:mappings.map((m,i)=>incoming({...m,external_transaction_id:String(11+i)})),accounts:mappings.map(m=>({...collections[0],account_id:m.account_id}))});
 const prepared=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},f.deps);
 assert.equal(prepared.scope.account_count,6);assert.equal(prepared.scope.business_count,4);assert.equal(prepared.summary.inserted,6);assert.equal(prepared.unclassified,5);
 assert.equal((await applyClobeSync({action:'sync_apply',previewId:prepared.previewId},f.deps)).inserted,6);
});

function sourceSession(mode='ok',calls:{tool:string;input?:Record<string,unknown>}[]=[]):ClobeReadSession{
 let statusCalls=0;return {close:async()=>{},call:async(tool,input)=>{
  calls.push({tool,input});
  if(tool==='get_my_context')return {companies:[{companyId:mapping.company_id,companyName:'Synthetic business',role:'MASTER'}]};
  if(tool==='get_bank_accounts')return {accounts:[{bankAccountId:1,accountName:'Synthetic',currencyCode:mode==='FX'?'USD':'KRW',isHidden:false,balance:1000}]};
  if(tool==='get_scraping_status'){statusCalls++;return {overallStatus:'SUCCESS',assets:[{category:'BANK',label:'Bank',status:mode==='pending'?'IN_PROGRESS':'SUCCESS',scrapedAt:mode==='changed'&&statusCalls>1?'2026-10-13T11:01:00':mode==='future'?'2026-10-14T11:00:00':mode==='unknown'?null:collected}]};}
  const row={transactionId:11,accountId:1,transactionAt:mode==='row-future'?'2026-10-13T11:00:01':'2026-10-02T12:00:00',transactionName:'Synthetic service',transactionDescription:'Original detail',inAmount:0,outAmount:mode==='fractional'?0.5:100,afterBalance:900};
  return {content:[row],hasNext:false,nextCursor:null,totalElements:mode==='missing'?2:1};
 }};
}

test('strict automatic collection clamps to bank collection and guards complete pre/post source status',async()=>{
 const calls:{tool:string;input?:Record<string,unknown>}[]=[],result=await fetchClobeSyncRows(sourceSession('ok',calls),{...scope,end_date:'2026-10-31'},undefined,now);
 assert.equal(result.rows.length,1);assert.equal(result.accounts[0].to,'2026-10-13');assert.equal(calls.find(c=>c.tool==='get_labeled_transactions')?.input?.endDate,'2026-10-13');assert.equal(calls.filter(c=>c.tool==='get_scraping_status').length,2);
 assert.equal(result.rows[0].source_details?.basic,'Synthetic service');
 for(const mode of ['pending','changed','future','unknown','row-future','fractional','missing','FX'])await assert.rejects(()=>fetchClobeSyncRows(sourceSession(mode),scope,undefined,now),mode);
});

test('failed pages, deadline and cancelled collection produce no automatic prepared snapshot',async()=>{
 for(const mode of ['read','timeout','abort']){
  const f=fixture();f.deps.fetchSyncSource=async()=>{if(mode==='read')throw Error('interrupted page');return fetchClobeSyncRows(sourceSession(),scope,mode==='abort'?AbortSignal.abort():undefined,mode==='timeout'?(()=>{let calls=0;return ()=>now()+calls++*46000;})():now);};
  await assert.rejects(()=>prepareClobeSync({action:'sync_prepare',month:'2026-10'},f.deps));assert.equal(f.stored,undefined);assert.equal(f.applies,0);
 }
});

test('failure of a later mapped account discards only that account and applies the healthy account/month',async()=>{
 const f=fixture(),second='10000000-0000-4000-8000-000000000008',mappings=[mapping,{...mapping,external_account_id:'2',account_id:second}];
 f.data.accounts.push({...f.data.accounts[0],id:second});f.setMappings(mappings);
 const base=sourceSession(),session:ClobeReadSession={close:base.close,call:async(tool,input)=>{
  if(tool==='get_bank_accounts')return {accounts:[1,2].map(id=>({bankAccountId:id,accountName:'Synthetic',currencyCode:'KRW',isHidden:false,balance:1000}))};
  if(tool==='get_labeled_transactions'&&input?.accountId===2)throw Error('Synthetic second account failed');
  return base.call(tool,input);
 }};
 f.deps.fetchSyncSource=scope=>fetchClobeSyncRows(session,scope,undefined,now);
 const prepared=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},f.deps);
 assert.equal(prepared.scope.account_count,1);assert.equal(prepared.scope.configured_account_count,2);assert.equal(prepared.skipped?.[0].account_id,second);
 assert.equal(JSON.parse(f.stored!.ciphertext as string).configuredMappings.length,2);
 assert.equal((await applyClobeSync({action:'sync_apply',previewId:prepared.previewId},f.deps)).inserted,1);
 assert.equal((f.payloads[0].scope as ClobeImportScope).mappings.length,1);
 const changed=fixture(f.data);changed.setMappings(mappings);changed.deps.fetchSyncSource=f.deps.fetchSyncSource;
 const next=await prepareClobeSync({action:'sync_prepare',month:'2026-10'},changed.deps);changed.setMappings([mapping]);
 await assert.rejects(()=>applyClobeSync({action:'sync_apply',previewId:next.previewId},changed.deps),{code:'stale'});assert.equal(changed.applies,0);
});

test('partially read pages of one failed account never escape into the healthy account scope',async()=>{
 const second='10000000-0000-4000-8000-000000000008',mappings=[mapping,{...mapping,external_account_id:'2',account_id:second}],base=sourceSession();
 const session:ClobeReadSession={close:base.close,call:async(tool,input)=>{
  if(tool==='get_bank_accounts')return {accounts:[1,2].map(id=>({bankAccountId:id,accountName:'Synthetic',currencyCode:'KRW',isHidden:false,balance:1000}))};
  if(tool==='get_labeled_transactions'&&input?.accountId===2){
   if(input.cursor)throw Error('Synthetic later page missing');
   return {content:[{transactionId:12,accountId:2,transactionAt:'2026-10-02T12:00:00',transactionName:'Failed partial account',transactionDescription:'Original',inAmount:0,outAmount:200,afterBalance:800}],hasNext:true,nextCursor:'next',totalElements:2};
  }
  return base.call(tool,input);
 }};
 const source=await fetchClobeSyncRows(session,{...scope,mappings},undefined,now);
 assert.equal(source.rows.length,1);assert.ok(source.rows.every(row=>row.account_id===account));assert.equal(source.accounts.length,1);assert.equal(source.skipped?.[0].account_id,second);
});

test('changed post-collection state excludes that whole company while another company remains usable',async()=>{
 const second='10000000-0000-4000-8000-000000000008',third='10000000-0000-4000-8000-000000000009';
 const mappings=[mapping,{...mapping,external_account_id:'2',account_id:second},{...mapping,company_id:'other-company',external_account_id:'3',account_id:third}],seen=new Map<string,number>();
 const session:ClobeReadSession={close:async()=>{},call:async(tool,input)=>{
  if(tool==='get_my_context')return {companies:['synthetic-company','other-company'].map(companyId=>({companyId,companyName:'Synthetic',role:'MASTER'}))};
  if(tool==='get_bank_accounts')return {accounts:(input?.companyId==='other-company'?[3]:[1,2]).map(id=>({bankAccountId:id,accountName:'Synthetic',currencyCode:'KRW',isHidden:false,balance:1000}))};
  if(tool==='get_scraping_status'){const id=String(input?.companyId),count=(seen.get(id)??0)+1;seen.set(id,count);return {overallStatus:'SUCCESS',assets:[{category:'BANK',label:'Bank',status:'SUCCESS',scrapedAt:id==='synthetic-company'&&count>1?'2026-10-13T11:01:00':collected}]};}
  const id=Number(input?.accountId);return {content:[{transactionId:10+id,accountId:id,transactionAt:'2026-10-02T12:00:00',transactionName:'Synthetic',transactionDescription:'Original',inAmount:0,outAmount:100,afterBalance:900}],hasNext:false,nextCursor:null,totalElements:1};
 }};
 const result=await fetchClobeSyncRows(session,{...scope,mappings},undefined,now);
 assert.deepEqual(result.accounts.map(a=>a.account_id),[third]);assert.deepEqual(new Set(result.skipped?.map(a=>a.account_id)),new Set([account,second]));assert.ok(result.rows.every(row=>row.account_id===third));
});

test('dynamic two-account workers finish healthy accounts behind a slow one and reject its late result',async()=>{
 const ids=[account,...[8,9,10].map(i=>`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`)],mappings=ids.map((account_id,i)=>({...mapping,account_id,external_account_id:String(i+1)})),base=sourceSession();
 let resolveSlow!:(value:unknown)=>void;const slow=new Promise<unknown>(done=>{resolveSlow=done;});const completed:number[]=[];let active=0,maxActive=0;
 const page=(id:number)=>({content:[{transactionId:10+id,accountId:id,transactionAt:'2026-10-02T12:00:00',transactionName:'Synthetic',transactionDescription:'Original',inAmount:0,outAmount:100,afterBalance:900}],hasNext:false,nextCursor:null,totalElements:1});
 const session:ClobeReadSession={close:base.close,call:async(tool,input,options)=>{
  if(tool==='get_bank_accounts')return {accounts:[1,2,3,4].map(id=>({bankAccountId:id,accountName:'Synthetic',currencyCode:'KRW',isHidden:false,balance:1000}))};
  if(tool==='get_labeled_transactions'){
   const id=Number(input?.accountId);active++;maxActive=Math.max(maxActive,active);
   try{if(id===1){assert.ok(options?.signal);return await slow;}await Promise.resolve();completed.push(id);if(id===4)resolveSlow(page(1));return page(id);}finally{active--;}
  }
  return base.call(tool,input);
 }};
 const result=await fetchClobeSyncRows(session,{...scope,mappings},undefined,now);assert.deepEqual(completed,[2,3,4]);assert.equal(maxActive,2);assert.equal(result.accounts.length,4);
 // A source that ignores cancellation must still never yield adopted rows.
 let clock=now();const late:ClobeReadSession={close:base.close,call:async(tool,input,options)=>{
  if(tool==='get_bank_accounts')return {accounts:[1,2].map(id=>({bankAccountId:id,accountName:'Synthetic',currencyCode:'KRW',isHidden:false,balance:1000}))};
  if(tool==='get_labeled_transactions'&&input?.accountId===1){assert.ok(options?.signal);clock+=33000;return page(1);}
  return base.call(tool,input);
 }};
 await assert.rejects(()=>fetchClobeSyncRows(late,{...scope,mappings:mappings.slice(0,2)},undefined,()=>clock),{code:'incomplete'});
});

test('all skipped accounts return safe metadata without creating or applying an opaque snapshot',async()=>{
 const f=fixture();f.deps.fetchSyncSource=scope=>fetchClobeSyncRows(sourceSession('pending'),scope,undefined,now);
 const handlers=clobeImportHandlers({getOrigin:()=> 'https://merlin.example.test',authenticate:async()=>({openSession:async()=>sourceSession(),makeDependencies:()=>f.deps})});
 const response=await handlers.POST(new Request('https://merlin.example.test/api/clobe/import',{method:'POST',headers:{Origin:'https://merlin.example.test','Content-Type':'application/json'},body:JSON.stringify({action:'sync_prepare',month:'2026-10'})}));
 assert.equal(response.status,504);const payload=await response.json() as {configured_account_count:number;skipped:{account_id:string;code:string;reason:string}[]};
 assert.equal(payload.configured_account_count,1);assert.equal(payload.skipped[0].account_id,account);assert.equal(payload.skipped[0].code,'collection');assert.equal(f.stored,undefined);assert.equal(f.applies,0);
});

test('automatic apply checks current scope and source time without downloading transactions again',async()=>{
 const calls:{tool:string;input?:Record<string,unknown>}[]=[];
 await verifyClobeSyncSource(sourceSession('ok',calls),scope,collections,now);assert.equal(calls.some(c=>c.tool==='get_labeled_transactions'),false);
 await assert.rejects(()=>verifyClobeSyncSource(sourceSession('ok'),scope,[{...collections[0],collected_at:'2026-10-13T10:00:00'}],now));
 await assert.rejects(()=>verifyClobeSyncSource(sourceSession('pending'),scope,collections,now));
});

test('automatic routes remain same-origin authenticated minimal no-store requests',async()=>{
 const f=fixture(),handlers=clobeImportHandlers({getOrigin:()=> 'https://merlin.example.test',authenticate:async()=>({openSession:async()=>sourceSession(),makeDependencies:()=>f.deps})});
 const post=(body:unknown)=>handlers.POST(new Request('https://merlin.example.test/api/clobe/import',{method:'POST',headers:{Origin:'https://merlin.example.test','Content-Type':'application/json'},body:JSON.stringify(body)}));
 const response=await post({action:'sync_prepare',month:'2026-10'});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');const result=await response.json() as {previewId:string};
 const apply=await post({action:'sync_apply',previewId:result.previewId});assert.equal(apply.status,200);assert.equal((await apply.json() as {inserted:number}).inserted,1);
 assert.equal((await post({action:'sync_prepare',month:'2026-10',mappings:[mapping]})).status,400);
});
