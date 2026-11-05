import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSheetMergePlan,type SheetMergeRow} from '../lib/finance/sheet-merge';
import {digest} from '../lib/finance/parser';
import {noteKey,noteSubject} from '../lib/finance/merchant-notes';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

// Synthetic bank and categorized-sheet descriptions; no real financial rows.
const account='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondAccount='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const business='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const transactionId='11111111-1111-4111-8111-111111111111';
function source(patch:Partial<SheetMergeRow>={}):SheetMergeRow{
 return {account_id:account,sheet:'Synthetic bank',source_row:2,txn_date:'2026-09-01',txn_time:'10:00:00',
  amount:100,direction:'out',description:'Categorized sheet salary',raw_gwamok:'급여',category_id:'salary',
  is_internal:false,balance:900,tax_invoice:false,dedup_hash:'0'.repeat(64),manually_classified:false,
  source_details:{basic:'Original synthetic recipient'},provided:{category:true,balance:true,tax:false,time:true},...patch};
}
async function previous(patch:Partial<Transaction>={}):Promise<Transaction>{
 const row:Transaction={id:transactionId,account_id:account,business_id:business,upload_id:null,
  txn_date:'2026-09-01',txn_time:'10:00:00',amount:100,direction:'out',description:'Bank original salary',
  raw_gwamok:'미매핑',category_id:'unmapped',is_internal:false,balance:900,tax_invoice:false,
  dedup_hash:'',manually_classified:false,source_details:{basic:'Preserved bank original'},...patch};
 row.dedup_hash=await digest(row.account_id,row.txn_date,row.amount,row.direction,row.description,row.balance);
 return row;
}
function data(transactions:Transaction[],patch:Partial<Dataset>={}):Dataset{
 return {...emptyDataset,accounts:[account,secondAccount].map(id=>({id,business_id:business,name:'Synthetic account',bank:'Synthetic bank',masked_number:'123',opening_balance:0,opening_balance_date:null})),transactions,...patch};
}

test('different descriptions with identical bank evidence are held without inserting or altering existing payment',async()=>{
 const stored=await previous(),dataset=data([stored]),before=JSON.stringify(dataset);
 const plan=await buildSheetMergePlan(dataset,[source()],'synthetic-source');
 assert.deepEqual(plan.summary,{inserted:0,updated:0,removed:0,unchanged:0,sourceDuplicates:0,blocked:1});
 assert.equal(plan.changes.length,0);assert.equal(plan.conflicts[0].sheet,'Synthetic bank');assert.equal(plan.conflicts[0].row,2);
 assert.match(plan.conflicts[0].message,/거래내용이 달라/);assert.equal(JSON.stringify(dataset),before);
});

test('missing balance or time on either side cannot prove a differently described payment is new',async()=>{
 for(const [oldEvidence,newEvidence] of [
  [{balance:null,txn_time:null},{balance:900,txn_time:'10:00:00'}],
  [{balance:900,txn_time:'10:00:00'},{balance:null,txn_time:null}],
  [{balance:900,txn_time:null},{balance:900,txn_time:'10:00:00'}],
  [{balance:null,txn_time:'10:00:00'},{balance:900,txn_time:null}],
  [{balance:0,txn_time:null},{balance:0,txn_time:null}],
 ]){
  const plan=await buildSheetMergePlan(data([await previous(oldEvidence)]),[source(newEvidence)],'synthetic-source');
  assert.equal(plan.summary.blocked,1);assert.equal(plan.changes.length,0);
 }
});

test('explicitly different bank balance or time permits a distinct payment despite same monetary key',async()=>{
 for(const [oldEvidence,newEvidence] of [
  [{balance:900,txn_time:'10:00:00'},{balance:800,txn_time:'10:00:00'}],
  [{balance:900,txn_time:'10:00:00'},{balance:900,txn_time:'11:00:00'}],
  [{balance:900,txn_time:null},{balance:0,txn_time:null}],
  [{balance:null,txn_time:'10:00:00'},{balance:null,txn_time:'11:00:00'}],
 ]){
  const plan=await buildSheetMergePlan(data([await previous(oldEvidence)]),[source(newEvidence)],'synthetic-source');
  assert.equal(plan.summary.inserted,1);assert.equal(plan.summary.blocked,0);assert.equal(plan.changes[0].kind,'insert');
 }
});

