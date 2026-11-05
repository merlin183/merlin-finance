import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {buildClobeAppendPlan,clobeCandidatesHash,type ClobeImportRow,type ClobeImportScope} from '../lib/finance/clobe-import';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';
import {applyClobeCategoryChoices,applyClobeImport,parseClobeImportInput,previewClobeImport,type ClobeImportDependencies} from '../lib/clobe/import-service';
import {openClobePreview,sealClobePreview,signClobeImport} from '../lib/clobe/import-security';
import {fetchClobeImportRows,verifyClobeImportAccess} from '../lib/clobe/import-source';
import type {ClobeReadSession} from '../lib/clobe/mcp';

const account='10000000-0000-4000-8000-000000000001',business='10000000-0000-4000-8000-000000000002',fee='10000000-0000-4000-8000-000000000003',salary='10000000-0000-4000-8000-000000000004';
const scope:ClobeImportScope={connection_id:null,mappings:[{company_id:'synthetic-company',external_account_id:'1',account_id:account}],start_date:'2026-10-01',end_date:'2026-10-07'};
function dataset():Dataset{return {...emptyDataset,accounts:[{id:account,business_id:business,name:'Synthetic bank',bank:'BANK',masked_number:'1234',opening_balance:0,opening_balance_date:null}],categories:[{id:fee,name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true},{id:salary,name:'급여',group_name:'영업지출',is_internal:false,is_operating:true}],rules:[{id:'rule1',pattern:'Synthetic recipient',field:'description',category_id:fee,priority:1,is_internal:false,account_id:account,direction:'out'}]};}
function row(patch:Partial<ClobeImportRow>={}):ClobeImportRow{return {company_id:'synthetic-company',external_account_id:'1',external_transaction_id:'11',account_id:account,currency:'KRW',txn_date:'2026-10-02',txn_time:'12:34:56',amount:100,direction:'out',balance:900,description:'Synthetic recipient',raw_gwamok:'급여',source_details:{basic:'Synthetic recipient',note:'Provider classification: salary'},...patch};}
function saved(patch:Partial<Transaction>={}):Transaction{return {id:'20000000-0000-4000-8000-000000000001',business_id:business,account_id:account,upload_id:'20000000-0000-4000-8000-000000000002',txn_date:'2026-10-02',txn_time:'12:34:56',amount:100,direction:'out',balance:900,description:'Original bank row',raw_gwamok:'급여',category_id:salary,is_internal:false,dedup_hash:'a'.repeat(40),tax_invoice:true,manually_classified:true,source_details:{basic:'Original description'},...patch};}

