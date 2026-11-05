import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {read,utils,write} from '@e965/xlsx';
import {buildSheetAppendPlan,assertCompleteSheetMappings} from '../lib/finance/sheet-append';
import {executeSheetAppendSync,sheetImportInput,sheetSyncAvailability,type AppendRequest,type AppendResult,type SavedAppendRun} from '../lib/finance/sheet-append-sync';
import {digest} from '../lib/finance/parser';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';
import type {SheetMergeRow} from '../lib/finance/sheet-merge';
import {buildSheetMergePlan} from '../lib/finance/sheet-merge';
import type {SheetImportSource} from '../lib/finance/sheet-import-source';
import {sheetSnapshot} from '../lib/finance/google-sheets';

const account='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',business='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const second='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const url='https://docs.google.com/spreadsheets/d/synthetic_append_only_sheet_123/edit';
const sourceConfig:SheetImportSource={url,mappings:[{sheet:'Synthetic bank',account_id:account,selected:true}]};
function row(patch:Partial<SheetMergeRow>={}):SheetMergeRow{return {account_id:account,sheet:'Synthetic bank',source_row:2,
 txn_date:'2026-09-01',txn_time:'10:00:00',amount:100,direction:'out',description:'Synthetic recipient',raw_gwamok:'수수료',category_id:'fee',is_internal:false,balance:900,tax_invoice:false,dedup_hash:'0'.repeat(64),manually_classified:false,
 source_details:{basic:'Synthetic recipient',provenance:{url,sheet:'Synthetic bank',row:2}},provided:{category:true,balance:true,tax:true,time:true},...patch};}
function dataset(transactions:Transaction[]=[]):Dataset{return {...structuredClone(emptyDataset),accounts:[account,second].map(id=>({id,business_id:business,name:'Synthetic account',bank:'Synthetic bank',masked_number:'123',opening_balance:0,opening_balance_date:null})),transactions};}
async function saved(patch:Partial<Transaction>={}):Promise<Transaction>{const r=row();return {id:randomUUID(),business_id:business,account_id:account,upload_id:randomUUID(),txn_date:r.txn_date,txn_time:r.txn_time,amount:r.amount,direction:r.direction,description:r.description,raw_gwamok:r.raw_gwamok,category_id:r.category_id,is_internal:false,balance:r.balance,tax_invoice:true,manually_classified:true,source_details:r.source_details,dedup_hash:await digest(account,r.txn_date,r.amount,r.direction,r.description,r.balance),...patch};}
function apply(data:Dataset,changes:AppendRequest['p_changes']){
 assert.ok(changes.every(change=>change.kind==='insert'&&change.expected===null&&change.duplicates.length===0));
 data.transactions.push(...changes.map(change=>({...change.row,id:change.id,account_id:change.account_id,business_id:business,upload_id:null})));
}
function workbook(rows:unknown[][]=[['2026-09-01','10:00:00','Synthetic recipient',0,100,900,'']],names=['Synthetic bank']){
 const book=utils.book_new();
 for(const name of names)utils.book_append_sheet(book,utils.aoa_to_sheet([['거래일자','거래시간','거래내용','입금금액(원)','출금금액(원)','거래 후 잔액(원)','계정과목'],...rows]),name);
 return new Uint8Array(write(book,{type:'array',bookType:'xlsx'}) as ArrayBuffer);
}
function withSheets(bytes:Uint8Array,sheets:{name:string;rows:unknown[][]}[]){
 const book=read(bytes,{type:'array'});
 for(const sheet of sheets)utils.book_append_sheet(book,utils.aoa_to_sheet(sheet.rows),sheet.name);
 return new Uint8Array(write(book,{type:'array',bookType:'xlsx'}) as ArrayBuffer);
}
// Every workbook parse opens this byte buffer once. Observe the original
// Uint8Array getter rather than replacing the parser with a test-only fake.
function countWorkbookParses(bytes:Uint8Array){
 const buffer=bytes.buffer;let calls=0;
 Object.defineProperty(bytes,'buffer',{get:()=>{calls++;return buffer;}});
 return {bytes,count:()=>calls};
}
function memory(){
 const data=dataset(),runs=new Map<string,SavedAppendRun>(),requests:AppendRequest[]=[];
 let bytes:Uint8Array=workbook(),fetchCount=0;
 const deps:Parameters<typeof executeSheetAppendSync>[2]={findRun:async(id:string)=>runs.get(id)||null,fetchSource:async()=>{fetchCount++;return {sourceUrl:url,bytes};},getDataset:async()=>structuredClone(data),apply:async(request:AppendRequest)=>{
  requests.push(structuredClone(request));
  assert.ok(request.p_changes.every(change=>change.kind==='insert'&&change.expected===null&&!change.duplicates.length));
  apply(data,request.p_changes);
  const result:AppendResult={run_id:request.p_run,inserted:request.p_changes.length,updated:0,removed:0,...request.p_summary};
  runs.set(request.p_run,{source_url:request.p_source_url,source_hash:request.p_source_hash,result});
  return {data:result,error:null};
 }};
 return {data,runs,requests,deps,setBytes:(value:Uint8Array)=>{bytes=value;},fetchCount:()=>fetchCount};
}