test('any compatible existing bank evidence holds a new description even when another candidate is distinct',async()=>{
 const distinct=await previous({id:'22222222-2222-4222-8222-222222222222',balance:500,txn_time:'11:00:00'});
 const possible=await previous({description:'Another bank label',balance:null,txn_time:'10:00:00'});
 const plan=await buildSheetMergePlan(data([distinct,possible]),[source()],'synthetic-source');
 assert.equal(plan.summary.blocked,1);assert.equal(plan.changes.length,0);
});

test('different accounts, dates, amounts and directions are independent monetary keys',async()=>{
 const rows=[source({account_id:secondAccount}),source({txn_date:'2026-09-02',source_row:3}),
  source({amount:200,source_row:4}),source({direction:'in',source_row:5})];
 const plan=await buildSheetMergePlan(data([await previous()]),rows,'synthetic-source');
 assert.equal(plan.summary.inserted,4);assert.equal(plan.summary.blocked,0);
});

test('a matched description still updates its existing ID and keeps transaction memo even with another bank label',async()=>{
 const stored=await previous({description:'Categorized sheet salary'});
 const other=await previous({id:'22222222-2222-4222-8222-222222222222'});
 const dataset=data([stored,other],{notes:[{id:'note',account_id:account,direction:'out',subject_key:'transaction:'+stored.id,
  label:'Synthetic salary',memo:'Preserve the existing note',version:1,updated_at:'2026-09-01'}]});
 const before=JSON.stringify(dataset);
 const plan=await buildSheetMergePlan(dataset,[source()],'synthetic-source');
 assert.equal(plan.summary.updated,1);assert.equal(plan.summary.blocked,0);assert.equal(plan.summary.removed,0);
 assert.equal(plan.changes[0].id,stored.id);assert.equal(plan.changes[0].row.description,stored.description);
 assert.equal(plan.changes[0].row.category_id,'salary');assert.deepEqual(plan.changes[0].expected,stored);
 assert.equal(JSON.stringify(dataset),before);
});

test('held rows do not prevent independent valid rows and keep deterministic preview hashes',async()=>{
 const stored=await previous(),held=source(),valid=source({txn_date:'2026-09-02',source_row:3});
 const plan=await buildSheetMergePlan(data([stored]),[held,valid],'synthetic-source');
 assert.equal(plan.summary.blocked,1);assert.equal(plan.summary.inserted,1);assert.equal(plan.changes[0].row.source_row,3);
 const replay=await buildSheetMergePlan(data([stored]),[valid,held],'synthetic-source');
 assert.equal(replay.planHash,plan.planHash);assert.deepEqual(replay.changes,plan.changes);assert.deepEqual(replay.conflicts,plan.conflicts);
 const after:Transaction={...plan.changes[0].row,id:plan.changes[0].id,account_id:account,business_id:business,upload_id:null};
 const second=await buildSheetMergePlan(data([stored,after]),[held,valid],'synthetic-source');
 assert.equal(second.summary.blocked,1);assert.equal(second.summary.unchanged,1);assert.equal(second.changes.length,0);
});

const recordedDetails=()=>({basic:'Synthetic bank basic',detail:'Synthetic bank detail',
 provenance:{url:'https://docs.google.com/spreadsheets/d/synthetic-source/edit',sheet:'Synthetic bank',row:2}});
function recordedSource(patch:Partial<SheetMergeRow>={}){
 return source({txn_time:null,source_details:recordedDetails(),provided:{category:true,balance:true,tax:false,time:false},...patch});
}
async function recordedPrevious(patch:Partial<Transaction>={}){
 return previous({txn_time:null,source_details:recordedDetails(),...patch});
}

