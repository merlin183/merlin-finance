import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBankPlanDataset,unionBankPlanTransactions,type BankPlanActual,type BankPlanCoverage} from '../lib/finance/clobe-plan-actuals';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildCashPlanWorksheetModel} from '../lib/finance/cash-plan-worksheet-model';
import {buildCashEstimateBudgetsForRange,cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {buildFundingReport} from '../lib/finance/funding-report';
import {buildCurrentCashForecast} from '../lib/finance/cash-plan';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {cashEstimateSourceIdentity,mergeCashPlanCategory,readCashPlanCategory,cashPlanCategoryMemoError} from '../lib/finance/cash-plan-category';
import {cashPlanMemoDisplay,cashPlanUserMemo,mergeCashPlanUserMemo} from '../lib/finance/cash-plan-memo';

const range={from:'2027-04-01',to:'2027-04-30'},asOf='2027-04-12',collected='2027-04-12T09:00:00+09:00';
const row=(id:string,date:string,amount:number,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',txn_date:date,txn_time:'12:00:00',amount,balance:900,direction:'out',description:'Synthetic service',upload_id:null,raw_gwamok:'',category_id:'fees',is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const history=['01','02','03'].map(month=>row(`history-${month}`,`2027-${month}-10`,100));
const coverage=(extra:Partial<BankPlanCoverage>={}):BankPlanCoverage=>({account_id:'a1',business_id:'b1',from:range.from,to:asOf,collected_at:collected,synced_at:'2027-04-12T00:01:00Z',status:'complete',reason:null,source:'clobe',currency:'KRW',...extra});
const actual=(extra:Partial<BankPlanActual>={}):BankPlanActual=>({account_id:'a1',business_id:'b1',external_transaction_id:'123',txn_date:'2027-04-10',txn_time:'12:00:00',amount:100,balance:900,description:'Synthetic service',party:null,source_details:{basic:'Synthetic service'},currency:'KRW',source:'clobe',collected_at:collected,synced_at:'2027-04-12T00:01:00Z',transaction_id:null,...extra});
const dataset=(extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,businesses:[{id:'b1',name:'Synthetic company',representative:'',kind:'법인',reserve:0,color:'#123456'}],accounts:[{id:'a1',business_id:'b1',name:'Synthetic bank account',bank:'Synthetic bank',masked_number:'0001',opening_balance:1000,opening_balance_date:'2027-03-31'},{id:'a2',business_id:'b1',name:'Other account',bank:'Synthetic bank',masked_number:'0002',opening_balance:1000,opening_balance_date:'2027-03-31'}],categories:[{id:'fees',name:'지급수수료',group_name:'영업지출',is_operating:true,is_internal:false}],transactions:history,...extra});
const edit=(extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:'e1',business_id:'b1',source_type:'estimated',source_key:cashEstimateSourceKey(history[0]),month:'2027-04',title:'Saved service',account_id:'a1',plan_date:'2027-04-10',amount:100,memo:'Preserved user memo',excluded:false,version:2,updated_at:'2027-04-11T00:00:00Z',...extra});
function review(data:Dataset,edits:CashPlanEdit[]=[],basis:'estimated'|'registered'='estimated',selected=range,now=asOf){
 const before=JSON.stringify({data,edits}),editable=buildEditableCashPlan(data,selected,now,edits);
 const worksheet=buildCashPlanWorksheetModel({data,editable,basis,range:selected,asOf:now});
 assert.equal(JSON.stringify({data,edits}),before);
 return {editable,worksheet,rows:worksheet.businesses[0].rows};
}

const salaryCategory='30000000-0000-4000-8000-000000000001',adsCategory='30000000-0000-4000-8000-000000000002',loanCategory='30000000-0000-4000-8000-000000000003';
const personRow=(id:string,date:string,amount:number,category_id:string|null=salaryCategory,extra:Partial<Transaction>={})=>row(id,date,amount,{category_id,description:'Synthetic recipient',source_details:{counterparty:'Synthetic recipient'},...extra});
const categoryData=(transactions:Transaction[],extra:Partial<Dataset>={}):Dataset=>dataset({categories:[
 {id:salaryCategory,name:'급여',group_name:'영업지출',is_internal:false,is_operating:true},
 {id:adsCategory,name:'광고선전비',group_name:'영업지출',is_internal:false,is_operating:true},
 {id:loanCategory,name:'대여금',group_name:'내부이동',is_internal:true,is_operating:false},
 ],transactions,...extra});
const personHistory=(categoryId=salaryCategory,amount=100,prefix='salary')=>['01','02','03'].map(month=>personRow(`${prefix}-${month}`,`2027-${month}-10`,amount,categoryId));

