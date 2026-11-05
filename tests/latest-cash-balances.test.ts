import test from 'node:test';
import assert from 'node:assert/strict';
import {accountBalanceRecordLabel,balanceCollectedTimeLabel,buildLatestCashBalances,latestAccountBalanceRows,latestBalanceRecordLabel,type LatestCashBusiness} from '../lib/finance/latest-cash-balances';
import {buildCashPlanForRange} from '../lib/finance/cash-plan';
import {buildCashEstimatesForRange} from '../lib/finance/cash-estimates';
import {buildFundingReport} from '../lib/finance/funding-report';
import {DEFAULT_CASH_PLAN_PERIOD} from '../lib/finance/cash-plan-period';
import {emptyDataset,type Account,type Dataset,type Transaction} from '../lib/finance/types';

const account=(id:string,extra:Partial<Account>={}):Account=>({id,business_id:'b1',name:`합성 통장 ${id}`,bank:'합성 은행',masked_number:'0000',opening_balance:100,opening_balance_date:'2026-01-01',...extra});
const row=(id:string,date:string,amount:number,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',upload_id:null,txn_date:date,amount,direction:'out',description:'합성 서비스',balance:null,raw_gwamok:'',category_id:'fee',is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const dataset=(extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,
 businesses:[{id:'b1',name:'합성 사업자',kind:'법인',representative:'',reserve:0,color:'#123456'}],
 accounts:[account('a1')],categories:[{id:'fee',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true}],...extra});

test('최신 동기화 전후 현재 잔액만 바뀌고 고정 기간·계획 기준 잔액·반복 추정·필요액은 유지된다',()=>{
 const original=dataset({transactions:[...['07','08','09'].map(month=>row(`repeat-${month}`,`2026-${month}-01`,80)),row('closing','2026-09-30',1,{direction:'in',balance:100})],recurring:[{id:'r1',business_id:'b1',title:'합성 월초 일정',amount:80,direction:'out',day:1,start_date:'2026-01-01',end_date:null,frequency:'monthly'}]});
 const updated={...original,transactions:[...original.transactions,row('new-income','2026-10-02',200,{direction:'in',balance:300})]};
 const before=JSON.stringify(original),after=JSON.stringify(updated);
 const currentBefore=buildLatestCashBalances(original,'2026-10-02').businesses[0];
 const currentAfter=buildLatestCashBalances(updated,'2026-10-02').businesses[0];
 assert.equal(currentBefore.balance,100);assert.equal(currentAfter.balance,300);
 assert.equal(currentBefore.lastRecordDate,'2026-09-30');assert.equal(currentAfter.lastRecordDate,'2026-10-02');
 const oldPlan=buildCashPlanForRange(original,DEFAULT_CASH_PLAN_PERIOD),newPlan=buildCashPlanForRange(updated,DEFAULT_CASH_PLAN_PERIOD);
 assert.deepEqual(newPlan,oldPlan);assert.equal(newPlan.businesses[0].balance,100);assert.equal(newPlan.businesses[0].afterExpenses,20);
 const oldEstimates=buildCashEstimatesForRange(original,DEFAULT_CASH_PLAN_PERIOD),newEstimates=buildCashEstimatesForRange(updated,DEFAULT_CASH_PLAN_PERIOD);
 assert.deepEqual(newEstimates,oldEstimates);assert.equal(newEstimates.businesses[0].dated[0].date,'2026-10-01');
 const report=(data:Dataset)=>{const plan=buildCashPlanForRange(data,DEFAULT_CASH_PLAN_PERIOD),estimates=buildCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD);return buildFundingReport(plan.businesses,new Map(estimates.businesses.map(item=>[item.business.id,item])),'estimated',plan.range);};
 assert.deepEqual(report(updated),report(original));
 assert.equal(JSON.stringify(original),before);assert.equal(JSON.stringify(updated),after);
});

test('현재 잔액은 원본 순서가 아닌 연결되는 당일 최종 잔액을 쓰고 사업자 통장을 합산한다',()=>{
 const data=dataset({accounts:[account('a1'),account('a2',{opening_balance:70})],transactions:[
  row('withdrawal','2026-10-02',20,{balance:130}),row('income','2026-10-02',50,{direction:'in',balance:150}),
  row('other-account','2026-10-01',30,{account_id:'a2'}),
 ]});
 const result=buildLatestCashBalances(data,'2026-10-02').businesses[0];
 assert.deepEqual(result.accounts.map(item=>[item.snapshot.balance,item.snapshot.source,item.snapshot.date]),[[130,'statement','2026-10-02'],[40,'calculated','2026-10-01']]);
 assert.equal(result.balance,170);assert.equal(result.knownBalance,170);
 assert.equal(latestBalanceRecordLabel(result),'2026-10-01 ~ 2026-10-02 기록');
});

test('기록 잔액 이후 신규 거래에 잔액이 없으면 입출금을 반영하고 미래 거래는 제외한다',()=>{
 const data=dataset({transactions:[row('statement','2026-09-30',1,{balance:100}),row('new-income','2026-10-01',50,{direction:'in'}),row('new-expense','2026-10-02',20),row('future','2026-10-03',999,{balance:9999})]});
 const result=buildLatestCashBalances(data,'2026-10-02').businesses[0];
 assert.equal(result.balance,130);assert.equal(result.accounts[0].snapshot.source,'calculated');
 assert.equal(result.accounts[0].snapshot.transactionId,'statement');assert.equal(result.lastRecordDate,'2026-10-02');
 assert.equal(latestBalanceRecordLabel(result),'2026-10-02 기록');
 assert.equal(buildLatestCashBalances(data,'2026-10-03').businesses[0].balance,9999);
});