test('a unique saved source reconnects a changed display description without changing ID, memo identity or dedup hash',async()=>{
 const stored=await recordedPrevious({source_details:{...recordedDetails(),note:'Keep the saved note'}}),incoming=recordedSource();
 const subject=noteSubject(stored),dataset=data([stored],{notes:[{...subject,id:'subject-note',memo:'Keep the merchant memo',version:1,updated_at:'2026-09-01'}]});
 const before=JSON.stringify(dataset),inputBefore=JSON.stringify(incoming);
 const plan=await buildSheetMergePlan(dataset,[incoming],'synthetic-source');
 assert.deepEqual(plan.summary,{inserted:0,updated:1,removed:0,unchanged:0,sourceDuplicates:0,blocked:0});
 const change=plan.changes[0],next:Transaction={...change.row,id:change.id,account_id:account,business_id:business,upload_id:null};
 assert.equal(change.id,stored.id);assert.equal(change.kind,'update');assert.deepEqual(change.expected,stored);assert.deepEqual(change.duplicates,[]);
 assert.equal(next.description,stored.description);assert.equal(next.dedup_hash,stored.dedup_hash);
 assert.equal(next.category_id,'salary');assert.equal(next.raw_gwamok,'급여');assert.equal(next.source_details?.note,'Keep the saved note');
 assert.equal(noteKey(noteSubject(next)),noteKey(subject));assert.equal(JSON.stringify(dataset),before);assert.equal(JSON.stringify(incoming),inputBefore);
 const replay=await buildSheetMergePlan({...dataset,transactions:[next]},[incoming],'synthetic-source');
 assert.equal(replay.summary.unchanged,1);assert.equal(replay.changes.length,0);assert.equal(replay.summary.blocked,0);
});

test('a proven reconnection stays unchanged after a distinct payment is inserted under the sheet description',async()=>{
 const stored=await recordedPrevious(),original=recordedSource();
 const distinct=recordedSource({source_row:3,balance:800,source_details:{...recordedDetails(),provenance:{...recordedDetails().provenance,row:3}}});
 const dataset=data([stored]),inputs=[original,distinct];
 const first=await buildSheetMergePlan(dataset,inputs,'synthetic-source');
 assert.equal(first.summary.updated,1);assert.equal(first.summary.inserted,1);assert.equal(first.summary.blocked,0);
 const after=data(first.changes.map(change=>({...change.row,id:change.id,account_id:change.account_id,business_id:business,upload_id:null})));
 const kept=after.transactions.find(row=>row.id===stored.id)!;
 for(const field of ['id','txn_date','amount','direction','balance','description','dedup_hash'] as const)assert.equal(kept[field],stored[field]);
 for(const rows of [inputs,[...inputs].reverse()]){
  const replay=await buildSheetMergePlan(after,rows,'synthetic-source');
  assert.deepEqual(replay.summary,{inserted:0,updated:0,removed:0,unchanged:2,sourceDuplicates:0,blocked:0});
  assert.equal(replay.changes.length,0);
 }
 const unproven={...original,source_details:{...recordedDetails(),provenance:{...recordedDetails().provenance,row:4}}};
 const held=await buildSheetMergePlan(after,[unproven,distinct],'synthetic-source');
 assert.equal(held.summary.blocked,1);assert.equal(held.summary.unchanged,1);assert.equal(held.changes.length,0);
});

test('reconnection requires exact basic details and complete matching URL, sheet and row provenance',async()=>{
 const details=recordedDetails(),stored=await recordedPrevious();
 const invalid=[null,{...details,basic:''},{...details,basic:' '+details.basic},
  {...details,detail:'Different detail'},
  {...details,provenance:undefined},
  {...details,provenance:{...details.provenance,url:''}},
  {...details,provenance:{...details.provenance,url:'https://docs.google.com/spreadsheets/d/other-synthetic/edit'}},
  {...details,provenance:{...details.provenance,sheet:'Another synthetic bank'}},
  {...details,provenance:{...details.provenance,row:3}},
 ];
 for(const source_details of invalid){
  const plan=await buildSheetMergePlan(data([stored]),[recordedSource({source_details})],'synthetic-source');
  assert.equal(plan.summary.blocked,1);assert.equal(plan.changes.length,0);
 }
 for(const patch of [{sheet:'Another synthetic bank'},{source_row:3}]){
  const plan=await buildSheetMergePlan(data([stored]),[recordedSource(patch)],'synthetic-source');
  assert.equal(plan.summary.blocked,1);assert.equal(plan.changes.length,0);
 }
 const missingPreviousDetails=await buildSheetMergePlan(data([await recordedPrevious({source_details:null})]),[recordedSource()],'synthetic-source');
 assert.equal(missingPreviousDetails.summary.blocked,1);assert.equal(missingPreviousDetails.changes.length,0);
});