test('append sync preserves every existing field, manual classifications, files and notes despite changed sheet metadata',async()=>{
 const existing=await saved({category_id:'manual',raw_gwamok:'기존분류',source_sheet:'Old bank',source_row:55,source_details:{basic:'Synthetic recipient',memo:'Original memo'}});
 const data=dataset([existing]);data.notes=[{id:'memo',account_id:account,direction:'out',subject_key:'transaction:'+existing.id,label:'Synthetic',memo:'keep',version:3,updated_at:'2026-09-02'}];
 const before=JSON.stringify(data);
 const plan=await buildSheetAppendPlan(data,[row({raw_gwamok:'다른분류',category_id:'changed',tax_invoice:false,source_details:{basic:'Synthetic recipient',memo:'Changed memo',provenance:{url,sheet:'Synthetic bank',row:2}}})],'a');
 assert.deepEqual(plan.summary,{inserted:0,updated:0,removed:0,unchanged:1,sourceDuplicates:0,blocked:0});
 assert.deepEqual(plan.changes,[]);assert.equal(JSON.stringify(data),before);
});

async function bankStored(patch:Partial<Transaction>={}){
 return saved({description:'Synthetic bank channel',source_details:{basic:'Synthetic bank channel',detail:'Synthetic vendor'},...patch});
}
function bankSource(patch:Partial<SheetMergeRow>={}){
 const sheet=patch.sheet??'Synthetic bank',sourceRow=patch.source_row??2;
 return row({description:'Synthetic vendor',txn_time:null,provided:{category:true,balance:true,tax:true,time:false},
  source_details:{basic:'Synthetic vendor',provenance:{url,sheet,row:sourceRow}},...patch});
}

test('unique bank evidence and exact cross-field source text skip a saved payment without changing any protected data',async()=>{
 const existing=await bankStored({category_id:'manual-transfer',is_internal:true,transfer_fee_amount:5,transfer_fee_category_id:'fee',
  source_details:{basic:'Synthetic bank channel',detail:'Synthetic vendor',memo:'Saved transaction memo',note:'Saved original note'}});
 const data=dataset([existing]);
 data.notes=[{id:'memo',account_id:account,direction:'out',subject_key:'transaction:'+existing.id,label:'Synthetic vendor',memo:'Keep merchant memo',version:3,updated_at:'2026-09-02'}];
 data.links=[{id:'link',out_transaction_id:existing.id,in_transaction_id:'synthetic-incoming-id'}];
 const before=JSON.stringify(data);
 const input=bankSource({raw_gwamok:'Changed source category',category_id:'changed',is_internal:false,tax_invoice:false,
  source_details:{basic:'  SYNTHETIC   vendor ',memo:'Different source memo',note:'Different source note',provenance:{url,sheet:'Synthetic bank',row:90}}});
 for(const sourceHash of ['first-snapshot','later-snapshot']){
  const plan=await buildSheetAppendPlan(data,[input],sourceHash);
  assert.deepEqual(plan.summary,{inserted:0,updated:0,removed:0,unchanged:1,sourceDuplicates:0,blocked:0});
  assert.deepEqual(plan.changes,[]);assert.deepEqual(plan.conflicts,[]);assert.equal(JSON.stringify(data),before);
 }
 const ordinary=await buildSheetMergePlan(data,[input],'not-append',{sourceAuthority:true});
 assert.equal(ordinary.summary.unchanged,0);assert.equal(ordinary.summary.blocked,1);
});