test('Clobe provider category never overrides the user rule; only new category choices apply',async()=>{
 const data=dataset(),plan=await buildClobeAppendPlan(data,[row()],[],scope);
 assert.equal(plan.summary.inserted,1);assert.equal(plan.changes[0].row.category_id,fee);assert.equal(plan.changes[0].row.raw_gwamok,'');
 const key=JSON.stringify(['synthetic-company','1','11']);
 assert.equal(applyClobeCategoryChoices(plan.changes,[{key,category_id:salary}],data)[0].row.category_id,salary);
 assert.equal(applyClobeCategoryChoices(plan.changes,[{key,category_id:null}],data)[0].row.manually_classified,false);
 assert.throws(()=>applyClobeCategoryChoices(plan.changes,[{key,category_id:business}],data),/삭제되었거나/);
 assert.throws(()=>applyClobeCategoryChoices(plan.changes,[{key,category_id:salary},{key,category_id:fee}],data),/신규 거래에만/);
});
test('exact saved rules classify original bank name/counterparty despite joined display text, retaining account/direction and priority',async()=>{
 const data=dataset(),sales='10000000-0000-4000-8000-000000000006',insurance='10000000-0000-4000-8000-000000000007';
 data.categories.push({id:sales,name:'매출',group_name:'영업수입',is_internal:false,is_operating:true},{id:insurance,name:'보험금',group_name:'영업지출',is_internal:false,is_operating:true});
 data.rules=[
  {id:'broad-description',pattern:'Synthetic',field:'description',category_id:fee,priority:40,is_internal:false},
  {id:'exact-bank-sales',pattern:'^tosspaymen$',field:'description',category_id:sales,priority:1,is_internal:false,account_id:account,direction:'in'},
  {id:'exact-bank-insurer',pattern:'^한화손002건$',field:'description',category_id:insurance,priority:1,is_internal:false,account_id:account,direction:'out'},
 ];
 let plan=await buildClobeAppendPlan(data,[row({direction:'in',description:'tosspaymen · Synthetic settlement',source_details:{basic:'tosspaymen',counterparty:'Synthetic explicit payer'}})],[],scope);
 assert.equal(plan.changes[0].row.category_id,sales);assert.equal(plan.changes[0].row.description,'tosspaymen · Synthetic settlement');
 plan=await buildClobeAppendPlan(data,[row({description:'한화손002건 · Synthetic insurance payment',source_details:{basic:'한화손002건',detail:'Synthetic insurance payment',note:'Provider label: 보험료'}})],[],scope);
 assert.equal(plan.changes[0].row.category_id,insurance);assert.equal(plan.changes[0].row.raw_gwamok,'');
 plan=await buildClobeAppendPlan(data,[row({description:'Synthetic settlement',source_details:{counterparty:'tosspaymen'},direction:'in'})],[],scope);
 assert.equal(plan.changes[0].row.category_id,sales);
 // A better priority on an original field beats a weaker rule matching the
 // joined display. Neither the account nor direction condition is expanded.
 plan=await buildClobeAppendPlan(data,[row({description:'tosspaymen · Synthetic settlement',source_details:{basic:'tosspaymen'},direction:'out'})],[],scope);assert.equal(plan.changes[0].row.category_id,fee);
 data.rules.find(rule=>rule.id==='exact-bank-sales')!.account_id=business;
 plan=await buildClobeAppendPlan(data,[row({description:'tosspaymen · Synthetic settlement',source_details:{basic:'tosspaymen'},direction:'in'})],[],scope);assert.equal(plan.changes[0].row.category_id,fee);
});
test('original-text classification honors priority/id ties and never searches provider labels, memos or substrings for exact rules',async()=>{
 const data=dataset();data.rules=[
  {id:'z-counterparty',pattern:'^Synthetic other payer$',field:'description',category_id:salary,priority:1,is_internal:false},
  {id:'a-bank-name',pattern:'^tosspaymen$',field:'description',category_id:fee,priority:1,is_internal:false},
  {id:'raw-provider',pattern:'^급여$',field:'raw_gwamok',category_id:salary,priority:0,is_internal:false},
 ];
 let plan=await buildClobeAppendPlan(data,[row({description:'Unmatched joined description',source_details:{basic:'tosspaymen',counterparty:'Synthetic other payer'}})],[],scope);assert.equal(plan.changes[0].row.category_id,fee);
 data.rules[0].priority=0;
 plan=await buildClobeAppendPlan(data,[row({description:'Unmatched joined description',source_details:{basic:'tosspaymen',counterparty:'Synthetic other payer'}})],[],scope);assert.equal(plan.changes[0].row.category_id,salary);
 plan=await buildClobeAppendPlan(data,[row({description:'not-tosspaymen',raw_gwamok:'급여',source_details:{basic:'not-tosspaymen',memo:'tosspaymen',note:'Synthetic other payer'}})],[],scope);assert.equal(plan.changes[0].row.category_id,null);
});
test('existing original row with matching time and balance becomes reference, with no financial/classification changes',async()=>{
 const data=dataset(),existing=saved();data.transactions=[existing];const before=structuredClone(data);
 const plan=await buildClobeAppendPlan(data,[row()],[],scope);
 assert.equal(plan.summary.referenced,1);assert.equal(plan.summary.inserted,0);assert.equal(plan.changes[0].transaction_id,existing.id);
 assert.deepEqual(data,before);assert.equal(applyClobeCategoryChoices(plan.changes,[],data)[0].kind,'reference');
 assert.throws(()=>applyClobeCategoryChoices(plan.changes,[{key:JSON.stringify(['synthetic-company','1','11']),category_id:fee}],data),/신규 거래에만/);
});
test('same date different amount stays; insufficient duplicate evidence is held, stable IDs replay and changed original is held',async()=>{
 const data=dataset();data.transactions=[saved()];
 let plan=await buildClobeAppendPlan(data,[row({amount:200})],[],scope);assert.equal(plan.summary.inserted,1);
 plan=await buildClobeAppendPlan(data,[row({txn_time:null,balance:null,description:'New detail'})],[],scope);assert.equal(plan.summary.blocked,1);assert.equal(plan.changes.length,0);
 const referencePlan=await buildClobeAppendPlan(data,[row()],[],scope),reference=referencePlan.changes[0];
 const refs=[{company_id:reference.company_id,external_account_id:reference.external_account_id,external_transaction_id:reference.external_transaction_id,account_id:account,transaction_id:reference.transaction_id,source_fingerprint:reference.source_fingerprint}];
 assert.equal((await buildClobeAppendPlan(data,[row()],refs,scope)).summary.unchanged,1);
 assert.equal((await buildClobeAppendPlan(data,[row({balance:899})],refs,scope)).conflicts[0].code,'changed-source');
 data.transactions[0]={...data.transactions[0],amount:101};assert.equal((await buildClobeAppendPlan(data,[row()],refs,scope)).conflicts[0].code,'changed-source');
});
test('same date and amount retain distinct bank times/balances and match a unique existing payment among others',async()=>{
 const data=dataset();data.transactions=[saved(),saved({id:'20000000-0000-4000-8000-000000000099',txn_time:'13:00:00',balance:800})];
 const plan=await buildClobeAppendPlan(data,[row({txn_time:'14:00:00',balance:700}),row({external_transaction_id:'12',txn_time:'15:00:00',balance:600})],[],scope);
 assert.equal(plan.summary.inserted,2);assert.equal(plan.summary.blocked,0);assert.equal(plan.changes[0].expected_candidates_hash,await clobeCandidatesHash(data.transactions));
 const matched=await buildClobeAppendPlan(data,[row({txn_time:'13:00:00',balance:800})],[],scope);assert.equal(matched.summary.referenced,1);assert.equal(matched.changes[0].transaction_id,data.transactions[1].id);
});
test('a conflict withholds its whole account/day while a complete different day remains importable',async()=>{
 const data=dataset();data.transactions=[saved()];
 const plan=await buildClobeAppendPlan(data,[row({txn_time:null,balance:null}),row({external_transaction_id:'12',amount:200,balance:700}),row({external_transaction_id:'13',txn_date:'2026-10-03',amount:300,balance:400})],[],scope);
 assert.equal(plan.summary.inserted,1);assert.equal(plan.summary.blocked,2);assert.equal(plan.changes[0].row.txn_date,'2026-10-03');assert.ok(plan.conflicts.some(c=>c.code==='partial-day'));
});
test('preview encryption binds actor, owner, id and integrity; signing matches standard HMAC exact wire',()=>{
 const key=Buffer.alloc(32,17),id='preview-id',cipher=sealClobePreview({synthetic:'private'},id,'actor','owner',key);
 assert.deepEqual(openClobePreview(cipher,id,'actor','owner',key),{synthetic:'private'});
 for(const [badId,actor,owner] of [['other-id','actor','owner'],[id,'other','owner'],[id,'actor','other']])assert.throws(()=>openClobePreview(cipher,badId,actor,owner,key));
 const wire='{"value": 1, "test":true}';assert.equal(signClobeImport('apply',wire,'actor','owner',key),createHmac('sha256',key).update('merlin:clobe-import:v1\napply\nactor\nowner\n'+wire).digest('hex'));
 assert.notEqual(signClobeImport('apply',wire,'actor','owner',key),signClobeImport('apply',JSON.stringify(JSON.parse(wire)),'actor','owner',key));
});
test('preview stores only server snapshot; existing saved category shown; apply replay does not touch data or provider',async()=>{
 const data=dataset();data.transactions=[saved()];let stored:Record<string,unknown>|undefined,applied=0,fetches=0;
 const deps:ClobeImportDependencies={userId:account,ownerId:business,getDataset:async()=>data,getRefs:async()=>[],fetchSource:async()=>{fetches++;return [row(),row({external_transaction_id:'12',amount:200,balance:700})];},seal:value=>JSON.stringify(value),open:value=>JSON.parse(value),rpc:async(action,payload)=>{
  if(action==='store'){stored={...payload,expires_at:payload.expires_at,request_hash:null,result:null};return {};}
  if(action==='read')return stored;
  if(action==='apply'){applied++;const result={run_id:payload.id,inserted:1,referenced:1,unchanged:0,blocked:0,sourceDuplicates:0,updated:0,removed:0};stored={...stored,request_hash:payload.request_hash,result};return result;}
  throw Error('unexpected');
 }};
 const preview=await previewClobeImport({action:'preview',start_date:scope.start_date,end_date:scope.end_date,mappings:scope.mappings},deps);
 assert.equal(preview.rows.find(r=>r.kind==='reference')?.category_id,salary);assert.ok(!Object.hasOwn(preview,'ciphertext'));
 const choice={action:'apply' as const,previewId:preview.previewId,choices:preview.rows.filter(r=>r.kind==='insert').map(r=>({key:r.key,category_id:salary}))};
 await applyClobeImport(choice,deps);assert.equal((await applyClobeImport(choice,deps)).replayed,true);assert.equal(applied,1);assert.equal(fetches,1);
 await assert.rejects(()=>applyClobeImport({...choice,choices:choice.choices.map(c=>({...c,category_id:fee}))},deps),/변경되었습니다/);
});
test('a concurrent existing row forces preview review and prevents its category overwrite',async()=>{
 const data=dataset();let snapshot:Record<string,unknown>|undefined,applies=0;
 const deps:ClobeImportDependencies={userId:account,ownerId:business,getDataset:async()=>data,getRefs:async()=>[],fetchSource:async()=>[row()],seal:value=>JSON.stringify(value),open:value=>JSON.parse(value),rpc:async(action,payload)=>{if(action==='store'){snapshot=payload;return {};}if(action==='read')return snapshot;if(action==='apply')applies++;return null;}};
 const preview=await previewClobeImport({action:'preview',start_date:scope.start_date,end_date:scope.end_date,mappings:scope.mappings},deps);
 data.transactions=[saved()];await assert.rejects(()=>applyClobeImport({action:'apply',previewId:preview.previewId,choices:[{key:preview.rows[0].key,category_id:fee}]},deps),/변경되었습니다/);assert.equal(applies,0);
});
function sourceSession(mode:'pages'|'loop'|'failure'|'foreign'):ClobeReadSession{
 const transaction=(id:number)=>({transactionId:id,accountId:1,transactionAt:'2026-10-02T12:34:56',transactionName:'Synthetic recipient',transactionDescription:'Bank detail',inAmount:0,outAmount:100,afterBalance:900,businessEntityName:null,category:'급여',memo:'Original memo'});
 return {close:async()=>{},call:async(tool,input)=>{
  if(tool==='get_my_context')return {companies:[{companyId:'synthetic-company',companyName:'Synthetic business',role:'MASTER'}]};
  if(tool==='get_bank_accounts')return {accounts:[{bankAccountId:1,accountName:'Synthetic bank',displayAccountNumber:'1234',currencyCode:mode==='foreign'?'USD':'KRW',isHidden:false,balance:900}]};
  if(tool==='get_scraping_status')return {overallStatus:'SUCCESS',assets:[{category:'BANK',label:'Bank',status:'SUCCESS',scrapedAt:'2026-10-07T12:00:00'}]};
  if(mode==='failure'&&input?.cursor)throw Error('Synthetic transport failure');
  return {content:[transaction(input?.cursor?12:11)],hasNext:mode==='loop'||!input?.cursor,nextCursor:mode==='loop'||!input?.cursor?'next':null,totalElements:2};
 }};
}
test('all source pages complete first; original fields kept and provider label remains display-only',async()=>{
 const rows=await fetchClobeImportRows(sourceSession('pages'),scope);assert.equal(rows.length,2);assert.equal(rows[0].raw_gwamok,'');assert.equal(rows[0].source_details?.basic,'Synthetic recipient');assert.equal(rows[0].source_details?.detail,'Bank detail');assert.equal(rows[0].source_details?.memo,'Original memo');assert.match(rows[0].source_details?.note||'',/표시용/);assert.equal(rows[0].source_details?.counterparty,undefined);
});
test('foreign currency, failed partial download, cursor loop and financial input injection are rejected',async()=>{
 await assert.rejects(()=>fetchClobeImportRows(sourceSession('foreign'),scope),/외화/);
 await assert.rejects(()=>fetchClobeImportRows(sourceSession('failure'),scope));
 await assert.rejects(()=>fetchClobeImportRows(sourceSession('loop'),scope));
 assert.throws(()=>parseClobeImportInput({action:'apply',previewId:account,choices:[],amount:100}));
 assert.throws(()=>parseClobeImportInput({action:'preview',start_date:'2026-10-07',end_date:'2026-10-01',mappings:scope.mappings}));
});
test('premature end and changing total counts cannot produce a complete import snapshot',async()=>{
 for(const mode of ['early','changed'] as const){
  const source=sourceSession('pages'),wrapped:ClobeReadSession={close:source.close,call:async(tool,input)=>{
   const value=await source.call(tool,input);
   if(tool!=='get_labeled_transactions')return value;
   const page=value as {hasNext:boolean;nextCursor:string|null;totalElements:number};
   return mode==='early'?{...page,hasNext:false,nextCursor:null}:{...page,totalElements:input?.cursor?3:2};
  }};
  await assert.rejects(()=>fetchClobeImportRows(wrapped,scope),/모든 통장 거래/);
 }
});
test('applying requires current company/account access, without any source transaction re-download',async()=>{
 const source=sourceSession('pages'),calls:string[]=[];
 const session:ClobeReadSession={close:source.close,call:async(tool,input)=>{calls.push(tool);return source.call(tool,input);}};
 await verifyClobeImportAccess(session,scope);assert.deepEqual(calls,['get_my_context','get_bank_accounts']);
 await assert.rejects(()=>verifyClobeImportAccess(sourceSession('foreign'),scope),/통장 접근 권한/);
 await assert.rejects(()=>verifyClobeImportAccess(sourceSession('pages'),{...scope,mappings:[{...scope.mappings[0],company_id:'not-accessible'}]}),/회사 접근 권한/);
});