test('잔액 없는 계좌·원본 충돌은 전체 잔액을 미확정으로 남기고 확인된 소계만 제공한다',()=>{
 const data=dataset({accounts:[account('known',{opening_balance:40}),account('missing',{opening_balance_date:null}),account('conflict')],transactions:[row('first','2026-10-02',10,{account_id:'conflict',balance:90}),row('second','2026-10-02',20,{account_id:'conflict',balance:20})]});
 const result=buildLatestCashBalances(data,'2026-10-02').businesses[0];
 assert.equal(result.balance,null);assert.equal(result.knownBalance,40);
 assert.deepEqual(result.accounts.map(item=>item.snapshot.source),['opening','unavailable','conflict']);
 assert.equal(result.accounts[2].snapshot.balance,null);assert.equal(result.accounts[2].snapshot.date,'2026-10-02');
 assert.match(result.accounts[2].snapshot.message,/원본/);
});

test('통장 없는 사업자·0원·음수는 구분하며 날짜가 잘못되면 계산하지 않는다',()=>{
 const data=dataset({businesses:['none','zero','negative'].map(id=>({id,name:`합성 ${id}`,kind:'법인',representative:'',reserve:0,color:'#123456'})),accounts:[account('zero',{business_id:'zero',opening_balance:0}),account('negative',{business_id:'negative',opening_balance:-20})]});
 const result=buildLatestCashBalances(data,'2026-10-02').businesses;
 assert.deepEqual(result.map(item=>item.balance),[null,0,-20]);
 assert.equal(result[0].lastRecordDate,null);assert.equal(result[0].knownBalance,0);
 assert.equal(latestBalanceRecordLabel(result[0]),'잔액 근거일 확인 필요');
 for(const asOf of ['invalid','2026-02-30','2026-10-02T00:00:00Z'])assert.throws(()=>buildLatestCashBalances(data,asOf),RangeError);
});

test('Clobe 수집 시각은 UTC·명시 오프셋을 한국시간으로 표시하고 오프셋 없는 은행 시각은 유지한다',()=>{
 assert.equal(balanceCollectedTimeLabel('2026-10-15T07:29:23Z'),'2026-10-15 16:29');
 assert.equal(balanceCollectedTimeLabel('2026-10-15T16:29:23.123+09:00'),'2026-10-15 16:29');
 assert.equal(balanceCollectedTimeLabel('2026-10-15T16:29:23'),'2026-10-15 16:29');
 assert.equal(balanceCollectedTimeLabel('2026-10-15T23:30:00Z'),'2026-10-16 08:30');
 for(const value of [undefined,'','2026-10-15','2026-02-30T12:00:00','2026-10-15T24:00:00','2026-10-15T12:60:00','2026-10-15T12:00:60','2026-10-15T12:00:00+14:30','2026-10-15T12:00:00+09:99'])assert.equal(balanceCollectedTimeLabel(value),null);
});

test('서로 다른 수집 기준은 한 시각으로 합치지 않고 범위와 시각 누락을 표시한다',()=>{
 const business=buildLatestCashBalances(dataset({accounts:[account('a1'),account('a2')]}),'2026-10-15').businesses[0];
 const source=(time:string|undefined)=>({balance:100,date:'2026-10-15',source:'clobe' as const,transactionId:null,message:'',collectedAt:time});
 const result:LatestCashBusiness={...business,firstRecordDate:'2026-10-15',lastRecordDate:'2026-10-15',accounts:business.accounts.map((row,index)=>({...row,snapshot:source(index===0?'2026-10-15T00:30:00Z':'2026-10-15T16:29:23')}))};
 assert.equal(latestBalanceRecordLabel(result),'Clobe 수집 기준 10-15 09:30~16:29');
 result.accounts[1].snapshot=source(undefined);
 assert.equal(latestBalanceRecordLabel(result),'Clobe 수집 기준 10-15 09:30 · 일부 시각 미확인');
 assert.equal(accountBalanceRecordLabel(result.accounts[1].snapshot),'Clobe 수집 시각 확인 필요');
 result.accounts[0].snapshot=source(undefined);
 assert.equal(latestBalanceRecordLabel(result),'Clobe 수집 기준 시각 확인 필요');
});

test('계좌별 표시는 기존 계좌 이름을 유지하고 0·음수·미확정 잔액과 중복 이름을 구분한다',()=>{
 const business=buildLatestCashBalances(dataset({accounts:[account('a1',{name:'합성 통장',bank:'합성은행',masked_number:'***1001',opening_balance:0}),account('a2',{name:'합성 통장',bank:'합성은행',masked_number:'***1002',opening_balance:-20}),account('a3',{name:'보조 통장',opening_balance_date:null})]}),'2026-10-15').businesses[0];
 const before=JSON.stringify(business);
 assert.deepEqual(latestAccountBalanceRows(business),[
  {id:'a1',label:'합성 통장 · 합성은행 1001',balance:0,basis:'2026-01-01 거래 기록 기준'},
  {id:'a2',label:'합성 통장 · 합성은행 1002',balance:-20,basis:'2026-01-01 거래 기록 기준'},
  {id:'a3',label:'보조 통장',balance:null,basis:'잔액 근거일 확인 필요'},
 ]);
 assert.equal(business.balance,null);assert.equal(business.knownBalance,-20);
 assert.equal(JSON.stringify(business),before);
 assert.deepEqual(latestAccountBalanceRows(undefined),[]);
});
