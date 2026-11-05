import test,{beforeEach,afterEach} from 'node:test';
import {installationPolicy} from '../lib/finance/installation-policy';
beforeEach(()=>{installationPolicy.historicalCompletionBefore='2026-01-01';});
afterEach(()=>{installationPolicy.historicalCompletionBefore=null;});
import assert from 'node:assert/strict';
import {utils,write} from '@e965/xlsx';
import {createClassifier,normalizeRows,digest} from '../lib/finance/parser';
import {prepareSheetRows} from '../lib/finance/google-sheets';
import {buildSheetMergePlan,type SheetMergeRow} from '../lib/finance/sheet-merge';
import {buildReviewGroups,prepareReviewChanges} from '../lib/finance/classification-review';
import {emptyDataset,type Category,type Dataset,type Rule,type Transaction} from '../lib/finance/types';
import {resolveHistoricalCompletion} from '../lib/finance/category-status';

const categories:Category[]=[
 {id:'unknown',name:'미매핑',group_name:'검토',is_internal:false,is_operating:false},
 {id:'generic',name:'출금',group_name:'검토',is_internal:false,is_operating:false},
 {id:'closed',name:'과거완료',group_name:'과거완료',is_internal:false,is_operating:false,is_fixed:false},
 {id:'fee',name:'수수료',group_name:'비용',is_internal:false,is_operating:true},
 {id:'salary',name:'급여',group_name:'비용',is_internal:false,is_operating:true},
];
const account='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',business='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const dataset=(transactions:Transaction[]=[],rules:Rule[]=[]):Dataset=>({...emptyDataset,categories,rules,transactions,businesses:[{id:business,name:'Synthetic business',representative:'Synthetic',kind:'법인',reserve:0,color:'#000000'}],accounts:[{id:account,business_id:business,name:'Synthetic bank',bank:'Synthetic',masked_number:'000',opening_balance:0,opening_balance_date:null}]});
const rule=(patch:Partial<Rule>={}):Rule=>({id:'rule',pattern:'^Synthetic$',field:'description',category_id:'fee',priority:5,is_internal:false,account_id:account,direction:'out',...patch});
const previous=(patch:Partial<Transaction>={}):Transaction=>({id:'11111111-1111-4111-8111-111111111111',account_id:account,business_id:business,upload_id:null,txn_date:'2025-12-31',txn_time:null,amount:100,direction:'out',description:'Synthetic',raw_gwamok:'출금',category_id:'closed',is_internal:false,balance:900,tax_invoice:false,dedup_hash:'synthetic',manually_classified:true,...patch});
const source=(patch:Partial<SheetMergeRow>={}):SheetMergeRow=>({account_id:account,sheet:'Synthetic bank',source_row:2,txn_date:'2025-12-31',txn_time:null,amount:100,direction:'out',description:'Synthetic',raw_gwamok:'출금',category_id:'closed',category_status:'needs_review',is_internal:false,balance:900,tax_invoice:false,dedup_hash:'synthetic',manually_classified:true,provided:{category:true,balance:true,tax:false,time:false},...patch});

test('explicit installer cutoff and completion category are both required and stop strictly at cutoff',()=>{
 const without=categories.filter(category=>category.id!=='closed');
 assert.equal(resolveHistoricalCompletion(without,'2025-12-31','unknown'),undefined);
 const classify=createClassifier(categories,[],[]),baseline=createClassifier(without,[],[]);
 assert.equal(classify('','Synthetic',{txn_date:'2025-12-31'}).category_id,'closed');
 assert.equal(classify('출금','Synthetic',{txn_date:'2025-12-31'}).category_id,'closed');
 for(const date of ['2026-01-01','2026-12-31',undefined])assert.deepEqual(classify('출금','Synthetic',{txn_date:date}),baseline('출금','Synthetic',{txn_date:date}));
 assert.equal(baseline('출금','Synthetic',{txn_date:'2025-12-31'}).category_id,'generic');
});

test('explicit historical categories, aliases and valid rule results outrank completion',()=>{
 const classify=createClassifier(categories,[rule()],[{id:'alias',raw_name:'가상급여',standard_name:'급여'}]);
 const context={account_id:account,direction:'out' as const,txn_date:'2025-12-31'};
 assert.equal(classify('수수료','Synthetic',context).category_id,'fee');
 assert.equal(classify('가상급여','Synthetic',context).category_id,'salary');
 assert.equal(classify('출금','Synthetic',context).category_id,'fee');
 assert.equal(createClassifier(categories,[rule({category_id:'generic'})],[])('출금','Synthetic',context).category_id,'closed');
});

test('file parsing completes only old unresolved rows without changing original source labels',()=>{
 const rows=[['날짜','출금','기본내역','과목'],['2025-12-31',100,'Unknown old','출금'],['2026-01-01',200,'Unknown current','출금'],['2025-12-30',300,'Known old','수수료']];
 const mapping={date:0,expense:1,description:2,category:3};
 const parsed=normalizeRows(rows,mapping,categories,[],[],{headerRow:0}).parsed;
 assert.deepEqual(parsed.map(row=>[row.txn_date,row.category_id,row.manually_classified,row.raw_gwamok,row.amount]),[['2025-12-31','closed',true,'출금',100],['2026-01-01','generic',false,'출금',200],['2025-12-30','fee',false,'수수료',300]]);
 const deferred=normalizeRows(rows,mapping,categories,[],[],{headerRow:0,completeHistorical:false}).parsed;
 assert.equal(deferred[0].category_id,'generic');assert.equal(deferred[0].manually_classified,false);
});