test('different monetary identity, missing balance or conflicting time never reconnects an existing ID',async()=>{
 const stored=await recordedPrevious({txn_time:'10:00:00'});
 for(const patch of [{account_id:secondAccount},{txn_date:'2026-09-02'},{amount:200},{direction:'in' as const},
  {balance:800},{balance:null},{txn_time:'11:00:00',provided:{category:true,balance:true,tax:false,time:true}}]){
  const plan=await buildSheetMergePlan(data([stored]),[recordedSource(patch)],'synthetic-source');
  assert.equal(plan.summary.updated,0);assert.equal(plan.summary.removed,0);
  assert.ok(plan.changes.every(change=>change.id!==stored.id&&change.expected===null));
 }
 const absent=await buildSheetMergePlan(data([await recordedPrevious({balance:null})]),[recordedSource()],'synthetic-source');
 assert.equal(absent.summary.blocked,1);assert.equal(absent.changes.length,0);
});

test('zero balance is valid evidence and a missing detail is enriched without erasing saved values',async()=>{
 const details=recordedDetails();
 for(const [oldDetails,newDetails] of [[{...details,detail:undefined},details],[details,{...details,detail:undefined}]]){
  const stored=await recordedPrevious({balance:0,source_details:oldDetails});
  const plan=await buildSheetMergePlan(data([stored]),[recordedSource({balance:0,source_details:newDetails})],'synthetic-source');
  assert.equal(plan.summary.updated,1);assert.equal(plan.changes[0].row.source_details?.detail,details.detail);
 }
});

test('repeated source or existing bank identities cannot reconnect through a saved origin',async()=>{
 const stored=await recordedPrevious();
 for(const repeated of [recordedSource(),recordedSource({description:'Another categorized label',source_row:3})]){
  const plan=await buildSheetMergePlan(data([stored]),[recordedSource(),repeated],'synthetic-source');
  assert.equal(plan.summary.updated,0);assert.equal(plan.summary.inserted,0);assert.equal(plan.changes.length,0);
 }
 const other=await recordedPrevious({id:'22222222-2222-4222-8222-222222222222',description:'Other saved bank label'});
 const plan=await buildSheetMergePlan(data([stored,other]),[recordedSource()],'synthetic-source');
 assert.equal(plan.summary.blocked,1);assert.equal(plan.changes.length,0);
});

test('a normal core claimant or another source with missing bank evidence prevents reconnection',async()=>{
 const stored=await recordedPrevious(),reconnect=recordedSource();
 const ordinary=recordedSource({description:stored.description,balance:800,source_row:3});
 const plan=await buildSheetMergePlan(data([stored]),[reconnect,ordinary],'synthetic-source');
 assert.equal(plan.summary.updated,0);assert.equal(plan.changes.length,0);
 const other=recordedSource({description:'Other source label',balance:null,source_row:3});
 const ambiguous=await buildSheetMergePlan(data([stored]),[reconnect,other],'synthetic-source');
 assert.equal(ambiguous.summary.updated,0);assert.equal(ambiguous.changes.length,0);
 const matching=recordedSource({description:stored.description,source_row:3});
 const claimed=await buildSheetMergePlan(data([stored]),[reconnect,matching],'synthetic-source');
 assert.equal(claimed.summary.updated,1);assert.equal(claimed.summary.blocked,1);
 assert.equal(claimed.changes[0].row.source_row,3);assert.equal(claimed.changes[0].id,stored.id);
});