test('a full sync retries changed display labels as existing transactions while retaining manually selected categories',async()=>{
 const m=memory(),existing=await bankStored({upload_id:null,category_id:'manual-selection'});
 m.data.transactions.push(existing);m.setBytes(workbook([['2026-09-01','','Synthetic vendor',0,100,900,'New source category']]));
 const before=JSON.stringify(m.data.transactions);
 for(let attempt=0;attempt<2;attempt++){
  const result=await executeSheetAppendSync(sourceConfig,randomUUID(),m.deps);
  assert.equal(result.inserted,0);assert.equal(result.unchanged,1);assert.equal(result.blocked,0);
 }
 assert.equal(m.requests.length,2);assert.ok(m.requests.every(request=>request.p_changes.length===0));
 assert.equal(JSON.stringify(m.data.transactions),before);
});

test('distinct balances disambiguate same-day same-amount payments and exact source copies do not create extra claimants',async()=>{
 const first=await bankStored(),second=await bankStored({balance:800});
 const data=dataset([first,second]),before=JSON.stringify(data);
 const source=bankSource(),other=bankSource({balance:800,source_row:3});
 const plan=await buildSheetAppendPlan(data,[source,{...source,source_row:4},other],'snapshot');
 assert.equal(plan.summary.unchanged,2);assert.equal(plan.summary.sourceDuplicates,1);assert.equal(plan.summary.blocked,0);
 assert.deepEqual(plan.changes,[]);assert.equal(JSON.stringify(data),before);
});

test('matching money never replaces missing bank evidence, conflicting explicit time or an unrelated counterparty',async()=>{
 const cases:[Partial<Transaction>,Partial<SheetMergeRow>][]=[
  [{balance:null},{}],[{},{balance:null}],
  [{},{txn_time:'11:00:00',provided:{category:true,balance:true,tax:true,time:true}}],
  [{},{description:'Another synthetic vendor',source_details:{basic:'Another synthetic vendor'}}],
  [{source_details:{basic:'Shared merchant',counterparty:'Synthetic recipient A'}},
   {source_details:{basic:'Shared merchant',counterparty:'Synthetic recipient B'}}],
  [{source_details:{basic:'Synthetic vendor',counterparty:'Synthetic recipient A'}},
   {description:'Synthetic bank channel',txn_time:'10:00:00',source_details:{basic:'Synthetic vendor',counterparty:'Synthetic recipient B'}}],
 ];
 for(const [previousPatch,sourcePatch] of cases){
  const data=dataset([await bankStored(previousPatch)]),before=JSON.stringify(data);
  const plan=await buildSheetAppendPlan(data,[bankSource(sourcePatch)],'snapshot');
  assert.equal(plan.summary.inserted,0);assert.equal(plan.summary.blocked,1);assert.deepEqual(plan.changes,[]);assert.equal(JSON.stringify(data),before);
 }
});

