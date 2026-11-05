import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCashEstimateBudgetsForRange,cashEstimateRecordedTransactions,cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';

const range={from:'2027-04-01',to:'2027-04-30'},asOf='2027-04-03',label='Synthetic original service';
const row=(id:string,date:string,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',txn_date:date,amount:100,balance:null,direction:'out',description:label,upload_id:null,raw_gwamok:'',category_id:'fees',is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const composite=(id:string,date:string,extra:Partial<Transaction>={})=>row(id,date,{description:`Synthetic provider · ${label}`,source_details:{basic:'Synthetic provider',detail:label},...extra});
const history=()=>[row('jan','2027-01-02'),row('feb','2027-02-02'),composite('mar','2027-03-02')];
const dataset=(transactions:Transaction[]):Dataset=>({...emptyDataset,businesses:[{id:'b1',name:'Synthetic business',kind:'법인',representative:'',reserve:0,color:'#123456'}],accounts:[{id:'a1',business_id:'b1',name:'Synthetic account',bank:'Synthetic bank',masked_number:'001',opening_balance:1000,opening_balance_date:'2027-03-31'},{id:'a2',business_id:'b1',name:'Other synthetic account',bank:'Synthetic bank',masked_number:'002',opening_balance:0,opening_balance_date:'2027-03-31'}],categories:[{id:'fees',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true},{id:'loan',name:'대여금',group_name:'내부이동',is_internal:true,is_operating:false}],transactions});
const sourceKey=cashEstimateSourceKey(row('source','2027-01-02'));
const edit=(extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:'saved',business_id:'b1',source_type:'estimated',source_key:sourceKey,month:'2027-04',title:'User edited title',account_id:'a1',plan_date:null,amount:200,memo:'User memo',excluded:false,version:1,updated_at:'2027-03-31T00:00:00Z',...extra});
function recorded(data:Dataset,keys:Iterable<string>=[sourceKey]){
 const original=buildCashEstimateBudgetsForRange(data,range,asOf);
 return cashEstimateRecordedTransactions(data,asOf,{},original,keys);
}
const currentIds=(data:Dataset,keys:Iterable<string>=[sourceKey])=>(recorded(data,keys).get(sourceKey)??[]).filter(item=>item.txn_date.startsWith('2027-04')).map(item=>item.id);

test('a saved description budget survives rolling-history exclusions and receives each exact composite payment once',()=>{
 const data=dataset([...history(),composite('paid-one','2027-04-02',{amount:30}),composite('paid-two','2027-04-02',{amount:20})]),saved=edit();
 data.bank_plan_coverage=[{business_id:'b1',account_id:'a1',from:range.from,to:asOf,collected_at:'2027-04-03T09:00:00+09:00',synced_at:'2027-04-03T00:01:00Z',status:'complete',reason:null,source:'clobe',currency:'KRW'}];
 data.bank_plan_actuals=data.transactions.filter(item=>item.txn_date.startsWith('2027-04')).map((item,index)=>({business_id:item.business_id,account_id:item.account_id,external_transaction_id:String(100+index),txn_date:item.txn_date,txn_time:'12:00:00',amount:item.amount,balance:null,description:item.description,party:null,source_details:item.source_details??null,collected_at:'2027-04-03T09:00:00+09:00',synced_at:'2027-04-03T00:01:00Z',source:'clobe',currency:'KRW',transaction_id:item.id}));
 const before=JSON.stringify({data,saved});
 const original=buildCashEstimateBudgetsForRange(data,range,asOf);
 assert.equal(original.businesses[0].groups.length,0);
 assert.equal(original.businesses[0].exclusions.length,2);
 assert.deepEqual(currentIds(data),['paid-one','paid-two']);
 const plan=buildEditableCashPlan(data,range,asOf,[saved]);
 assert.equal(plan.items.length,1);
 assert.deepEqual([plan.items[0].amount,plan.items[0].recordedAmount,plan.items[0].remainingAmount],[200,50,150]);
 assert.deepEqual(plan.items[0].recordedTransactions?.filter(item=>item.txn_date.startsWith('2027-04')).map(item=>item.id),['paid-one','paid-two']);
 assert.equal(plan.items[0].bankTransactionIds?.length,2);
 assert.equal(plan.items[0].title,saved.title);assert.equal(plan.items[0].memo,saved.memo);
 assert.equal(JSON.stringify({data,saved}),before);
});