test('same recipient salary history remains eligible beside loans, and loan actual never consumes salary',()=>{
 const salary=personHistory(),loan=personRow('loan-actual','2027-04-10',100,loanCategory,{txn_time:'13:00:00',balance:800});
 const paid=personRow('salary-actual','2027-04-10',100,salaryCategory,{txn_time:'12:00:00',balance:900});
 const data=categoryData([...salary,...personHistory(loanCategory,30,'loan'),paid,loan]);
 const model=review(data);
 assert.equal(model.editable.items.length,1);
 const item=model.editable.items[0];
 assert.equal(item.source_key,cashEstimateSourceKey(salary[0]));
 assert.deepEqual([item.categoryId,item.recordedAmount,item.remainingAmount],[salaryCategory,100,0]);
 assert.deepEqual(item.recordedTransactions?.map(tx=>tx.id),[paid.id]);
 const actualOnly=model.worksheet.businesses[0].actualOnlyRows;
 assert.equal(actualOnly[0].categoryId,loanCategory);assert.equal(actualOnly[0].editableTransactionId,loan.id);
});

test('same recipient expense categories stay separate while each same-category group still aggregates once',()=>{
 const transactions=[...personHistory(),...personHistory(salaryCategory,10,'extra-salary'),...personHistory(adsCategory,40,'ads'),personRow('salary-paid','2027-04-10',55),personRow('ads-paid','2027-04-10',20,adsCategory)];
 const {editable,rows}=review(categoryData(transactions));
 assert.equal(editable.items.length,2);
 assert.deepEqual(rows.map(item=>[item.categoryId,item.originalAmount,item.recordedAmount,item.remainingAmount]).sort(),[[salaryCategory,110,55,55],[adsCategory,40,20,20]].sort());
 assert.equal(new Set(editable.items.flatMap(item=>item.recordedTransactions!.map(tx=>tx.id))).size,2);
 for(const item of editable.items)assert.equal(cashEstimateSourceIdentity(item.source_key)?.categoryId,item.categoryId);
});

test('ambiguous unknown bank category cannot choose among two accounting categories or become editable ledger evidence',()=>{
 const data=categoryData([...personHistory(),...personHistory(adsCategory,40,'ads')],{bank_plan_actuals:[actual({description:'Synthetic recipient',party:'Synthetic recipient',source_details:{counterparty:'Synthetic recipient'},amount:25})],bank_plan_coverage:[coverage()]});
 const model=review(data);
 assert.deepEqual(model.rows.map(item=>item.recordedAmount),[0,0]);
 const actualOnly=model.worksheet.businesses[0].actualOnlyRows;
 assert.equal(actualOnly.length,1);assert.equal(actualOnly[0].editableTransactionId,null);assert.equal(actualOnly[0].categoryId,null);assert.equal(actualOnly[0].categoryName,'');
});

test('saved ledger category overrides provider raw label and linked bank rows retain explicit ledger identity',()=>{
 const paid=personRow('saved-expense','2027-04-10',60,salaryCategory,{raw_gwamok:'대여금',manually_classified:true});
 const data=categoryData([...personHistory(),paid],{bank_plan_actuals:[actual({description:'Synthetic recipient',source_details:{counterparty:'Synthetic recipient'},transaction_id:paid.id,amount:60})],bank_plan_coverage:[coverage()]});
 const excluded=edit({source_key:cashEstimateSourceKey(paid),excluded:true});
 const model=review(data,[excluded]),actualOnly=model.worksheet.businesses[0].actualOnlyRows[0];
 assert.equal(actualOnly.source,'bank-query');assert.equal(actualOnly.editableTransactionId,paid.id);assert.equal(actualOnly.categoryName,'급여');
 assert.equal(review(data).rows[0].recordedAmount,60);
});

test('legacy ambiguous saved budget preserves one amount, date, confirmation and memo without cloning category budgets',()=>{
 const data=categoryData([...personHistory(),...personHistory(adsCategory,40,'ads'),personRow('salary-paid','2027-04-10',50),personRow('ads-paid','2027-04-10',20,adsCategory)]);
 const saved=edit({source_key:cashEstimateSourceKey(data.transactions[0]),plan_date:'2027-04-18',amount:160,confirmed_amount:15,confirmed_date:'2027-04-11',confirmation_complete:false,confirmation_memo:'Synthetic confirmation'});
 const before=JSON.stringify({data,saved}),model=review(data,[saved]);
 assert.equal(model.editable.items.length,1);
 assert.deepEqual([model.editable.items[0].amount,model.editable.items[0].recordedAmount,model.editable.items[0].remainingAmount],[160,15,145]);
 assert.equal(model.editable.items[0].date,saved.plan_date);assert.equal(model.editable.items[0].edit,saved);
 assert.equal(JSON.stringify({data,saved}),before);
 const hidden=review(data,[{...saved,id:'global',month:'*',plan_date:null,excluded:true}]);
 assert.equal(hidden.editable.items.filter(item=>!item.excluded).length,0);assert.equal(hidden.editable.estimates.businesses[0].total,0);
});