test('shared memos, substring labels and exact generic channel tokens cannot prove a cross-description duplicate',async()=>{
 for(const common of ['입금','출금','인터넷','모바일','기업뱅킹','인터넷 뱅킹','타행이체','급여',
  '123456789','123-456-789','### 123 ###','인터넷 12345','모바일-9876','타행 이체 20260901','기업뱅킹:10001','인터넷 123A','A-12345','모바일 123B']){
  const data=dataset([await bankStored({source_details:{detail:common}})]);
  const plan=await buildSheetAppendPlan(data,[bankSource({description:'Another synthetic recipient',source_details:{basic:common}})],'snapshot');
  assert.equal(plan.summary.blocked,1);assert.deepEqual(plan.changes,[]);
 }
 for(const sourceDetails of [{memo:'Synthetic vendor',note:'Synthetic vendor'},{basic:'Synthetic vendor subsidiary'}]){
  const data=dataset([await bankStored()]),plan=await buildSheetAppendPlan(data,[bankSource({description:'Another synthetic recipient',source_details:sourceDetails})],'snapshot');
  assert.equal(plan.summary.blocked,1);assert.deepEqual(plan.changes,[]);
 }
 const institution='Synthetic Card 1234',institutionData=dataset([await bankStored({source_details:{detail:institution}})]);
 const institutionPlan=await buildSheetAppendPlan(institutionData,[bankSource({description:institution,source_details:{basic:institution}})],'snapshot');
 assert.equal(institutionPlan.summary.unchanged,1);assert.equal(institutionPlan.summary.blocked,0);assert.deepEqual(institutionPlan.changes,[]);
});

test('all saved and source claimants count even if another row already matched or lacks a balance',async()=>{
 const existing=await bankStored();
 for(const competing of [await bankStored({description:'Another saved channel'}),await bankStored({description:'Another saved channel',balance:null})]){
  const data=dataset([existing,competing]),before=JSON.stringify(data),plan=await buildSheetAppendPlan(data,[bankSource()],'snapshot');
  assert.equal(plan.summary.blocked,1);assert.deepEqual(plan.changes,[]);assert.equal(JSON.stringify(data),before);
 }
 for(const competing of [row(),row({balance:null})]){
  const data=dataset([existing]);
  // The ordinary core match is visited first. Consuming it must not make the
  // second source occurrence look like a unique cross-field bank match.
  const known={...competing,description:existing.description,source_details:{basic:existing.description}};
  const plan=await buildSheetAppendPlan(data,[known,bankSource({source_row:3})],'snapshot');
  assert.equal(plan.summary.unchanged,1);assert.equal(plan.summary.blocked,1);assert.equal(plan.summary.inserted,0);assert.deepEqual(plan.changes,[]);
 }
});

test('cross-field bank matching cannot bypass a recorded source correction or replace origin-aware reconciliation',async()=>{
 const input=bankSource(),knownOrigin={url,sheet:'Synthetic bank',row:2};
 const recorded=await bankStored({source_details:{basic:'Different original basic',detail:'Synthetic vendor',provenance:knownOrigin}});
 const original=await bankStored({amount:50,balance:950,description:'Original source record',
  source_details:{basic:'Synthetic vendor',provenance:knownOrigin}});
 for(const transactions of [[recorded],[original,await bankStored()]]){
  const data=dataset(transactions),before=JSON.stringify(data),plan=await buildSheetAppendPlan(data,[input],'snapshot');
  assert.equal(plan.summary.inserted,0);assert.equal(plan.summary.blocked,1);assert.deepEqual(plan.changes,[]);assert.equal(JSON.stringify(data),before);
 }
});

