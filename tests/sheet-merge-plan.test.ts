import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSheetMergePlan,type SheetMergeRow} from '../lib/finance/sheet-merge';
import {emptyDataset,type Dataset,type MerchantNote,type Transaction} from '../lib/finance/types';
import {digest} from '../lib/finance/parser';
import {noteKey,noteSubject} from '../lib/finance/merchant-notes';

const account='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',business='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const oldId='11111111-1111-4111-8111-111111111111',secondId='22222222-2222-4222-8222-222222222222';
function source(overrides:Partial<SheetMergeRow>={}):SheetMergeRow{return {account_id:account,sheet:'은행',source_row:2,txn_date:'2026-09-01',txn_time:'10:00:00',amount:100,direction:'out',description:'서비스 회사',raw_gwamok:'수수료',category_id:'fee',is_internal:false,balance:900,tax_invoice:false,dedup_hash:'0'.repeat(64),manually_classified:false,provided:{category:true,balance:true,tax:true,time:true},...overrides};}
async function previous(overrides:Partial<Transaction>={}):Promise<Transaction>{const s=source();const row:Transaction={id:oldId,business_id:business,account_id:account,upload_id:'33333333-3333-4333-8333-333333333333',txn_date:s.txn_date,txn_time:s.txn_time,amount:s.amount,direction:s.direction,description:s.description,raw_gwamok:s.raw_gwamok,category_id:s.category_id,is_internal:false,balance:s.balance,tax_invoice:false,dedup_hash:await digest(account,s.txn_date,s.amount,s.direction,s.description,s.balance),manually_classified:false,...overrides};return row;}
function data(transactions:Transaction[]=[],overrides:Partial<Dataset>={}):Dataset{return {...emptyDataset,accounts:[{id:account,business_id:business,name:'통장',bank:'은행',masked_number:'1234',opening_balance:0,opening_balance_date:null}],transactions,...overrides};}
function note(subject_key:string,overrides:Partial<MerchantNote>={}):MerchantNote{return {id:'note',account_id:account,direction:'out',subject_key,label:'거래처',memo:'보존할 메모',version:1,updated_at:'2026-09-01',...overrides};}
function applyPlan(dataset:Dataset,plan:Awaited<ReturnType<typeof buildSheetMergePlan>>):Dataset{
 const touched=new Set(plan.changes.flatMap(c=>[c.id,...c.duplicates.map(d=>d.id)]));
 return {...dataset,transactions:[...dataset.transactions.filter(t=>!touched.has(t.id)),...plan.changes.map(c=>({...c.row,id:c.id,business_id:business,account_id:c.account_id,upload_id:null}))]};
}

test('linked category is authoritative, retains the existing ID, and detaches old file ownership',async()=>{
 const old=await previous({category_id:'old',raw_gwamok:'이전 과목',manually_classified:true});
 const plan=await buildSheetMergePlan(data([old]),[source()],'source');
 assert.equal(plan.changes[0].kind,'update');assert.equal(plan.changes[0].id,oldId);
 assert.equal(plan.changes[0].row.category_id,'fee');assert.equal(plan.changes[0].row.manually_classified,true);
 assert.deepEqual(plan.changes[0].expected,old);assert.equal('upload_id' in plan.changes[0].row,false);
 assert.deepEqual(plan.summary,{inserted:0,updated:1,removed:0,unchanged:0,sourceDuplicates:0,blocked:0});
});

test('blank source columns retain saved classification, balance, tax and time',async()=>{
 const old=await previous({category_id:null,raw_gwamok:'기존 기록',manually_classified:true,tax_invoice:true});
 const input=source({category_id:'automatic',raw_gwamok:'',balance:null,txn_time:null,provided:{category:false,balance:false,tax:false,time:false}});
 const plan=await buildSheetMergePlan(data([old]),[input],'source');const row=plan.changes[0].row;
 assert.equal(row.category_id,null);assert.equal(row.raw_gwamok,'기존 기록');assert.equal(row.manually_classified,true);
 assert.equal(row.balance,900);assert.equal(row.txn_time,'10:00:00');assert.equal(row.tax_invoice,true);
});