test('overlapping saved legacy and category-qualified budgets keep one active budget and retain held edits for recovery',()=>{
 const data=categoryData([...personHistory(),...personHistory(adsCategory,40,'ads'),personRow('salary-paid','2027-04-10',80)]);
 const base=cashEstimateSourceKey(data.transactions[0]),qualified=JSON.stringify([...JSON.parse(base),salaryCategory]);
 const legacy=edit({source_key:base,amount:300}),descendant=edit({id:'qualified',source_key:qualified,amount:100,confirmed_amount:10,confirmed_date:'2027-04-10',confirmation_complete:false});
 const original=JSON.stringify({data,legacy,descendant}),model=review(data,[legacy,descendant]);
 const held=model.editable.items.find(item=>item.source_key===qualified)!;
 assert.ok(held.categoryConflictReason);assert.equal(held.excluded,true);assert.equal(held.edit?.excluded,false);assert.equal(held.edit,descendant);assert.equal(held.remainingAmount,0);
 assert.equal(model.editable.estimates.businesses[0].total,300);assert.equal(model.rows.length,1);
 const salary=review(data,[{...legacy,memo:mergeCashPlanCategory(legacy.memo,salaryCategory)},descendant]);
 assert.deepEqual([salary.rows[0].recordedAmount,salary.rows[0].remainingAmount],[80,220]);
 const disjoint=review(data,[{...legacy,memo:mergeCashPlanCategory(legacy.memo,adsCategory)},descendant]);
 assert.equal(disjoint.editable.items.filter(item=>!item.excluded).length,2);
 assert.equal(disjoint.editable.items.find(item=>item.source_key===qualified)?.categoryConflictReason,undefined);
 assert.equal(JSON.stringify({data,legacy,descendant}),original);
});

test('explicit plan category override changes only matching and remaining budget while balances and original payment dates stay unchanged',()=>{
 const data=categoryData([...personHistory(),...personHistory(adsCategory,40,'ads'),personRow('salary-paid','2027-04-08',50),personRow('ads-paid','2027-04-09',20,adsCategory)]);
 const saved=edit({source_key:cashEstimateSourceKey(data.transactions[0]),amount:160,plan_date:'2027-04-18'}),before=JSON.stringify(data);
 const salary=review(data,[{...saved,memo:mergeCashPlanCategory(saved.memo,salaryCategory)}]);
 const ads=review(data,[{...saved,memo:mergeCashPlanCategory(saved.memo,adsCategory)}]);
 assert.equal(salary.editable.items.length,1);assert.equal(ads.editable.items.length,1);
 assert.deepEqual([salary.rows[0].recordedAmount,salary.rows[0].remainingAmount,ads.rows[0].recordedAmount,ads.rows[0].remainingAmount],[50,110,20,140]);
 assert.equal(salary.editable.plan.businesses[0].balance,ads.editable.plan.businesses[0].balance);
 assert.equal(salary.rows[0].date,'2027-04-18');assert.equal(ads.rows[0].date,'2027-04-18');
 assert.equal(salary.rows[0].recordedPaymentDates[0].date,'2027-04-08');assert.equal(ads.rows[0].recordedPaymentDates[0].date,'2027-04-09');
 assert.equal(JSON.stringify(data),before);
});

test('explicit saved transaction category edit recalculates salary remaining without changing bank amount, date or balance',()=>{
 const paid=personRow('saved-payment','2027-04-09',50,salaryCategory,{raw_gwamok:'대여금'}),data=categoryData([...personHistory(),paid]);
 const before=JSON.stringify(data),previous=review(data);
 const corrected={...data,transactions:data.transactions.map(tx=>tx.id===paid.id?{...tx,category_id:loanCategory,is_internal:true,manually_classified:true}:tx)},next=review(corrected);
 assert.deepEqual([previous.rows[0].recordedAmount,previous.rows[0].remainingAmount,next.rows[0].recordedAmount,next.rows[0].remainingAmount],[50,50,0,100]);
 assert.equal(previous.editable.plan.businesses[0].balance,next.editable.plan.businesses[0].balance);
 const original=corrected.transactions.find(tx=>tx.id===paid.id)!;
 assert.deepEqual([original.amount,original.txn_date,original.balance],[paid.amount,paid.txn_date,paid.balance]);
 assert.equal(next.worksheet.businesses[0].actualOnlyRows[0].categoryId,loanCategory);assert.equal(JSON.stringify(data),before);
});