test('a moved sheet row is recognized only when its former payment is independently represented elsewhere',async()=>{
 const original=await bankStored({amount:50,balance:950,description:'Original source record',
  source_details:{basic:'Synthetic vendor',provenance:{url,sheet:'Synthetic bank',row:2}}});
 const legacy=await bankStored(),data=dataset([original,legacy]),before=JSON.stringify(data);
 const moved=bankSource({amount:50,balance:950,description:original.description,source_row:3});
 const plan=await buildSheetAppendPlan(data,[bankSource(),moved],'reordered-snapshot');
 assert.equal(plan.summary.unchanged,2);assert.equal(plan.summary.blocked,0);assert.deepEqual(plan.changes,[]);assert.equal(JSON.stringify(data),before);
 for(const unproven of [bankSource({amount:50,balance:null,source_row:3}),bankSource({amount:50,balance:950,source_row:3,source_details:{basic:'Different explicit vendor'}})]){
  const held=await buildSheetAppendPlan(data,[bankSource(),unproven],'uncertain-reorder');
  assert.equal(held.summary.inserted,0);assert.ok(held.summary.blocked>0);assert.equal(JSON.stringify(data),before);
 }
});

test('genuinely new account, date, direction, amount and balance remain independent of an existing bank match',async()=>{
 const existing=await bankStored(),data=dataset([existing]);
 const inputs=[bankSource(),bankSource({account_id:second,source_row:3}),bankSource({txn_date:'2026-09-02',source_row:4}),
  bankSource({direction:'in',source_row:5}),bankSource({amount:200,source_row:6}),bankSource({balance:800,source_row:7})];
 const plan=await buildSheetAppendPlan(data,inputs,'snapshot');
 assert.equal(plan.summary.unchanged,1);assert.equal(plan.summary.inserted,5);assert.equal(plan.summary.blocked,0);
 apply(data,plan.changes);const before=JSON.stringify(data),replay=await buildSheetAppendPlan(data,inputs,'later-snapshot');
 assert.equal(replay.summary.inserted,0);assert.equal(replay.summary.unchanged,6);assert.equal(replay.summary.blocked,0);assert.equal(JSON.stringify(data),before);
});

test('existing duplicates stay intact while unrelated new historical rows are appended',async()=>{
 const existing=await saved(),duplicate=await saved({dedup_hash:'f'.repeat(64)}),data=dataset([existing,duplicate]);
 const before=JSON.stringify(data.transactions);
 const plan=await buildSheetAppendPlan(data,[row(),row({txn_date:'2024-01-05',amount:555,balance:1000,source_row:3,description:'Historical recipient',source_details:{basic:'Historical recipient'}})],'a');
 assert.equal(plan.summary.inserted,1);assert.equal(plan.summary.updated,0);assert.equal(plan.summary.removed,0);
 apply(data,plan.changes);assert.equal(JSON.stringify(data.transactions.slice(0,2)),before);
 assert.equal(data.transactions[2].txn_date,'2024-01-05');
});

test('same-day distinct times and balances are retained, exact source copies skipped, repeating full history is a no-op',async()=>{
 const inputs=[row(),row({source_row:3}),row({source_row:4,txn_time:'11:00:00',source_details:{basic:'Synthetic recipient'}}),row({source_row:5,balance:800,source_details:{basic:'Synthetic recipient'}})];
 const data=dataset(),plan=await buildSheetAppendPlan(data,inputs,'a');
 assert.equal(plan.summary.inserted,3);assert.equal(plan.summary.sourceDuplicates,1);assert.equal(plan.summary.blocked,0);
 assert.equal(new Set(plan.changes.map(change=>change.row.dedup_hash)).size,3);apply(data,plan.changes);
 const before=JSON.stringify(data),retry=await buildSheetAppendPlan(data,inputs,'updated-whole-workbook');
 assert.equal(retry.summary.inserted,0);assert.equal(retry.summary.unchanged,3);assert.deepEqual(retry.changes,[]);assert.equal(JSON.stringify(data),before);
 const changedSnapshot=await buildSheetAppendPlan(dataset(),inputs,'b');
 assert.deepEqual(changedSnapshot.changes.map(change=>change.id),plan.changes.map(change=>change.id));
});