test('confirmed repeated bank sequences are excluded before checking reconnection uniqueness',async()=>{
 const rows=Array.from({length:8},(_,i)=>recordedSource({txn_date:`2026-09-${String(i+1).padStart(2,'0')}`,source_row:i+2,
  balance:900-i*100,description:`Synthetic sheet row ${i}`,source_details:{basic:`Synthetic basic ${i}`,
   provenance:{...recordedDetails().provenance,row:i+2}}}));
 const stored=await Promise.all(rows.map((row,i)=>recordedPrevious({id:`11111111-1111-4111-8111-${String(i+1).padStart(12,'0')}`,
  txn_date:row.txn_date,balance:row.balance,description:`Synthetic bank row ${i}`,source_details:row.source_details})));
 const repeat=rows.map(row=>({...row,source_row:row.source_row+8,source_details:{...row.source_details,
  provenance:{...row.source_details!.provenance!,row:row.source_row+8}}}));
 const plan=await buildSheetMergePlan(data(stored),[...rows,...repeat],'synthetic-source');
 assert.equal(plan.summary.updated,8);assert.equal(plan.summary.sourceDuplicates,8);assert.equal(plan.summary.blocked,0);assert.equal(plan.summary.removed,0);
});

test('source reconnection keeps internal-transfer link protection and independent imports',async()=>{
 const stored=await recordedPrevious({is_internal:true}),incoming=recordedSource();
 const dataset=data([stored],{links:[{id:'link',out_transaction_id:stored.id,in_transaction_id:'other-transaction'}]});
 const plan=await buildSheetMergePlan(dataset,[incoming,recordedSource({txn_date:'2026-09-02',source_row:3})],'synthetic-source');
 assert.equal(plan.summary.updated,0);assert.equal(plan.summary.blocked,1);assert.equal(plan.summary.inserted,1);
 assert.match(plan.conflicts[0].message,/내부이체/);
});

test('normal core updates preserve exact stored description and its memo identity despite normalized spelling differences',async()=>{
 for(const [savedDescription,newDescription] of [['  Synthetic   Payee  ','synthetic payee'],['Ｓｙｎｔｈｅｔｉｃ Payee','Synthetic Payee']]){
  const stored=await previous({description:savedDescription}),incoming=source({description:newDescription});
  const plan=await buildSheetMergePlan(data([stored]),[incoming],'synthetic-source');
  assert.equal(plan.summary.updated,1);const next={...stored,...plan.changes[0].row};
  assert.equal(next.description,savedDescription);assert.equal(next.dedup_hash,stored.dedup_hash);
  assert.equal(noteKey(noteSubject(next)),noteKey(noteSubject(stored)));assert.equal(next.category_id,'salary');
  const replay=await buildSheetMergePlan(data([next]),[incoming],'synthetic-source');
  assert.equal(replay.summary.unchanged,1);assert.equal(replay.changes.length,0);
 }
});

const authoritative={sourceAuthority:true};
function applySynthetic(dataset:Dataset,plan:Awaited<ReturnType<typeof buildSheetMergePlan>>):Dataset{
 const touched=new Set(plan.changes.flatMap(c=>[c.id,...c.duplicates.map(d=>d.id)]));
 return {...dataset,transactions:[...dataset.transactions.filter(t=>!touched.has(t.id)),...plan.changes.map(c=>({...c.row,id:c.id,account_id:c.account_id,business_id:business,upload_id:null}))]};
}
function weakRecord(detail:string,source_row=2,patch:Partial<SheetMergeRow>={}){
 return recordedSource({balance:null,source_row,description:'Synthetic shared label',source_details:{basic:'Synthetic shared label',detail},
  provided:{category:true,balance:false,tax:false,time:false},...patch});
}

test('source authority collapses only identical complete source records without requiring bank time or balance',async()=>{
 const first=weakRecord('Synthetic detail A'),copy={...first,source_row:3};
 const conservative=await buildSheetMergePlan(data([]),[first,copy],'source');
 assert.equal(conservative.summary.blocked,2);
 const plan=await buildSheetMergePlan(data([]),[first,copy],'source',authoritative);
 assert.equal(plan.summary.inserted,1);assert.equal(plan.summary.sourceDuplicates,1);assert.equal(plan.summary.blocked,0);
 const replay=await buildSheetMergePlan(applySynthetic(data([]),plan),[copy,first],'changed-source',authoritative);
 assert.equal(replay.summary.unchanged,1);assert.equal(replay.summary.sourceDuplicates,1);assert.equal(replay.changes.length,0);
 const conflicts=await buildSheetMergePlan(data([]),[first,{...copy,tax_invoice:true}],'source',authoritative);
 assert.equal(conflicts.summary.sourceDuplicates,0);assert.equal(conflicts.summary.blocked,2);assert.equal(conflicts.changes.length,0);
});