test('unknown bank loan labels are blocked but loan interest expense and saved classification keep their distinct meaning',()=>{
 const raw=(description:string)=>actual({description,party:'Synthetic recipient',source_details:{counterparty:'Synthetic recipient'},amount:25});
 const salary=categoryData(personHistory(),{bank_plan_actuals:[raw('대여금 · Synthetic recipient')],bank_plan_coverage:[coverage()]});
 assert.equal(review(salary).rows[0].recordedAmount,0);
 const interest=categoryData(personHistory(),{bank_plan_actuals:[raw('대출이자 · Synthetic recipient')],bank_plan_coverage:[coverage()]});
 assert.equal(review(interest).rows[0].recordedAmount,25);
});

test('exact bank-only provider expense category guards estimated and manual salary matching without classifying the source',()=>{
 const fee='30000000-0000-4000-8000-000000000004',base=categoryData(personHistory());
 const raw=actual({description:'Synthetic recipient',party:'Synthetic recipient',source_details:{counterparty:'Synthetic recipient',note:'Clobe 원본 분류(표시용): 지급수수료'},amount:100});
 const data={...base,categories:[...base.categories,{id:fee,name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true}],bank_plan_actuals:[raw],bank_plan_coverage:[coverage()]},before=JSON.stringify(data);
 const estimated=review(data);
 assert.deepEqual([estimated.rows[0].recordedAmount,estimated.rows[0].remainingAmount],[0,100]);
 const actualOnly=estimated.worksheet.businesses[0].actualOnlyRows[0];
 assert.equal(actualOnly.categoryId,null);assert.equal(actualOnly.categoryName,'');assert.equal(actualOnly.editableTransactionId,null);
 const manual=edit({id:'manual-plan',source_type:'manual',source_key:'40000000-0000-4000-8000-000000000004',title:'Synthetic recipient',memo:mergeCashPlanCategory('',salaryCategory)});
 const manualData={...data,transactions:[]},manualSalary=review(manualData,[manual]);
 assert.deepEqual([manualSalary.rows[0].recordedAmount,manualSalary.rows[0].remainingAmount],[0,100]);
 const manualFee=review(manualData,[{...manual,memo:mergeCashPlanCategory('',fee)}]);
 assert.equal(manualFee.rows[0].recordedAmount,100);assert.equal(manualFee.editable.items[0].recordedTransactions?.[0].category_id,null);
 assert.equal(JSON.stringify(data),before);
});

test('a unique exact provider category distinguishes bank-only expense groups without changing actual category or raw note',()=>{
 const raw=actual({description:'Synthetic recipient',party:'Synthetic recipient',source_details:{counterparty:'Synthetic recipient',note:'Clobe 원본 분류(표시용): 광고 선전비'},amount:40});
 const data=categoryData([...personHistory(),...personHistory(adsCategory,40,'ads')],{bank_plan_actuals:[raw],bank_plan_coverage:[coverage()]}),before=JSON.stringify(data);
 const model=review(data),salary=model.rows.find(item=>item.categoryId===salaryCategory)!,ads=model.rows.find(item=>item.categoryId===adsCategory)!;
 assert.deepEqual([salary.recordedAmount,salary.remainingAmount,ads.recordedAmount,ads.remainingAmount],[0,100,40,0]);
 assert.equal(ads.editorItem.recordedTransactions?.[0].category_id,null);assert.equal(ads.editorItem.recordedTransactions?.[0].raw_gwamok,'');
 assert.equal(JSON.stringify(data),before);
});

test('provisional expense compatibility cannot override explicit bank-only loan evidence for estimated or manual plans',()=>{
 const fee='30000000-0000-4000-8000-000000000004',base=categoryData(personHistory(fee)),categories=[...base.categories,{id:fee,name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true}];
 const manual=edit({id:'manual-loan-guard',source_type:'manual',source_key:'40000000-0000-4000-8000-000000000004',title:'Synthetic recipient',memo:mergeCashPlanCategory('',fee)});
 for(const note of ['', 'Clobe 원본 분류(표시용): 지급수수료']){
  const raw=actual({description:'대여금 · Synthetic recipient',party:'Synthetic recipient',source_details:{counterparty:'Synthetic recipient',note},amount:100});
  const data={...base,categories,bank_plan_actuals:[raw],bank_plan_coverage:[coverage()]},before=JSON.stringify(data);
  assert.deepEqual(review(data).rows.map(item=>[item.recordedAmount,item.remainingAmount]),[[0,100]]);
  assert.deepEqual(review({...data,transactions:[]},[manual]).rows.map(item=>[item.recordedAmount,item.remainingAmount]),[[0,100]]);
  assert.equal(JSON.stringify(data),before);
 }
});