test('real repeated payments with different bank times remain separate and have distinct stable hashes',async()=>{
 const inputs=[source(),source({source_row:3,txn_time:'11:00:00'})];
 const plan=await buildSheetMergePlan(data(),inputs,'source');
 assert.equal(plan.summary.inserted,2);assert.equal(new Set(plan.changes.map(c=>c.row.dedup_hash)).size,2);
 assert.ok(plan.changes.every(c=>/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.id)));
 const replay=await buildSheetMergePlan(applyPlan(data(),plan),inputs,'source');
 assert.equal(replay.summary.unchanged,2);assert.equal(replay.changes.length,0);
 const timeAware=plan.changes.find(c=>c.row.txn_time==='11:00:00')!;
 const surviving={...data(),transactions:applyPlan(data(),plan).transactions.filter(t=>t.id===timeAware.id)};
 const replaySurvivor=await buildSheetMergePlan(surviving,[inputs[1]],'source');
 assert.equal(replaySurvivor.summary.unchanged,1);assert.equal(replaySurvivor.changes.length,0);
});

test('different balances remain separate source transactions even when times are unavailable',async()=>{
 const inputs=[source({txn_time:null}),source({source_row:3,txn_time:null,balance:800})];
 const plan=await buildSheetMergePlan(data(),inputs,'source');
 assert.equal(plan.summary.inserted,2);assert.equal(plan.summary.sourceDuplicates,0);
 for(const change of plan.changes){const row=change.row;assert.equal(row.dedup_hash,await digest(account,row.txn_date,row.amount,row.direction,row.description,row.balance));}
 const replay=await buildSheetMergePlan(applyPlan(data(),plan),inputs,'source');
 assert.equal(replay.summary.unchanged,2);assert.equal(replay.changes.length,0);
});

test('repeated weak source rows and ambiguous existing matches are held without insertion or deletion',async()=>{
 const weak=source({txn_time:null,balance:null});
 const repeated=await buildSheetMergePlan(data(),[weak,{...weak,source_row:3}],'source');
 assert.equal(repeated.summary.blocked,2);assert.equal(repeated.changes.length,0);
 const olds=[await previous({txn_time:null,balance:null}),await previous({id:secondId,txn_time:null,balance:null})];
 const ambiguous=await buildSheetMergePlan(data(olds),[weak],'source');
 assert.equal(ambiguous.summary.blocked,1);assert.equal(ambiguous.changes.length,0);
});

test('exact source repeats collapse only with both a bank balance and transaction time',async()=>{
 const a=source(),b=source({source_row:3});
 const plan=await buildSheetMergePlan(data(),[a,b],'source');
 assert.equal(plan.summary.sourceDuplicates,1);assert.equal(plan.summary.inserted,1);
 const conflicting=await buildSheetMergePlan(data(),[a,{...b,category_id:'other',raw_gwamok:'다른 과목'}],'source');
 assert.equal(conflicting.summary.blocked,2);assert.equal(conflicting.changes.length,0);
 const clearOther=await buildSheetMergePlan(data(),[a,{...b,category_id:'other',raw_gwamok:'다른 과목'},source({source_row:4,balance:800,txn_time:'11:00:00'})],'source');
 assert.equal(clearOther.summary.blocked,2);assert.equal(clearOther.summary.inserted,1);
});

test('strong existing duplicate is removed while an individual memo keeper survives',async()=>{
 const a=await previous({description:'홍길동'}),b=await previous({id:secondId,description:'홍길동'});
 const plan=await buildSheetMergePlan(data([a,b],{notes:[note('transaction:'+secondId)]}),[source({description:'홍길동'})],'source');
 assert.equal(plan.changes[0].id,secondId);assert.deepEqual(plan.changes[0].duplicates.map(d=>d.id),[oldId]);
 assert.equal(plan.summary.removed,1);
});

test('internal-transfer links are protected, and two independently protected duplicates are held',async()=>{
 const a=await previous(),b=await previous({id:secondId});
 const linked=data([a,b],{links:[{id:'link',out_transaction_id:secondId,in_transaction_id:'another'}]});
 const plan=await buildSheetMergePlan(linked,[source()],'source');assert.equal(plan.changes[0].id,secondId);
 assert.equal(plan.changes[0].duplicates[0].id,oldId);
 const held=await buildSheetMergePlan({...linked,notes:[note('transaction:'+oldId,{memo:''})]},[source()],'source');
 assert.equal(held.summary.blocked,1);assert.equal(held.changes.length,0);
 const categoryChange=await buildSheetMergePlan({...linked,transactions:[{...b,is_internal:true}]},[source({is_internal:false})],'source');
 assert.equal(categoryChange.summary.blocked,1);assert.equal(categoryChange.changes.length,0);
});