test('a unique distinct balance is inserted only when both neighboring balances and date order prove its source sequence',async()=>{
 const stored=await recordedPrevious({description:'Synthetic repeated payment',balance:1200,source_details:null});
 const before=recordedSource({source_row:2,description:'Synthetic preceding payment',balance:1100});
 const middle=recordedSource({source_row:3,description:stored.description,balance:1000});
 const after=recordedSource({source_row:4,description:'Synthetic following payment',balance:900});
 const rows=[before,middle,after],dataset=data([stored]);
 const conservative=await buildSheetMergePlan(dataset,rows,'source');assert.equal(conservative.summary.blocked,1);
 const plan=await buildSheetMergePlan(dataset,rows,'source',authoritative);
 assert.equal(plan.summary.inserted,3);assert.equal(plan.summary.updated,0);assert.equal(plan.summary.blocked,0);
 assert.ok(plan.changes.every(c=>c.id!==stored.id));
 const applied=applySynthetic(dataset,plan);assert.deepEqual(applied.transactions.find(t=>t.id===stored.id),stored);
 const replay=await buildSheetMergePlan(applied,rows,'source',authoritative);assert.equal(replay.changes.length,0);assert.equal(replay.summary.blocked,0);
 for(const broken of [rows.slice(1),[before,middle,{...after,balance:850}],[{...before,txn_date:'2026-09-02'},middle,after]]){
  const held=await buildSheetMergePlan(dataset,broken,'source',authoritative);
  assert.ok(held.conflicts.some(c=>c.row===middle.source_row));assert.ok(!held.changes.some(c=>c.row.source_row===middle.source_row));
 }
});

test('reverse chronological source balance chains also establish a distinct payment',async()=>{
 const stored=await recordedPrevious({txn_date:'2026-09-02',description:'Synthetic repeated payment',balance:1300,source_details:null});
 const rows=[recordedSource({source_row:2,txn_date:'2026-09-03',description:'Synthetic latest',balance:900}),
  recordedSource({source_row:3,txn_date:'2026-09-02',description:stored.description,balance:1000}),
  recordedSource({source_row:4,txn_date:'2026-09-01',description:'Synthetic earliest',balance:1100})];
 const plan=await buildSheetMergePlan(data([stored]),rows,'source',authoritative);
 assert.equal(plan.summary.inserted,3);assert.equal(plan.summary.blocked,0);assert.equal(plan.summary.updated,0);
});

test('a corrected balance at the same recorded origin cannot create a second payment despite a valid new balance chain',async()=>{
 for(const time of [null,'10:00:00']){
  const details={...recordedDetails(),provenance:{...recordedDetails().provenance,row:3}};
  const stored=await recordedPrevious({description:'Synthetic corrected payment',balance:1200,txn_time:time,source_details:details});
  const before=recordedSource({source_row:2,description:'Synthetic preceding payment',balance:1100});
  const middle=recordedSource({source_row:3,description:stored.description,balance:1000,txn_time:time,source_details:details});
  const after=recordedSource({source_row:4,description:'Synthetic following payment',balance:900});
  const dataset=data([stored]),plan=await buildSheetMergePlan(dataset,[before,middle,after],'corrected-source',authoritative);
  assert.equal(plan.summary.inserted,2);assert.equal(plan.summary.blocked,1);assert.equal(plan.summary.updated,0);assert.equal(plan.summary.removed,0);
  assert.equal(plan.conflicts[0].row,3);assert.match(plan.conflicts[0].message,/같은 원본 행의 잔액/);
  assert.ok(!plan.changes.some(change=>change.row.source_row===3));
  assert.deepEqual(applySynthetic(dataset,plan).transactions.find(transaction=>transaction.id===stored.id),stored);
  const differentOrigin={...middle,source_details:{...details,provenance:{...details.provenance,url:'https://docs.google.com/spreadsheets/d/other-synthetic/edit'}}};
  const distinct=await buildSheetMergePlan(dataset,[before,differentOrigin,after],'different-source',authoritative);
  assert.equal(distinct.summary.inserted,3);assert.equal(distinct.summary.blocked,0);
 }
});