test('unknown ambiguous and non-provider display labels cannot invent a category or select among competing expense groups',()=>{
 const raw=(note:string)=>actual({description:'Synthetic recipient',party:'Synthetic recipient',source_details:{counterparty:'Synthetic recipient',note},amount:40});
 const source=categoryData([...personHistory(),...personHistory(adsCategory,40,'ads')]);
 const cases=[{...source,bank_plan_actuals:[raw('Clobe 원본 분류(표시용): Unknown synthetic category')]},
  {...source,categories:[...source.categories,{id:'30000000-0000-4000-8000-000000000005',name:'광고 선전비',group_name:'영업지출',is_internal:false,is_operating:true}],bank_plan_actuals:[raw('Clobe 원본 분류(표시용): 광고선전비')]},
  {...source,bank_plan_actuals:[raw('User note · Clobe 원본 분류(표시용): 광고선전비')]},
  {...source,bank_plan_actuals:[raw('Clobe 원본 분류(표시용): 광고선전비\nOther note')]}];
 for(const input of cases){
  const data={...input,bank_plan_coverage:[coverage()]},before=JSON.stringify(data),model=review(data);
  assert.deepEqual(model.rows.map(item=>item.recordedAmount),[0,0]);
  assert.equal(model.worksheet.businesses[0].actualOnlyRows[0].categoryId,null);assert.equal(model.worksheet.businesses[0].actualOnlyRows[0].categoryName,'');
  assert.equal(JSON.stringify(data),before);
 }
});

test('saved ledger salary category takes precedence over conflicting provider expense display note',()=>{
 const fee='30000000-0000-4000-8000-000000000004',paid=personRow('saved-salary-note','2027-04-10',100,salaryCategory,{manually_classified:true,source_details:{counterparty:'Synthetic recipient',note:'Clobe 원본 분류(표시용): 지급수수료'}}),base=categoryData([...personHistory(),paid]);
 const data={...base,categories:[...base.categories,{id:fee,name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true}],bank_plan_actuals:[actual({description:'Synthetic recipient',source_details:{counterparty:'Synthetic recipient',note:'Clobe 원본 분류(표시용): 지급수수료'},transaction_id:paid.id,amount:100})],bank_plan_coverage:[coverage()]},before=JSON.stringify(data);
 const model=review(data);
 assert.deepEqual([model.rows[0].recordedAmount,model.rows[0].remainingAmount],[100,0]);
 assert.equal(model.editable.items[0].recordedTransactions?.[0].category_id,salaryCategory);assert.equal(JSON.stringify(data),before);
});

test('category metadata is hidden, retained through memo editing, and invalid or unknown metadata never supplies category evidence',()=>{
 const data=categoryData(personHistory()),stored=mergeCashPlanCategory('Synthetic note',salaryCategory);
 assert.equal(cashPlanMemoDisplay(stored),'Synthetic note');assert.equal(cashPlanUserMemo(stored),'Synthetic note');
 assert.equal(readCashPlanCategory(mergeCashPlanUserMemo(stored,'Changed note'),data.categories)?.categoryId,salaryCategory);
 assert.equal(cashPlanMemoDisplay(mergeCashPlanUserMemo(stored,'')),'');
 for(const invalid of [`${stored}\n${stored}`,`[cash-plan-category:v2:${salaryCategory}]`,`[cash-plan-category:v1:broken]`,`[cash-plan-category]`]){
  assert.ok(cashPlanCategoryMemoError(invalid));assert.equal(readCashPlanCategory(invalid,data.categories),null);assert.doesNotMatch(cashPlanMemoDisplay(invalid),/cash-plan-category/);
 }
 assert.equal(readCashPlanCategory(mergeCashPlanCategory('', '30000000-0000-4000-8000-000000000099'),data.categories),null);
});

test('잔액과 출금 증거 동기화는 추정 원본과 거래 분류를 보존하며 남은 계획만 갱신한다',()=>{
 const original=dataset(),data=dataset({bank_plan_actuals:[actual({amount:70,balance:930})],bank_plan_coverage:[coverage()],balance_snapshots:[{account_id:'a1',business_id:'b1',balance:930,balance_date:asOf,collected_at:collected,synced_at:'2027-04-12T00:01:00Z',source:'clobe',currency:'KRW'}]});
 assert.deepEqual(buildCashEstimateBudgetsForRange(data,range,asOf),buildCashEstimateBudgetsForRange(original,range,asOf));
 const {editable,rows}=review(data,[edit()]);
 assert.deepEqual([rows[0].originalAmount,rows[0].recordedAmount,rows[0].bankRecordedAmount,rows[0].remainingAmount],[100,70,70,30]);
 assert.equal(rows[0].bankEvidence,'bank-query');assert.equal(rows[0].status,'partial');assert.match(rows[0].statusLabel,/은행 조회/);
 assert.equal(rows[0].date,'2027-04-10');assert.equal(rows[0].memo,'Preserved user memo');assert.equal(editable.plan.businesses[0].balance,1930);
 const funding=buildAccountFunding(editable.plan.businesses,new Map(editable.estimates.businesses.map(item=>[item.business.id,item])),'estimated');
 assert.equal(funding[0].accounts[0].expenses,30);
 const report=buildFundingReport(editable.plan.businesses,new Map(editable.estimates.businesses.map(item=>[item.business.id,item])),'estimated',range,asOf);assert.equal(report.businesses[0].funding.accounts[0].expenses,30);
 assert.equal(data.transactions.length,3);assert.equal(data.transactions[0].category_id,'fees');
});

