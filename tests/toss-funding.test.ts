import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {tossFundingIncome,tossCashForecastPlan} from '../lib/finance/toss-funding';
import {buildAccountFunding,type AccountFundingIncome} from '../lib/finance/account-funding';
import {buildFundingTimeline} from '../lib/finance/funding-timeline';
import {buildFundingReport} from '../lib/finance/funding-report';
import {buildCashPlan,buildCurrentCashForecast} from '../lib/finance/cash-plan';
import {CashPlanWorksheet} from '../components/finance/cash-plan-worksheet';
import {buildLatestCashBalances} from '../lib/finance/latest-cash-balances';
import {emptyDataset,type Dataset} from '../lib/finance/types';
import type {TossSettlementGroup} from '../lib/toss/types';

const asOf='2027-03-31',range={from:'2027-04-01',to:'2027-04-30'};
const data:Dataset={...emptyDataset,businesses:[{id:'business',name:'합성 사업자',representative:'',kind:'법인',reserve:0,color:'#123456'}],accounts:[{id:'account',business_id:'business',name:'합성 통장',bank:'합성 은행',masked_number:'0001',opening_balance:100,opening_balance_date:asOf}],recurring:[
 {id:'early',business_id:'business',title:'합성 이른 지출',amount:200,direction:'out',day:5,start_date:range.from,end_date:null,frequency:'monthly'},
 {id:'late',business_id:'business',title:'합성 뒤 지출',amount:300,direction:'out',day:15,start_date:range.from,end_date:null,frequency:'monthly'},
]};
const receipt:AccountFundingIncome={key:'synthetic',businessId:'business',accountId:'account',date:'2027-04-10',amount:300,title:'토스 정산 입금'};
const plan=()=>({...buildCashPlan(data,asOf),businesses:buildCashPlan(data,asOf).businesses.map(item=>({...item,scheduledExpenses:item.scheduledExpenses.map(expense=>({...expense,accountId:'account'}))}))});
const group=(id:string,date:string,status:TossSettlementGroup['status']='pending'):TossSettlementGroup=>({id,businessId:'business',accountId:'account',date,merchantIds:['synthetic-mid'],amount:300,receivedAmount:status==='received'?300:0,pendingAmount:300,status,matchedTransactionIds:[],reason:null});

test('정산은 미래 미입금만 계획에 반영하고 과거·입금완료·조회범위 밖·중복 ID는 제외한다',()=>{
 const rows=[group('future','2027-04-10'),group('future','2027-04-10'),group('received','2027-04-11','received'),group('past','2027-03-30'),group('today',asOf),group('later','2027-05-01'),group('check','2027-04-12','confirmation-needed')];
 const incoming=tossFundingIncome(rows,range,asOf);
 assert.deepEqual(incoming,[{key:'future',businessId:'business',accountId:'account',date:'2027-04-10',title:'토스 정산 입금',amount:300}]);
});

test('뒤에 들어올 정산금으로 앞선 부족액을 지우지 않고 같은 부족액을 재요청하지 않는다',()=>{
 const source=plan();
 const funding=buildAccountFunding(source.businesses,new Map(),'registered',[receipt]);
 const account=funding[0].accounts[0];
 assert.equal(account.snapshot.balance,100);assert.equal(account.afterExpenses,-400);assert.equal(account.afterIncome,-100);
 assert.equal(account.requiredTopUp,100);assert.equal(account.firstDatedShortfall,'2027-04-05');
 const timeline=buildFundingTimeline(funding,range,asOf);
 const fifth=timeline.days.find(day=>day.date==='2027-04-05')!,tenth=timeline.days.find(day=>day.date==='2027-04-10')!,fifteenth=timeline.days.find(day=>day.date==='2027-04-15')!;
 assert.equal(fifth.additionalTopUp,100);assert.equal(fifth.accounts[0].projectedBalance,-100);
 assert.equal(tenth.income,300);assert.equal(tenth.cumulativeTopUp,100);assert.equal(tenth.accounts[0].projectedBalance,200);
 assert.equal(fifteenth.additionalTopUp,0);assert.equal(fifteenth.cumulativeTopUp,100);
 assert.equal(timeline.days.reduce((sum,day)=>sum+(day.additionalTopUp??0),0),100);
 const report=buildFundingReport(source.businesses,new Map(),'registered',range,asOf,[receipt]);
 assert.equal(report.requiredTopUp,100);assert.equal(report.datedRequiredTopUp,100);assert.deepEqual(report.businesses[0].rows.map(row=>row.date),['2027-04-05']);
});

test('정산이 다른 계좌나 사업자의 지출을 상계하지 않는다',()=>{
 const source=plan();
 const other={...source.businesses[0].accounts[0],account:{...data.accounts[0],id:'other-account'}};
 source.businesses[0].accounts.push(other);
 const funding=buildAccountFunding(source.businesses,new Map(),'registered',[{...receipt,accountId:'other-account'}]);
 assert.equal(funding[0].accounts.find(item=>item.account.id==='account')!.requiredTopUp,400);
 assert.equal(funding[0].accounts.find(item=>item.account.id==='other-account')!.requiredTopUp,0);
 assert.equal(funding[0].requiredTopUp,400);
});

test('이미 같은 수입이 등록되어 있어도 토스 그래프 시나리오는 한 번만 더하고 기존 계획은 유지한다',()=>{
 const source=plan();source.businesses[0].scheduledIncome=[{date:receipt.date,title:'합성 수동 수입',amount:300,direction:'in',frequency:'once',recurringId:'manual-income',businessId:'business'}];
 source.businesses[0].income=300;
 const provider=tossCashForecastPlan(source,[receipt]);
 assert.equal(source.businesses[0].scheduledIncome[0].recurringId,'manual-income');assert.equal(provider.businesses[0].scheduledIncome.length,1);
 const graph=buildCurrentCashForecast(provider);
 assert.equal(graph.find(day=>day.date==='2027-04-10')!.business,200);
 assert.equal(provider.businesses[0].balance,100);
});

test('지출계획표는 현재 잔액과 기존 가용자금을 보존하고 정산 반영 금액을 별도로 표시한다',()=>{
 const source=plan(),latest=new Map(buildLatestCashBalances(data,asOf).businesses.map(item=>[item.business.id,item]));
 const html=renderToStaticMarkup(createElement(CashPlanWorksheet,{plans:source.businesses,estimates:new Map(),worksheetBusinesses:new Map(),latestBalances:latest,basis:'registered',selectedBusiness:'',onOpenDetail:()=>{},onEditBusiness:()=>{},settlementIncome:new Map([['business',300]])}));
 assert.match(html,/현재 기록 잔액[\s\S]*?>100<\/dd>/);assert.match(html,/토스 입금 예정<\/dt><dd>\+300/);
 assert.match(html,/가용자금 [\s\S]*?-400<\/dd>/);assert.match(html,/정산 반영 가용자금<\/dt><dd[^>]*>-100<\/dd>/);
 assert.equal(source.businesses[0].balance,100);
});