test('source authority links unique bank identity to exact explicit detail while preserving the existing ID, description and memo',async()=>{
 const stored=await recordedPrevious({source_details:null}),subject=noteSubject(stored);
 const input=recordedSource({source_details:{basic:'Synthetic bank channel',detail:stored.description}});
 const dataset=data([stored],{notes:[{...subject,id:'saved-note',memo:'Keep this memo',version:1,updated_at:'2026-09-01'}]});
 assert.equal((await buildSheetMergePlan(dataset,[input],'source')).summary.blocked,1);
 const plan=await buildSheetMergePlan(dataset,[input,{...input,source_row:3}],'source',authoritative);
 assert.equal(plan.summary.updated,1);assert.equal(plan.summary.sourceDuplicates,1);assert.equal(plan.summary.inserted,0);
 const saved=applySynthetic(dataset,plan).transactions[0];
 assert.equal(saved.id,stored.id);assert.equal(saved.description,stored.description);assert.equal(noteKey(noteSubject(saved)),noteKey(subject));
 assert.equal(saved.category_id,'salary');assert.equal(saved.source_details?.detail,stored.description);
 const replay=await buildSheetMergePlan(applySynthetic(dataset,plan),[input],'source',authoritative);assert.equal(replay.changes.length,0);
 const nonexact=await buildSheetMergePlan(dataset,[{...input,source_details:{...input.source_details,detail:' '+stored.description}}],'source',authoritative);
 assert.equal(nonexact.summary.blocked,1);assert.equal(nonexact.changes.length,0);
 const duplicate=await recordedPrevious({id:'22222222-2222-4222-8222-222222222222',description:'Other saved label',source_details:null});
 const ambiguous=await buildSheetMergePlan(data([stored,duplicate]),[input],'source',authoritative);
 assert.equal(ambiguous.summary.blocked,1);assert.equal(ambiguous.changes.length,0);
});

test('distinct source details preserve separate weak transactions with collision-safe IDs and hashes',async()=>{
 const rows=[weakRecord('Synthetic recipient A'),weakRecord('Synthetic recipient B',3)];
 const plan=await buildSheetMergePlan(data([]),rows,'source',authoritative);
 assert.equal(plan.summary.inserted,2);assert.equal(plan.summary.blocked,0);assert.equal(plan.summary.removed,0);
 assert.equal(new Set(plan.changes.map(c=>c.id)).size,2);assert.equal(new Set(plan.changes.map(c=>c.row.dedup_hash)).size,2);
 const applied=applySynthetic(data([]),plan),ids=new Set(applied.transactions.map(t=>t.id));
 const replay=await buildSheetMergePlan(applied,rows,'different-source-hash',authoritative);
 assert.equal(replay.summary.unchanged,2);assert.equal(replay.changes.length,0);
 const appended=[weakRecord('Synthetic recipient C',2),{...rows[1],source_row:4},{...rows[0],source_row:6}];
 const next=await buildSheetMergePlan(applied,appended,'appended-source',authoritative);
 assert.equal(next.summary.inserted,1);assert.equal(next.summary.blocked,0);assert.equal(next.summary.removed,0);
 const extended=applySynthetic(applied,next);assert.ok([...ids].every(id=>extended.transactions.some(t=>t.id===id)));
 const renamed=appended.map(r=>({...r,sheet:'Renamed synthetic sheet'}));
 const relocation=await buildSheetMergePlan(extended,renamed,'renamed-source',authoritative);
 assert.equal(relocation.summary.inserted,0);assert.equal(relocation.summary.removed,0);assert.equal(relocation.summary.blocked,0);
 const relocated=applySynthetic(extended,relocation),stable=await buildSheetMergePlan(relocated,renamed,'renamed-source',authoritative);
 assert.equal(stable.summary.unchanged,3);assert.equal(stable.changes.length,0);
 const reclassified=renamed.map(r=>({...r,raw_gwamok:'지급수수료',category_id:'fee'}));
 const classification=await buildSheetMergePlan(relocated,reclassified,'classification-source',authoritative);
 assert.equal(classification.summary.inserted,0);assert.equal(classification.summary.updated,3);
 assert.ok(classification.changes.every(c=>relocated.transactions.find(t=>t.id===c.id)?.dedup_hash===c.row.dedup_hash));
});