test('sheet completion runs after explicit detail classification and covers unknown source category names',async()=>{
 const wb=utils.book_new();utils.book_append_sheet(wb,utils.aoa_to_sheet([
  ['연도','월','일','과목','기본내역','세부내역','입금','출금'],
  [2025,12,25,'출금','Synthetic detail salary','급여',0,100],
  [2025,12,26,'출금','Synthetic unknown old','',0,200],
  [2025,12,27,'Unregistered synthetic category','Synthetic unknown category','',0,300],
  [2026,1,1,'출금','Synthetic unknown current','',0,400],
  [2025,12,28,'수수료','Synthetic explicit category','',0,500],
  [2026,1,2,'출금','Synthetic current completion note','과거완료',0,600],
 ]),'Synthetic bank');
 const result=await prepareSheetRows(new Uint8Array(write(wb,{type:'array',bookType:'xlsx'})),dataset(),[{sheet:'Synthetic bank',account_id:account,selected:true}]);
 assert.deepEqual(result.incoming.map(row=>[row.category_id,row.manually_classified]),[['salary',false],['closed',true],['closed',true],['generic',false],['fee',false],['generic',false]]);
 assert.equal(result.incoming[2].raw_gwamok,'Unregistered synthetic category');
 assert.equal(result.sheets[0].sample[1].category_name,'과거완료');
 assert.equal(result.incoming[1].category_status,'needs_review');assert.equal(result.incoming[2].category_status,'unregistered');
 assert.deepEqual(result.sheets[0].categoryIssues,[{rawName:'출금',count:3,status:'needs_review'}]);
});

test('sheet reimport preserves completed and previously classified old transactions in both merge modes',async()=>{
 for(const sourceAuthority of [false,true])for(const category_id of ['closed','fee']){
  const saved=previous({category_id,source_sheet:'Synthetic bank',source_row:2});
  saved.dedup_hash=await digest(account,saved.txn_date,saved.amount,saved.direction,saved.description,saved.balance);
  const plan=await buildSheetMergePlan(dataset([saved]),[source()],'source',{sourceAuthority});
  assert.equal(plan.summary.blocked,0);assert.equal(plan.summary.inserted,0);
  const next=plan.changes[0]?.row||saved;
  assert.equal(next.category_id,category_id);assert.equal(next.manually_classified,true);
 }
});

test('merge completes new old unresolved rows and keeps 2026 unresolved without erasing current valid categories',async()=>{
 for(const sourceAuthority of [false,true]){
  const rows=[source({category_id:'unknown',manually_classified:false}),source({txn_date:'2026-01-01',source_row:3,category_id:'generic',manually_classified:false})];
  const plan=await buildSheetMergePlan(dataset(),rows,'source',{sourceAuthority});
  assert.equal(plan.summary.inserted,2);assert.equal(plan.summary.blocked,0);
  assert.deepEqual(plan.changes.map(change=>[change.row.txn_date,change.row.category_id,change.row.manually_classified]),[['2025-12-31','closed',true],['2026-01-01','generic',false]]);
  const applied=plan.changes.map(change=>({...change.row,id:change.id,account_id:account,business_id:business,upload_id:null}));
  const replay=await buildSheetMergePlan(dataset(applied),rows,'source',{sourceAuthority});
  assert.equal(replay.changes.length,0);
 }
});

test('completion history and rules cannot recommend or automatically classify current transactions as closed',()=>{
 const history=[previous({id:'old-1'}),previous({id:'old-2',txn_date:'2024-01-01'})];
 const current=previous({id:'current',txn_date:'2026-01-01',category_id:'unknown',manually_classified:false});
 const rules=[rule({category_id:'closed'})];
 const group=buildReviewGroups(dataset([...history,current],rules))[0];
 assert.equal(group.suggestedCategoryId,null);assert.equal(group.historyCount,0);
 assert.equal(createClassifier(categories,rules,[])('출금','Synthetic',{txn_date:'2026-01-01',account_id:account,direction:'out'}).category_id,'generic');
 const known=[previous({id:'known-1',category_id:'fee'}),previous({id:'known-2',category_id:'fee'})];
 const real=buildReviewGroups(dataset([...history,...known,current]))[0];
 assert.equal(real.suggestedCategoryId,'fee');assert.equal(real.historyCount,2);
});

test('explicit user selection remains allowed but the completion category never creates a learned rule',()=>{
 const current=previous({id:'current',txn_date:'2026-01-01',category_id:'unknown',manually_classified:false}),data=dataset([current]);
 const group=buildReviewGroups(data)[0];
 const result=prepareReviewChanges(data,[{key:group.key,category_id:'closed',remember:true,transactions:group.rows.map(({id,category_id,manually_classified})=>({id,category_id,manually_classified}))}]);
 assert.equal(result.changes.length,1);assert.equal(result.changes[0].category_id,'closed');assert.deepEqual(result.rules,[]);
});


test('an empty installation never automatically completes unresolved history',()=>{
 installationPolicy.historicalCompletionBefore=null;
 const classify=createClassifier(categories,[],[]);
 assert.equal(classify('출금','Synthetic',{txn_date:'2020-01-01'}).category_id,'generic');
 assert.equal(resolveHistoricalCompletion(categories,'2020-01-01','unknown'),undefined);
 for(const invalid of ['2026-02-30','not-a-date','2026-13-01']){
  installationPolicy.historicalCompletionBefore=invalid;
  assert.equal(resolveHistoricalCompletion(categories,'2020-01-01','unknown'),undefined);
 }
});
