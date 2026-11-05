import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCashPlanForRange,buildCurrentCashForecast,buildCurrentCashPlanForRange} from '../lib/finance/cash-plan';
import {DEFAULT_CASH_PLAN_PERIOD} from '../lib/finance/cash-plan-period';
import {emptyDataset,type Dataset,type Recurring,type Transaction} from '../lib/finance/types';

const schedule=(id:string,date:string,amount:number,direction:'in'|'out'='out'):Recurring=>({id,business_id:'b1',title:id,amount,direction,start_date:date,end_date:null,day:Number(date.slice(-2)),frequency:'once'});
const row=(id:string,date:string,amount:number,balance:number):Transaction=>({id,business_id:'b1',account_id:'a1',txn_date:date,amount,balance,direction:'in',description:'합성 입금',upload_id:null,raw_gwamok:'',category_id:null,is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false});
const dataset=(extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,businesses:[{id:'b1',name:'합성 사업자',representative:'',kind:'법인',reserve:10,color:'#123456'}],accounts:[{id:'a1',business_id:'b1',name:'합성 통장',bank:'합성 은행',masked_number:'0000',opening_balance:100,opening_balance_date:'2026-01-01'}],...extra});

test('현재 잔액은 신규 입금을 포함하고 선택한 기간의 앞으로 등록된 일정만 계산한다',()=>{
 const data=dataset({transactions:[row('before','2026-09-30',1,100),row('new','2026-10-02',200,300)],recurring:[schedule('future-out','2026-10-10',80),schedule('future-income','2026-10-20',30,'in'),schedule('outside','2026-11-01',999)]});
 const before=JSON.stringify(data),plan=buildCurrentCashPlanForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02');
 assert.deepEqual(plan.range,DEFAULT_CASH_PLAN_PERIOD);assert.equal(plan.asOf,'2026-10-02');assert.equal(plan.horizon,31);
 const business=plan.businesses[0];
 assert.equal(business.balance,300);assert.equal(business.expenses,80);assert.equal(business.income,30);
 assert.equal(business.afterExpenses,220);assert.equal(business.projected,250);assert.equal(business.available,210);
 assert.equal(business.accounts[0].snapshot.date,'2026-10-02');assert.deepEqual(business.unconfirmedExpenses,[]);
 assert.equal(buildCashPlanForRange(data,DEFAULT_CASH_PLAN_PERIOD).businesses[0].balance,100);
 assert.equal(JSON.stringify(data),before);
});

test('기한이 지났거나 오늘인 등록 출금은 지급 미확인으로 보존하고 합계·차트를 확정하지 않는다',()=>{
 const data=dataset({recurring:[schedule('past','2026-10-01',40),schedule('today','2026-10-02',50),schedule('future','2026-10-15',60),schedule('old-income','2026-10-01',30,'in'),schedule('future-income','2026-10-03',20,'in')]});
 const plan=buildCurrentCashPlanForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02'),business=plan.businesses[0];
 assert.deepEqual(business.unconfirmedExpenses?.map(item=>item.recurringId),['past','today']);
 assert.deepEqual(business.scheduledExpenses.map(item=>item.recurringId),['future']);
 assert.deepEqual(business.scheduledIncome.map(item=>item.recurringId),['future-income']);
 assert.equal(business.expenses,60);assert.equal(business.income,20);
 assert.equal(business.afterExpenses,null);assert.equal(business.projected,null);assert.equal(business.available,null);
 const points=buildCurrentCashForecast(plan);assert.equal(points[0].date,'2026-10-02');assert.equal(points.at(-1)?.date,'2026-10-31');
 assert.ok(points.every(point=>point.b1===null));
});

test('추이 차트는 현재 잔액부터 남은 등록 일정을 같은 날 합산하고 전체 범위 종료일까지 반영한다',()=>{
 const plan=buildCurrentCashPlanForRange(dataset({recurring:[schedule('in','2026-10-03',20,'in'),schedule('out','2026-10-03',50),schedule('last','2026-10-31',30)]}),DEFAULT_CASH_PLAN_PERIOD,'2026-10-02');
 const before=JSON.stringify(plan),points=buildCurrentCashForecast(plan);
 assert.equal(points.length,30);assert.deepEqual(points[0],{date:'2026-10-02',b1:100});
 assert.deepEqual(points[1],{date:'2026-10-03',b1:70});assert.equal(points.at(-1)?.b1,40);
 assert.equal(points.at(-1)?.b1,plan.businesses[0].projected);assert.equal(JSON.stringify(plan),before);
 const future=buildCurrentCashPlanForRange(dataset({recurring:[schedule('first','2026-10-10',25)]}),{from:'2026-10-10',to:'2026-10-15'},'2026-10-02');
 assert.deepEqual(buildCurrentCashForecast(future)[0],{date:'2026-10-10',b1:75});
});

test('종료된 범위의 등록 미확인 출금은 남기되 현재 자금 추이를 과거 날짜에 만들지 않는다',()=>{
 const plan=buildCurrentCashPlanForRange(dataset({recurring:[schedule('past','2026-10-01',80)]}),DEFAULT_CASH_PLAN_PERIOD,'2026-11-02');
 assert.equal(plan.businesses[0].unconfirmedExpenses?.length,1);assert.equal(plan.businesses[0].expenses,0);
 assert.deepEqual(buildCurrentCashForecast(plan),[]);
});

test('현재 잔액 미확인은 0으로 바꾸지 않고 잘못된 날짜나 범위는 거부한다',()=>{
 const missing=dataset({accounts:[{id:'a1',business_id:'b1',name:'미확인',bank:'합성 은행',masked_number:'0000',opening_balance:0,opening_balance_date:null}]});
 const plan=buildCurrentCashPlanForRange(missing,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02');
 assert.equal(plan.businesses[0].balance,null);assert.equal(plan.businesses[0].afterExpenses,null);
 assert.ok(buildCurrentCashForecast(plan).every(point=>point.b1===null));
 assert.throws(()=>buildCurrentCashPlanForRange(dataset(),DEFAULT_CASH_PLAN_PERIOD,'2026-02-30'),RangeError);
 assert.throws(()=>buildCurrentCashPlanForRange(dataset(),{from:'2026-10-31',to:'2026-10-01'},'2026-10-02'),RangeError);
});