test('ambiguous matches and corrected source money/date never silently become additional payments',async()=>{
 const old=await saved();
 for(const changed of [row({amount:101}),row({direction:'in'}),row({txn_date:'2026-09-02'}),row({description:'Changed recipient',source_details:{basic:'Another description'}})]){
  const data=dataset([old]),before=JSON.stringify(data),plan=await buildSheetAppendPlan(data,[changed],'a');
  assert.equal(plan.summary.inserted,0);assert.equal(plan.summary.blocked,1);assert.deepEqual(plan.changes,[]);assert.equal(JSON.stringify(data),before);
 }
 for(const [savedBalance,sourceBalance] of [[900,900],[null,null],[900,null],[null,900]]){
  const noTime=await saved({txn_time:null,balance:savedBalance});
  const correction=await buildSheetAppendPlan(dataset([noTime]),[row({txn_date:'2026-09-02',txn_time:null,balance:sourceBalance})],'a');
  assert.equal(correction.summary.blocked,1);assert.deepEqual(correction.changes,[]);
 }
 for(const evidence of [{balance:800,txn_time:null},{balance:null,txn_time:'11:00:00'}]){
  const distinct=await buildSheetAppendPlan(dataset([old]),[row({txn_date:'2026-09-02',...evidence})],'a');
  assert.equal(distinct.summary.blocked,0);assert.equal(distinct.summary.inserted,1);
 }
});

test('sync rejects browser source/mapping overrides and requires every configured account and bank sheet',()=>{
 assert.deepEqual(sheetImportInput.parse({action:'sync',runId:account}),{action:'sync',runId:account});
 for(const extra of [{url},{mappings:sourceConfig.mappings},{allowPartial:true}])assert.equal(sheetImportInput.safeParse({action:'sync',runId:account,...extra}).success,false);
 assertCompleteSheetMappings(workbook(),sourceConfig.mappings);
 assert.throws(()=>assertCompleteSheetMappings(workbook(undefined,['Synthetic bank','New bank']),sourceConfig.mappings),/모든 통장/);
 assert.throws(()=>assertCompleteSheetMappings(workbook(),[...sourceConfig.mappings,{sheet:'Missing bank',account_id:second,selected:true}]),/모든 통장/);
 assert.throws(()=>assertCompleteSheetMappings(workbook(),[{...sourceConfig.mappings[0],selected:false}]),/모든 통장/);
 assert.equal(sheetSyncAvailability(null).syncAvailable,false);
 assert.equal(sheetSyncAvailability(sourceConfig,new Set([second])).syncAvailable,false);
});

test('one click loads all configured banks, and later clicks add only genuinely new rows',async()=>{
 const m=memory(),config={url,mappings:[...sourceConfig.mappings,{sheet:'Other bank',account_id:second,selected:true}]};
 const inspected=countWorkbookParses(workbook(undefined,['Synthetic bank','Other bank']));m.setBytes(inspected.bytes);
 const first=await executeSheetAppendSync(config,randomUUID(),m.deps);assert.equal(first.inserted,2);assert.equal(first.updated,0);assert.equal(first.removed,0);
 assert.equal(inspected.count(),1);
 m.data.transactions[0].category_id='manually-edited';m.data.transactions[0].manually_classified=true;
 const before=JSON.stringify(m.data.transactions);
 m.setBytes(workbook([['2026-09-01','10:00:00','Synthetic recipient',0,100,900,'새 과목'],['2025-12-01','10:00:00','Historical new payment',0,300,1000,'']],['Synthetic bank','Other bank']));
 const next=await executeSheetAppendSync(config,randomUUID(),m.deps);assert.equal(next.inserted,2);assert.equal(next.unchanged,2);
 assert.equal(JSON.stringify(m.data.transactions.slice(0,2)),before);
 const repeated=await executeSheetAppendSync(config,randomUUID(),m.deps);assert.equal(repeated.inserted,0);assert.equal(repeated.unchanged,4);
});

