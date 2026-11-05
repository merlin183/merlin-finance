import assert from 'node:assert/strict';
import test from 'node:test';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {buildFundingTimeline} from '../lib/finance/funding-timeline';
import {buildCurrentCashForecast} from '../lib/finance/cash-plan';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {emptyDataset,type Dataset} from '../lib/finance/types';

const data:Dataset={...emptyDataset,businesses:[{id:'b1',name:'합성 사업자',representative:'',kind:'법인',reserve:0,color:'#123456'}],accounts:[{id:'a1',business_id:'b1',name:'합성 계좌',bank:'합성 은행',masked_number:'0001',opening_balance:1000,opening_balance_date:'2027-03-31'}]};
const range={from:'2027-04-01',to:'2027-04-30'};
const tax:CashPlanEdit={id:'synthetic-tax',business_id:'b1',source_type:'manual',source_key:'synthetic-tax',month:'2027-04',title:'합성 세금 납부',account_id:'a1',plan_date:'2027-04-07',amount:1500,memo:'합성 납부서 확인',excluded:false,payment_kind:'tax',payment_status:'pending',version:1,updated_at:'2027-03-20T00:00:00Z'};
const build=(asOf='2027-04-01',edits=[tax])=>buildEditableCashPlan(data,range,asOf,edits);
const funds=(model:ReturnType<typeof build>,basis:'estimated'|'registered')=>buildAccountFunding(model.plan.businesses,new Map(model.estimates.businesses.map(item=>[item.business.id,item])),basis);

test('tax is counted once in both bases and preserves the explicit deadline and account metadata',()=>{
 const before=JSON.stringify({data,tax}),model=build();
 assert.equal(model.items.length,1);assert.equal(model.items[0].paymentKind,'tax');assert.equal(model.items[0].paymentStatus,'pending');
 assert.equal(model.estimates.businesses[0].total,1500);assert.equal(model.plan.businesses[0].expenses,1500);
 for(const basis of ['estimated','registered'] as const){
  const funding=funds(model,basis)[0];
  assert.equal(funding.expenses,1500);assert.equal(funding.requiredTopUp,500);
  assert.equal(funding.accounts[0].items[0].date,'2027-04-07');assert.equal(funding.accounts[0].items[0].paymentKind,'tax');
 }
 assert.equal(JSON.stringify({data,tax}),before);
});

test('an overdue pending tax remains dated and budgeted until explicitly paid',()=>{
 const model=build('2027-04-09');
 assert.equal(model.items[0].remainingAmount,1500);assert.equal(model.items[0].paymentStatus,'pending');
 assert.equal(model.estimates.businesses[0].dated[0].date,'2027-04-07');assert.equal(model.estimates.businesses[0].undated.length,0);
 assert.equal(model.plan.businesses[0].scheduledExpenses[0].date,'2027-04-07');assert.equal(model.plan.businesses[0].expenses,1500);
 for(const basis of ['estimated','registered'] as const){
  const funding=funds(model,basis);
  assert.equal(funding[0].requiredTopUp,500,'whole remaining obligation is not silently lost');
  const timeline=buildFundingTimeline(funding,range,'2027-04-09');
  assert.equal(timeline.unknownAccountCount,1);assert.equal(timeline.days[0].cumulativeTopUp,null,'do not invent a new due date');
 }
 assert.ok(buildCurrentCashForecast(model.plan).every(point=>point.b1===null));
});

test('explicitly paid tax is retained for correction but excluded from cash totals and occurrences',()=>{
 const paid={...tax,payment_status:'paid' as const,version:2};
 const model=build('2027-04-09',[paid]);
 assert.equal(model.items.length,1);assert.equal(model.items[0].paymentStatus,'paid');assert.equal(model.items[0].amount,1500);assert.equal(model.items[0].remainingAmount,0);
 assert.equal(model.plan.businesses[0].expenses,0);assert.equal(model.plan.businesses[0].scheduledExpenses.length,0);
 assert.equal(model.estimates.businesses[0].total,0);assert.equal(model.estimates.businesses[0].dated.length,0);
 for(const basis of ['estimated','registered'] as const)assert.equal(funds(model,basis)[0].expenses,0);
 const restored=build('2027-04-09',[{...paid,payment_status:'pending',version:3}]);
 assert.equal(restored.plan.businesses[0].expenses,1500);assert.equal(restored.items[0].paymentStatus,'pending');
});

test('one-time taxes respect the selected period without changing earlier plans or inventing a withdrawal bank',()=>{
 const earlier={from:'2027-03-01',to:'2027-03-31'};
 const before=buildEditableCashPlan(data,earlier,'2027-03-20',[]),after=buildEditableCashPlan(data,earlier,'2027-03-20',[tax]);
 assert.deepEqual(after,before);
 const later=buildEditableCashPlan(data,{from:'2027-05-01',to:'2027-05-31'},'2027-04-01',[tax]);
 assert.equal(later.items.length,0);assert.equal(later.estimates.businesses[0].total,0);
 const unassigned=build('2027-04-01',[{...tax,account_id:null}]);
 for(const basis of ['estimated','registered'] as const){
  const funding=funds(unassigned,basis)[0];
  assert.equal(funding.unassignedExpenses,1500);assert.equal(funding.requiredTopUp,null);assert.equal(funding.unassignedItems[0].paymentKind,'tax');
 }
});