test('동일 provider 참조와 나중에 저장한 원장은 한 번만 차감하고 직접 확인도 중복하지 않는다',()=>{
 const saved=row('saved','2027-04-10',70),raw=actual({amount:70,balance:900,transaction_id:'saved'}),confirmed=edit({confirmed_amount:70,confirmed_date:'2027-04-10',confirmation_complete:false});
 const data=dataset({transactions:[...history,saved],bank_plan_actuals:[raw],bank_plan_coverage:[coverage()]});
 const {rows}=review(data,[confirmed]);assert.deepEqual([rows[0].recordedAmount,rows[0].bankRecordedAmount,rows[0].remainingAmount],[70,70,30]);
 const later=review({...data,bank_plan_actuals:[{...raw,transaction_id:null}]}).rows[0];assert.equal(later.recordedAmount,70);assert.equal(later.remainingAmount,30);
 const complete=review(data,[{...confirmed,confirmation_complete:true}]).rows[0];assert.equal(complete.status,'confirmed');assert.equal(complete.remainingAmount,0);
});

test('원장 참조 ID의 금융값 충돌·새 원본 중복·구별 불가능한 후보는 새 실적을 만들지 않는다',()=>{
 const saved=row('saved','2027-04-10',100,{balance:900});
 for(const observations of [[actual({transaction_id:'saved',balance:800})],[actual(),actual({amount:200})],[actual(),actual({external_transaction_id:'124'})]]){
  const data=dataset({transactions:[...history,saved],bank_plan_actuals:observations,bank_plan_coverage:[coverage()]});
  const union=unionBankPlanTransactions(data,asOf);assert.equal(union.rows.length,4);assert.equal(union.bankById.size,0);assert.ok(union.blocked.length>0);
  const {rows}=review(data);assert.equal(rows[0].recordedAmount,100);assert.equal(rows[0].status,'confirmation-needed');
 }
 const ambiguous=dataset({transactions:[...history,saved,row('saved-2','2027-04-10',100)],bank_plan_actuals:[actual()],bank_plan_coverage:[coverage()]});
 assert.equal(unionBankPlanTransactions(ambiguous,asOf).rows.length,5);
});

test('provider ID가 정확하면 없는 시간·잔액을 추측하지 않고 원장과 동일 건으로 연결한다',()=>{
 const data=dataset({transactions:[...history,row('saved','2027-04-10',100,{txn_time:null,balance:null})],bank_plan_actuals:[actual({transaction_id:'saved'})],bank_plan_coverage:[coverage()]});
 assert.equal(review(data).rows[0].recordedAmount,100);assert.equal(review(data).rows[0].bankRecordedAmount,100);
 const noRef=review({...data,bank_plan_actuals:[actual()]});assert.equal(noRef.rows[0].recordedAmount,100);assert.equal(noRef.rows[0].bankRecordedAmount,0);assert.equal(noRef.rows[0].status,'confirmation-needed');
});

test('다른 통장·다른 달·미래 거래·다른 수집 batch와 잘못된 권한·통화는 연결하지 않는다',()=>{
 const invalid=[actual({account_id:'a2'}),actual({txn_date:'2027-05-10'}),actual({txn_date:'2027-04-13'}),actual({collected_at:'2027-04-11T09:00:00+09:00'}),actual({business_id:'different-company'}),actual({currency:'USD' as 'KRW'})];
 const {rows}=review(dataset({bank_plan_actuals:invalid,bank_plan_coverage:[coverage()]}));assert.equal(rows[0].recordedAmount,0);assert.equal(rows[0].remainingAmount,100);
 assert.equal(normalizeBankPlanDataset(dataset({bank_plan_actuals:invalid})).bank_plan_actuals?.length,4);
});