test('business transfer reports do not become extra bank mappings or duplicate the six bank ledgers',async()=>{
 const m=memory(),names=Array.from({length:6},(_,index)=>`Synthetic bank ${index+1}`),ids=names.map(()=>randomUUID());
 m.data.accounts=ids.map(id=>({...m.data.accounts[0],id}));
 const config={url,mappings:names.map((sheet,index)=>({sheet,account_id:ids[index],selected:true}))};
 const summary:unknown[][]=[['Synthetic transfer summary'],['사업자 A','사업자 B','A → B 대여·상환','B → A 대여·상환','A 기준 순증감','순증감 방향','근거·메모'],['Synthetic A','Synthetic B',100,0,100,'Synthetic direction',''],[],['거래일','보낸 사업자','받은 사업자','대여금','원본 과목','분석 분류','원본 근거']];
 for(let day=1;day<=4;day++)summary.push([`2026-09-0${day}`,'Synthetic A','Synthetic B',100,'출금','대여금','Synthetic bank']);
 const records:unknown[][]=[['기록ID','일자','보낸 사업자','받은 사업자','금액','구분','상태','버전','메모'],['synthetic-record','2026-09-01','Synthetic A','Synthetic B',100,'대여','기록',1,'Synthetic memo']];
 const bytes=withSheets(workbook(undefined,names),[{name:'Synthetic summary',rows:summary},{name:'Synthetic records',rows:records}]);
 assert.deepEqual(sheetSnapshot(bytes).map(sheet=>sheet.name),names);
 assertCompleteSheetMappings(bytes,config.mappings);
 m.setBytes(bytes);
 const first=await executeSheetAppendSync(config,randomUUID(),m.deps);
 assert.equal(first.inserted,6);assert.equal(first.blocked,0);assert.equal(m.data.transactions.length,6);
 const repeated=await executeSheetAppendSync(config,randomUUID(),m.deps);
 assert.equal(repeated.inserted,0);assert.equal(repeated.unchanged,6);assert.equal(repeated.blocked,0);
 assert.equal(m.data.transactions.length,6);
});

test('empty and invalid bank sheets still require mappings and invalid rows remain held',async()=>{
 const header=['거래일자','입금액','출금액','적요'];
 for(const rows of [[header],[header,['invalid date',0,100,'Synthetic recipient']]]){
  const bytes=withSheets(workbook(),[{name:'Synthetic extra bank',rows}]);
  assert.throws(()=>assertCompleteSheetMappings(bytes,sourceConfig.mappings),/모든 통장/);
  assert.throws(()=>assertCompleteSheetMappings(bytes,[...sourceConfig.mappings,{sheet:'Synthetic extra bank',account_id:null,selected:true}]),/모든 통장/);
 }
 const m=memory(),bytes=withSheets(workbook(),[{name:'Synthetic invalid bank',rows:[header,['invalid date',0,100,'Synthetic recipient']]}]);
 const config={url,mappings:[...sourceConfig.mappings,{sheet:'Synthetic invalid bank',account_id:second,selected:true}]};
 m.setBytes(bytes);
 const result=await executeSheetAppendSync(config,randomUUID(),m.deps);
 assert.equal(result.inserted,1);assert.equal(result.blocked,1);
 assert.ok('conflicts' in result&&result.conflicts.some(row=>row.sheet==='Synthetic invalid bank'));
});

test('bank evidence keeps transfer-like headers and a valid amount/direction bank in the mapping scope',async()=>{
 const reportHeader=['기록ID','일자','보낸 사업자','받은 사업자','금액','구분','상태','버전','메모'];
 const examples=[
  [reportHeader,['synthetic-record','2026-09-01','Synthetic A','Synthetic B',100,'출금','기록',1,'Synthetic recipient']],
  [['거래일','보낸 사업자','받은 사업자','대여금','입금액','출금액','잔액'],['2026-09-01','Synthetic A','Synthetic B',100,0,100,900]],
  [['거래일','보낸 사업자','받은 사업자','대여금','거래금액','',''],['','','','','입금','출금',''],['2026-09-01','Synthetic A','Synthetic B',100,0,100,'']],
 ];
 for(const rows of examples){
  const bytes=withSheets(workbook(),[{name:'Synthetic transfer bank',rows}]);
  assert.deepEqual(sheetSnapshot(bytes).map(sheet=>sheet.name),['Synthetic bank','Synthetic transfer bank']);
  assert.throws(()=>assertCompleteSheetMappings(bytes,sourceConfig.mappings),/모든 통장/);
  assertCompleteSheetMappings(bytes,[...sourceConfig.mappings,{sheet:'Synthetic transfer bank',account_id:second,selected:true}]);
 }
});