test('saved or active composite identities retain priority over an older short description budget',()=>{
 const data=dataset([...history(),composite('paid','2027-04-02')]),compositeKey=cashEstimateSourceKey(data.transactions[2]);
 assert.deepEqual(currentIds(data,[sourceKey,compositeKey]),[]);
 assert.deepEqual((recorded(data,[sourceKey,compositeKey]).get(compositeKey)??[]).filter(item=>item.txn_date.startsWith('2027-04')).map(item=>item.id),['paid']);
 const active=dataset([row('jan','2027-01-02'),composite('feb','2027-02-02'),composite('mar','2027-03-02'),composite('paid','2027-04-02')]);
 assert.equal(buildCashEstimateBudgetsForRange(active,range,asOf).businesses[0].groups.length,1);
 assert.deepEqual(currentIds(active),[]);
});

test('a saved label alone is not evidence when its historical exact owner is absent',()=>{
 const data=dataset([row('outside-basis','2026-12-02'),composite('mar','2027-03-02'),composite('paid','2027-04-02')]);
 assert.deepEqual(currentIds(data),[]);
 for(const invalid of ['not-json',JSON.stringify(['b1','a1','counterparty:synthetic original service']),JSON.stringify(['b1','a1','description:급여'])]){
  assert.deepEqual(currentIds(dataset([...history(),composite('paid','2027-04-02')]),[invalid]),[]);
 }
});

test('a second historical owner or a second composite provider prevents saved-label bridging',()=>{
 for(const conflict of [
  row('party-history','2027-02-15',{description:'Another source',source_details:{detail:label,counterparty:'Synthetic other party'}}),
  row('description-history','2027-02-15',{description:'Another source',source_details:{detail:label}}),
  composite('provider-history','2027-02-15',{description:`Different provider · ${label}`,source_details:{basic:'Different provider',detail:label}}),
  composite('provider-current','2027-04-01',{description:`Different provider · ${label}`,source_details:{basic:'Different provider',detail:label}}),
 ])assert.deepEqual(currentIds(dataset([...history(),conflict,composite('paid','2027-04-02')])),[]);
});

test('source scopes and normal outflow exclusions still bound the persisted source bridge',()=>{
 const valid=composite('valid','2027-04-02',{amount:20}),data=dataset([...history(),valid,
  composite('other-account','2027-04-02',{account_id:'a2'}),composite('other-business','2027-04-02',{business_id:'b2'}),
  composite('incoming','2027-04-02',{direction:'in'}),composite('internal','2027-04-02',{is_internal:true}),
  composite('loan','2027-04-02',{category_id:'loan'}),composite('future','2027-04-04'),composite('linked','2027-04-02'),
 ]);data.links=[{id:'link',out_transaction_id:'linked',in_transaction_id:'other'}];
 assert.deepEqual(currentIds(data),['valid']);
 const original=buildCashEstimateBudgetsForRange(data,range,asOf);
 const excluded=cashEstimateRecordedTransactions(data,asOf,{excludedBusinessCategories:[{businessId:'b1',categoryId:'fees'}]},original,[sourceKey]);
 assert.equal(excluded.has(sourceKey),false);
 assert.ok([...excluded.values()].flat().every(item=>item.business_id==='b2'));
});

test('a missing bank label, loose substring, non-composite history, or conflicting source fields cannot bridge a saved key',()=>{
 for(const extra of [
  {source_details:null},
  {source_details:{memo:label,note:label}},
  {source_details:{detail:'Synthetic original'}},
  {description:'Unrelated narrative',source_details:{basic:'Synthetic provider',detail:label}},
 ]){
  // Such a row also cannot use its own exclusion key to bypass the evidence guard.
  const changed=composite('mar','2027-03-02',extra),data=dataset([row('jan','2027-01-02'),row('feb','2027-02-02'),changed,{...changed,id:'paid',txn_date:'2027-04-02'}]);
  assert.deepEqual(currentIds(data),[]);
 }
 const otherLabel='Other synthetic service',otherKey=cashEstimateSourceKey(row('other','2027-01-01',{description:otherLabel}));
 const ambiguous=dataset([...history(),row('other-history','2027-01-01',{description:otherLabel}),composite('paid','2027-04-02',{description:`${otherLabel} · ${label}`,source_details:{basic:otherLabel,detail:label}})]);
 assert.deepEqual(currentIds(ambiguous,[sourceKey,otherKey]),[]);
});

test('an excluded saved source remains excluded and is not recreated by bank-label changes',()=>{
 const data=dataset([...history(),composite('paid','2027-04-02',{amount:50})]),before=JSON.stringify(data);
 const result=buildEditableCashPlan(data,range,asOf,[edit({excluded:true})]);
 assert.equal(result.items.length,1);assert.equal(result.items[0].excluded,true);assert.equal(result.items[0].remainingAmount,0);
 assert.equal(result.estimates.businesses[0].total,0);assert.equal(JSON.stringify(data),before);
});