test('normalized description updates preserve the stored spelling and existing merchant memo identity',async()=>{
 const old=await previous({description:'ＯＰＥＮＡＩ'});
 const subject=noteSubject(old),dataset=data([old],{notes:[note('exact:openai'),note(subject.subject_key,{id:'original-note'})]});
 const inputs=[source({description:'OPENAI'})],plan=await buildSheetMergePlan(dataset,inputs,'source');
 assert.equal(plan.summary.blocked,0);assert.equal(plan.summary.updated,1);assert.equal(plan.summary.removed,0);
 assert.equal(plan.changes[0].id,old.id);assert.equal(plan.changes[0].row.description,old.description);
 const applied=applyPlan(dataset,plan),next=applied.transactions[0];
 assert.equal(noteKey(noteSubject(next)),noteKey(subject));assert.deepEqual(applied.notes,dataset.notes);
 assert.equal(next.category_id,'fee');
 const replay=await buildSheetMergePlan(applied,inputs,'source');
 assert.equal(replay.summary.unchanged,1);assert.equal(replay.changes.length,0);
});

test('first import and replay are deterministic and preserve existing classifications when source is empty',async()=>{
 const inputs=[source()];const plan=await buildSheetMergePlan(data(),inputs,'source');
 assert.deepEqual(await buildSheetMergePlan(data(),inputs,'source'),plan);
 const replay=await buildSheetMergePlan(applyPlan(data(),plan),inputs,'source');
 assert.equal(replay.summary.unchanged,1);assert.equal(replay.changes.length,0);
 assert.equal(replay.planHash.length,64);
 const partial=source({txn_time:null,balance:null,raw_gwamok:'',category_id:null,provided:{category:false,balance:false,tax:false,time:false}});
 const first=await buildSheetMergePlan(data(),[partial],'source');
 const again=await buildSheetMergePlan(applyPlan(data(),first),[partial],'source');
 assert.equal(again.summary.unchanged,1);assert.equal(again.changes.length,0);
});

test('a contradictory partial bank identity is held instead of overwriting or adding a duplicate',async()=>{
 const old=await previous({balance:800,txn_time:null});
 const plan=await buildSheetMergePlan(data([old]),[source()],'source');
 assert.equal(plan.summary.blocked,1);assert.equal(plan.summary.removed,0);assert.equal(plan.changes.length,0);
 const known=await previous({txn_time:null});
 const inputs=[source({source_row:3,balance:800,txn_time:'09:00:00'}),source()];
 const initial=await buildSheetMergePlan(data([known]),inputs,'source');
 assert.equal(initial.summary.updated,1);assert.equal(initial.summary.blocked,1);
 const replay=await buildSheetMergePlan(applyPlan(data([known]),initial),inputs,'source');
 assert.equal(replay.changes.length,0);assert.equal(replay.summary.unchanged,1);assert.equal(replay.summary.blocked,1);
});

function sequence(reverse=false){
 const rows=Array.from({length:8},(_,i)=>source({source_row:i+2,txn_date:i<4?'2026-09-01':'2026-09-02',txn_time:null,balance:900-i*100,provided:{category:true,balance:true,tax:true,time:false}}));
 const ordered=reverse?rows.reverse().map((r,i)=>({...r,source_row:i+2})):rows;
 return [...ordered,...ordered.map((r,i)=>({...r,source_row:i+10}))];
}

test('an exact adjacent multi-day bank sequence keeps its first copy, in either balance order',async()=>{
 for(const reverse of [false,true]){
  const rows=sequence(reverse),plan=await buildSheetMergePlan(data(),rows,'source');
  assert.equal(plan.summary.inserted,8);assert.equal(plan.summary.sourceDuplicates,8);assert.equal(plan.summary.blocked,0);
  assert.ok(plan.changes.every(c=>c.row.source_row!<10));
  const replay=await buildSheetMergePlan(applyPlan(data(),plan),rows,'source');
  assert.equal(replay.summary.unchanged,8);assert.equal(replay.summary.sourceDuplicates,8);assert.equal(replay.changes.length,0);
 }
});