test('은행 기본·세부 내역은 정확한 원본 예산에만 연결하고 편집 계좌·품목을 바꾸지 않는다',()=>{
 const originalLabel='SYNTHETIC INS002',source=history.map(item=>({...item,description:originalLabel,source_details:{basic:originalLabel}})),saved=edit({source_key:cashEstimateSourceKey(source[0]),account_id:'a2',title:'Edited insurance title',amount:120});
 const raw=actual({description:'Synthetic insurer · SYNTHETIC INS002',source_details:{basic:'Synthetic insurer',detail:originalLabel},amount:90});
 const {rows,editable}=review(dataset({transactions:source,bank_plan_actuals:[raw],bank_plan_coverage:[coverage()]}),[saved]);
 assert.equal(rows[0].recordedAmount,90);assert.equal(rows[0].remainingAmount,30);assert.equal(rows[0].accountId,'a2');assert.equal(rows[0].sourceAccountId,'a1');assert.equal(rows[0].title,saved.title);
 const funding=buildAccountFunding(editable.plan.businesses,new Map(editable.estimates.businesses.map(item=>[item.business.id,item])),'estimated');assert.equal(funding[0].accounts[0].expenses,0);assert.equal(funding[0].accounts[1].expenses,30);
});

test('단일 정확한 직접 추가·등록 품목은 관측 출금에 연결하며 세금은 사용자 납부 상태를 유지한다',()=>{
 const manual=edit({source_type:'manual',source_key:'m1',title:'Synthetic payroll recipient',amount:150});
 const data=dataset({transactions:[],bank_plan_actuals:[actual({description:manual.title,source_details:{basic:manual.title},amount:100})],bank_plan_coverage:[coverage()]});
 const {rows}=review(data,[manual]);assert.equal(rows[0].recordedAmount,100);assert.equal(rows[0].remainingAmount,50);
 const registeredData={...data,recurring:[{id:'r1',business_id:'b1',title:manual.title,amount:150,direction:'out' as const,day:10,start_date:'2027-01-01',end_date:null,frequency:'monthly' as const}]};
 const registered=review(registeredData,[edit({source_type:'registered',source_key:'r1',title:manual.title,amount:150})],'registered');
 assert.equal(registered.rows[0].recordedAmount,100);assert.equal(registered.editable.plan.businesses[0].undatedExpenses?.[0].amount,50);assert.equal(registered.rows[0].date,'2027-04-10');
 assert.ok(buildCurrentCashForecast(registered.editable.plan).every(point=>point.b1===null));
 const tax=review(data,[{...manual,payment_kind:'tax',payment_status:'pending'}]).rows[0];assert.equal(tax.recordedAmount,null);assert.equal(tax.remainingAmount,150);
 const paidTax=review(data,[{...manual,payment_kind:'tax',payment_status:'paid'}]).rows[0];assert.equal(paidTax.status,'paid');assert.equal(paidTax.remainingAmount,0);
});

test('중복 계획 후보에는 두 번 차감하지 않으며 제외한 원본을 직접 품목으로 대체할 수 있다',()=>{
 const data=dataset({bank_plan_actuals:[actual()],bank_plan_coverage:[coverage()]}),manual=edit({id:'m1',source_type:'manual',source_key:'m1',title:'Synthetic service'});
 const duplicate=review(data,[manual]);assert.equal(duplicate.rows.length,2);assert.ok(duplicate.rows.every(item=>item.status==='confirmation-needed'&&item.remainingAmount===100));
 const replaced=review(data,[edit({excluded:true}),manual]);assert.equal(replaced.rows.length,1);assert.equal(replaced.rows[0].recordedAmount,100);assert.equal(replaced.rows[0].remainingAmount,0);
 const twoManual=review(dataset({transactions:[],bank_plan_actuals:[actual()],bank_plan_coverage:[coverage()]}),[manual,{...manual,id:'m2',source_key:'m2'}]);assert.ok(twoManual.rows.every(item=>item.status==='confirmation-needed'&&item.remainingAmount===100));
});

test('부분 기간은 같은 기간 실적만 차감하며 다른 provider의 구별된 출금은 모두 보존한다',()=>{
 const data=dataset({transactions:history.map(item=>({...item,txn_date:item.txn_date.slice(0,8)+'01'})),bank_plan_actuals:[actual({external_transaction_id:'before',txn_date:'2027-04-02',amount:30,balance:970}),actual({external_transaction_id:'within',txn_date:'2027-04-10',amount:30,balance:940})],bank_plan_coverage:[coverage()]});
 const {rows}=review(data,[edit({plan_date:null,amount:300})],'estimated',{from:'2027-04-08',to:'2027-04-12'});assert.equal(rows[0].originalAmount,50);assert.equal(rows[0].recordedAmount,30);assert.equal(rows[0].remainingAmount,20);assert.equal(rows[0].bankRecordedAmount,30);
 const full=review(data,[edit({plan_date:null,amount:300})]);assert.equal(full.rows[0].recordedAmount,60);
});