test('different optional times are preserved as source records and do not become duplicates on replay',async()=>{
 const rows=[weakRecord('Synthetic same detail'),weakRecord('Synthetic same detail',3,{txn_time:'10:00:00',provided:{category:true,balance:false,tax:false,time:true}})];
 const plan=await buildSheetMergePlan(data([]),rows,'source',authoritative);
 assert.equal(plan.summary.inserted,2);assert.equal(plan.summary.blocked,0);
 const replay=await buildSheetMergePlan(applySynthetic(data([]),plan),rows,'source',authoritative);
 assert.equal(replay.summary.unchanged,2);assert.equal(replay.changes.length,0);
});

test('source authority does not invent a match for multiple historical rows missing source details',async()=>{
 const first=await previous({description:'Synthetic shared label',balance:null,txn_time:null,source_details:null});
 const second=await previous({...first,id:'22222222-2222-4222-8222-222222222222'});
 const dataset=data([first,second]),original=JSON.stringify(dataset);
 const plan=await buildSheetMergePlan(dataset,[weakRecord('Synthetic recipient A'),weakRecord('Synthetic recipient B',3)],'source',authoritative);
 assert.equal(plan.summary.blocked,2);assert.equal(plan.changes.length,0);assert.equal(JSON.stringify(dataset),original);
});

test('source authority preserves internal-transfer protection when reconnecting through explicit source content',async()=>{
 const stored=await recordedPrevious({is_internal:true,source_details:null});
 const dataset=data([stored],{links:[{id:'link',out_transaction_id:stored.id,in_transaction_id:'paired-payment'}]});
 const input=recordedSource({source_details:{basic:'Synthetic bank channel',detail:stored.description}});
 const plan=await buildSheetMergePlan(dataset,[input],'source',authoritative);
 assert.equal(plan.summary.blocked,1);assert.equal(plan.changes.length,0);assert.match(plan.conflicts[0].message,/내부이체/);
});

test('authority applies valid automatic source categories only to unresolved saved rows and preserves original classification evidence',async()=>{
 const categories=[{id:'salary',name:'급여',group_name:'영업지출',is_internal:false,is_operating:true},
  {id:'fee',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true},
  {id:'unmapped',name:'미매핑',group_name:'정리필요',is_internal:false,is_operating:false}];
 const stored=await previous({description:'Synthetic shared label',category_id:'unmapped',raw_gwamok:'이전 원과목',manually_classified:false});
 const input=source({description:stored.description,raw_gwamok:'',category_status:'blank',category_id:'salary',provided:{category:false,balance:true,tax:false,time:true}});
 const conservative=await buildSheetMergePlan(data([stored],{categories}),[input],'source');assert.equal(conservative.changes[0].row.category_id,'unmapped');
 const plan=await buildSheetMergePlan(data([stored],{categories}),[input],'source',authoritative);
 assert.equal(plan.changes[0].row.category_id,'salary');assert.equal(plan.changes[0].row.raw_gwamok,stored.raw_gwamok);assert.equal(plan.changes[0].row.manually_classified,false);
 const valid={...stored,category_id:'fee',manually_classified:true};
 const preserved=await buildSheetMergePlan(data([valid],{categories}),[input],'source',authoritative);
 assert.equal(preserved.changes[0].row.category_id,'fee');assert.equal(preserved.changes[0].row.manually_classified,true);
 const invalid=await buildSheetMergePlan(data([stored],{categories}),[{...input,category_id:'not-registered'}],'source',authoritative);
 assert.equal(invalid.changes[0].row.category_id,'unmapped');
});