test('partial matches, different supplied fields, dates, balances and broken balances do not collapse a sequence',async()=>{
 const cases=[
  sequence().map((r,i)=>i===15?{...r,tax_invoice:true}:r),
  sequence().map((r,i)=>i===15?{...r,provided:{...r.provided,tax:false}}:r),
  sequence().map((r,i)=>i>=8?{...r,txn_date:r.txn_date.replace('09','10')}:r),
  sequence().map((r,i)=>i>=8?{...r,balance:r.balance!+1000}:r),
  sequence().map((r,i)=>i===3||i===11?{...r,balance:r.balance!+1}:r),
 ];
 for(const rows of cases){const plan=await buildSheetMergePlan(data(),rows,'source');assert.equal(plan.summary.sourceDuplicates,0);}
});

test('short, single-day, noncontiguous or incomplete-balance repetitions remain for review',async()=>{
 const short=sequence().filter((_,i)=>i!==7&&i!==15).map((r,i)=>({...r,source_row:i+2}));
 const cases=[short,sequence().map(r=>({...r,txn_date:'2026-09-01'})),sequence().map((r,i)=>({...r,source_row:r.source_row+(i>=8?1:0)})),sequence().map((r,i)=>i===3||i===11?{...r,balance:null}:r)];
 for(const rows of cases){const plan=await buildSheetMergePlan(data(),rows,'source');assert.equal(plan.summary.sourceDuplicates,0);assert.ok(plan.summary.blocked>0);}
});

test('source metadata enriches an existing row without changing its identity and blank fields remain saved',async()=>{
 const old=await previous({source_details:{basic:'기존 기본내역',detail:'기존 설명',record:'은행 기록'}});
 const input=source({source_details:{basic:'새 기본내역',detail:' ',counterparty:'명시 상대방',provenance:{sheet:'은행',row:2}}});
 const plan=await buildSheetMergePlan(data([old]),[input],'source');
 assert.equal(plan.summary.updated,1);assert.equal(plan.changes[0].id,old.id);assert.equal(plan.changes[0].row.dedup_hash,old.dedup_hash);
 assert.deepEqual(plan.changes[0].row.source_details,{basic:'새 기본내역',detail:'기존 설명',record:'은행 기록',counterparty:'명시 상대방',provenance:{sheet:'은행',row:2}});
 const replay=await buildSheetMergePlan(applyPlan(data([old]),plan),[input],'source');
 assert.equal(replay.summary.unchanged,1);assert.equal(replay.changes.length,0);
});

test('duplicate source signatures include metadata values while ignoring different source row provenance',async()=>{
 const first=source({source_details:{basic:'같은 기본내역',memo:'같은 메모',provenance:{sheet:'은행',row:2}}});
 const second=source({source_row:3,source_details:{basic:'같은 기본내역',memo:'같은 메모',provenance:{sheet:'은행',row:3}}});
 const duplicate=await buildSheetMergePlan(data(),[first,second],'source');assert.equal(duplicate.summary.sourceDuplicates,1);
 const conflict=await buildSheetMergePlan(data(),[first,{...second,source_details:{...second.source_details,memo:'서로 다른 메모'}}],'source');
 assert.equal(conflict.summary.sourceDuplicates,0);assert.equal(conflict.summary.blocked,2);assert.equal(conflict.changes.length,0);
 const repeated=sequence().map(row=>({...row,source_details:{basic:'원본 설명',provenance:{sheet:'은행',row:row.source_row}}}));
 assert.equal((await buildSheetMergePlan(data(),repeated,'source')).summary.sourceDuplicates,8);
});

test('deleting a proven financial duplicate cannot discard source details replaced by new source text',async()=>{
 const first=await previous({source_details:{record:'은행에서 보존해야 할 기록'}}),second=await previous({id:secondId,source_details:{record:'은행에서 보존해야 할 기록'}});
 const plan=await buildSheetMergePlan(data([first,second]),[source({source_details:{record:'새 원본의 다른 기록'}})],'source');
 assert.equal(plan.summary.blocked,1);assert.equal(plan.summary.removed,0);assert.equal(plan.changes.length,0);
 assert.match(plan.conflicts[0].message,/원본 내역/);
});