test('다음 달 조회와 실패한 최신 시도는 이전 월의 관측 지급을 되돌리지 않는다',()=>{
 const old=actual(),oldCoverage=coverage({status:'confirmation-needed',reason:'Source unavailable'}),newCollected='2027-05-05T09:00:00+09:00';
 const data=dataset({bank_plan_actuals:[old,actual({external_transaction_id:'may-1',txn_date:'2027-05-02',collected_at:newCollected})],bank_plan_coverage:[oldCoverage,coverage({from:'2027-05-01',to:'2027-05-05',collected_at:newCollected})]});
 const {rows}=review(data,[],'estimated',range,'2027-05-05');assert.equal(rows[0].recordedAmount,100);assert.equal(rows[0].remainingAmount,0);assert.equal(rows[0].bankRecordedAmount,100);assert.equal(rows[0].bankCoverage,'confirmation-needed');
 assert.equal(review(data,[edit({confirmation_complete:true,confirmed_amount:100,confirmed_date:'2027-04-10'})],'estimated',range,'2027-05-05').rows[0].status,'confirmed');
});

test('잔액 스냅샷만으로 출금이나 generic 직접 품목의 지급을 추정하지 않는다',()=>{
 const source=dataset({balance_snapshots:[{account_id:'a1',business_id:'b1',balance:100,balance_date:asOf,collected_at:collected,synced_at:'2027-04-12T00:01:00Z',source:'clobe',currency:'KRW'}]});
 assert.equal(review(source).rows[0].recordedAmount,0);assert.equal(review(source).rows[0].remainingAmount,100);
 const manual=edit({source_type:'manual',source_key:'generic',title:'급여'}),generic=review({...source,bank_plan_coverage:[coverage()]},[manual]).rows.find(item=>item.sourceType==='manual')!;
 assert.equal(generic.recordedAmount,null);assert.equal(generic.status,'confirmation-needed');
});

test('미수집 계좌는 확인 필요지만 미래 월과 확실한 원장 실적은 기존 상태를 유지한다',()=>{
 const elsewhere=coverage({account_id:'a2'}),data=dataset({bank_plan_coverage:[elsewhere]});
 const current=review(data).rows[0];assert.equal(current.status,'confirmation-needed');assert.match(current.reconciliationReason??'',/조회하지 못했습니다/);assert.equal(current.remainingAmount,100);
 const ledger=review({...data,transactions:[...history,row('paid','2027-04-10',100)]}).rows[0];assert.equal(ledger.status,'spent');assert.equal(ledger.recordedAmount,100);assert.equal(ledger.reconciliationReason,null);
 const future=review(data,[],'estimated',{from:'2027-05-01',to:'2027-05-31'}).rows[0];assert.equal(future.status,'pending');assert.equal(future.reconciliationReason,null);
 const oldProof=review(dataset({bank_plan_actuals:[actual()],bank_plan_coverage:[coverage({status:'confirmation-needed',reason:'Source failure'})]})).rows[0];assert.equal(oldProof.remainingAmount,0);assert.equal(oldProof.status,'spent');assert.equal(oldProof.bankRecordedAmount,100);
});

test('긴 은행 합성 적요는 보존하고 잘못된 관측 행을 버리면 조회 완료로 간주하지 않는다',()=>{
 for(const length of [2003,8003]){
  const description='X'.repeat(length),source=dataset({bank_plan_actuals:[actual({description,source_details:{basic:'Synthetic service',detail:'D'.repeat(1000)}})],bank_plan_coverage:[coverage()]});
  const normalized=normalizeBankPlanDataset(source);assert.equal(normalized.bank_plan_actuals?.[0].description,description);assert.equal(normalized.bank_plan_coverage?.[0].status,'complete');
  assert.equal(review(source).rows[0].bankRecordedAmount,100);assert.equal(source.transactions.length,3);
 }
 for(const observation of [actual({description:'X'.repeat(8004)}),actual({source_details:{basic:'Synthetic service',detail:'D'.repeat(1001)}})]){
  const source=dataset({bank_plan_actuals:[observation],bank_plan_coverage:[coverage()]}),normalized=normalizeBankPlanDataset(source);
  assert.equal(normalized.bank_plan_actuals?.length,0);assert.equal(normalized.bank_plan_coverage?.[0].status,'confirmation-needed');
  const view=review(source).rows[0];assert.equal(view.recordedAmount,0);assert.equal(view.remainingAmount,100);assert.equal(view.status,'confirmation-needed');
  assert.equal(source.bank_plan_coverage?.[0].status,'complete');
 }
});