test('same click retry returns its committed result even if later sheet content changes; empty runs are journaled',async()=>{
 const m=memory(),id=randomUUID();
 const first=await executeSheetAppendSync(sourceConfig,id,m.deps);
 m.setBytes(workbook([['2026-10-01','10:00:00','Another new payment',0,300,1000,'']]));
 const replay=await executeSheetAppendSync(sourceConfig,id,m.deps);
 assert.equal(replay.run_id,id);assert.equal(replay.inserted,first.inserted);assert.equal(m.fetchCount(),1);assert.equal(m.data.transactions.length,1);
 m.setBytes(workbook());
 const noOpId=randomUUID(),noOp=await executeSheetAppendSync(sourceConfig,noOpId,m.deps);assert.equal(noOp.inserted,0);assert.ok(m.runs.has(noOpId));
 m.setBytes(workbook([['2026-10-01','10:00:00','Another new payment',0,300,1000,'']]));
 assert.equal((await executeSheetAppendSync(sourceConfig,noOpId,m.deps)).inserted,0);
});

test('a concurrent successful run is re-read after stale insert, without an update or duplicate deletion',async()=>{
 for(const error of [{code:'P0001',message:'SHEET_STALE'},{code:'23505',message:'duplicate key'}]){
 const m=memory(),original=m.deps.apply;let race=true;
 const inspected=countWorkbookParses(workbook());m.setBytes(inspected.bytes);
 m.deps.apply=async request=>{
  if(race){race=false;await original({...request,p_run:randomUUID()});return {data:null,error};}
  return original(request);
 };
 const result=await executeSheetAppendSync(sourceConfig,randomUUID(),m.deps);
 assert.equal(inspected.count(),1);
 assert.equal(result.inserted,0);assert.equal(result.unchanged,1);assert.equal(m.data.transactions.length,1);
 assert.ok(m.requests.every(request=>request.p_changes.every(change=>change.kind==='insert'&&change.duplicates.length===0)));
 }
});

test('an uncertain RPC response is recoverable using the same run ID without fetching or inserting again',async()=>{
 const m=memory(),original=m.deps.apply,id=randomUUID();
 m.deps.apply=async request=>{await original(request);throw Error('synthetic connection dropped');};
 await assert.rejects(executeSheetAppendSync(sourceConfig,id,m.deps),/connection dropped/);
 const result=await executeSheetAppendSync(sourceConfig,id,m.deps);
 assert.equal(result.inserted,1);assert.equal(m.fetchCount(),1);assert.equal(m.data.transactions.length,1);
});

test('invalid bank rows are reported as held while valid new transactions save, and unknown tabs stop all writes',async()=>{
 const m=memory();m.setBytes(workbook([['2026-09-01','10:00:00','Valid payment',0,100,900,''],['2026-13-45','10:00:00','Invalid date',0,100,800,'']]));
 const result=await executeSheetAppendSync(sourceConfig,randomUUID(),m.deps);assert.equal(result.inserted,1);assert.equal(result.blocked,1);
 assert.ok('conflicts' in result&&result.conflicts.length===1);
 const count=m.requests.length;m.setBytes(workbook(undefined,['Synthetic bank','Unexpected bank']));
 await assert.rejects(executeSheetAppendSync(sourceConfig,randomUUID(),m.deps),/모든 통장/);assert.equal(m.requests.length,count);
});
