import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCashPlanForRange} from '../lib/finance/cash-plan';
import {buildCashEstimatesForRange} from '../lib/finance/cash-estimates';
import {cashPlanPeriodError,DEFAULT_CASH_PLAN_PERIOD,restoreCashPlanPeriod,resolveCashPlanPeriod,serializeCashPlanPeriod} from '../lib/finance/cash-plan-period';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {buildFundingTimeline} from '../lib/finance/funding-timeline';
import {buildFundingReport} from '../lib/finance/funding-report';
import {forecast} from '../lib/finance/aggregate';
import {emptyDataset,type Dataset,type Recurring,type Transaction} from '../lib/finance/types';

const row=(id:string,date:string,amount:number,description:string,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',upload_id:null,txn_date:date,amount,direction:'out',balance:null,description,raw_gwamok:'',category_id:'fee',is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const repeated=(label:string,amount:number,days=[1,1,1])=>['07','08','09'].map((month,index)=>row(`${label}-${month}`,`2026-${month}-${String(days[index]).padStart(2,'0')}`,amount,label));
const schedule=(id:string,start_date:string,amount:number,extra:Partial<Recurring>={}):Recurring=>({id,business_id:'b1',title:id,start_date,amount,direction:'out',day:Number(start_date.slice(-2)),end_date:null,frequency:'once',...extra});
const dataset=(extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,
 businesses:[{id:'b1',name:'합성 사업자',kind:'법인',representative:'',reserve:0,color:'#123456'}],
 accounts:[{id:'a1',business_id:'b1',name:'합성 계좌',bank:'합성은행',masked_number:'0000',opening_balance:100,opening_balance_date:'2026-01-01'}],
 categories:[{id:'fee',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true}],
 ...extra});

test('계획 기본값은 10월 전체이며 저장한 선택만 복원하고 잘못된 저장값은 복구한다',()=>{
 assert.deepEqual(restoreCashPlanPeriod(null),{from:'2026-10-01',to:'2026-10-31'});
 const next={from:'2026-11-10',to:'2027-01-15'};
 assert.deepEqual(restoreCashPlanPeriod(serializeCashPlanPeriod(next)),next);
 for(const stored of ['bad json','null','{}','{"version":0,"from":"2026-11-01","to":"2026-11-30"}','{"version":1,"from":"2026-10-31","to":"2026-10-01"}','{"version":1,"from":"2026-02-30","to":"2026-10-01"}']){
  assert.deepEqual(restoreCashPlanPeriod(stored),DEFAULT_CASH_PLAN_PERIOD);
 }
});

test('달력 양끝 포함 일수·기준일을 계산하고 역순·없는 날짜·과도한 기간은 막는다',()=>{
 assert.deepEqual(resolveCashPlanPeriod(DEFAULT_CASH_PLAN_PERIOD),{range:DEFAULT_CASH_PLAN_PERIOD,asOf:'2026-09-30',horizon:31});
 assert.equal(resolveCashPlanPeriod({from:'2024-02-01',to:'2024-02-29'}).horizon,29);
 assert.equal(resolveCashPlanPeriod({from:'2026-03-01',to:'2026-03-31'}).horizon,31);
 assert.equal(resolveCashPlanPeriod({from:'2026-10-15',to:'2026-10-15'}).horizon,1);
 for(const range of [{from:'',to:'2026-10-31'},{from:'2026-02-30',to:'2026-10-31'},{from:'2026-10-31',to:'2026-10-01'},{from:'1900-03-01',to:'1900-03-31'},{from:'2026-01-01',to:'2027-12-31'}]){
  assert.notEqual(cashPlanPeriodError(range),'');
  assert.throws(()=>resolveCashPlanPeriod(range),RangeError);
  assert.throws(()=>buildCashPlanForRange(dataset(),range),RangeError);
  assert.throws(()=>buildCashEstimatesForRange(dataset(),range),RangeError);
 }
});

test('등록 지출은 10월 1일과 31일 모두 보존하고 시작일 이후 실제 출금을 기준 잔액에서 또 빼지 않는다',()=>{
 const data=dataset({transactions:[row('closing','2026-09-30',1,'합성 마감',{direction:'in',balance:100}),row('already-paid','2026-10-01',80,'합성 지급',{balance:20})],recurring:[
  schedule('previous','2026-09-30',900),schedule('first','2026-10-01',80),schedule('last','2026-10-31',30),schedule('next','2026-11-01',900),
 ]});
 const before=JSON.stringify(data),plan=buildCashPlanForRange(data,DEFAULT_CASH_PLAN_PERIOD);
 assert.equal(plan.asOf,'2026-09-30');assert.equal(plan.horizon,31);
 assert.equal(plan.businesses[0].balance,100);
 assert.deepEqual(plan.businesses[0].scheduledExpenses.map(item=>item.date),['2026-10-01','2026-10-31']);
 assert.equal(plan.businesses[0].expenses,110);assert.equal(plan.businesses[0].afterExpenses,-10);
 assert.equal(JSON.stringify(data),before);
});

test('10월 계획 추정은 잔액 기준 9월 30일과 별개로 7~9월을 근거로 하고 첫날·말일을 포함한다',()=>{
 const data=dataset({transactions:[...repeated('FIRST',80),...repeated('MONTH END',30,[31,31,30]),row('old','2026-06-01',9000,'FIRST'),row('current','2026-10-01',9000,'FIRST')]});
 const estimate=buildCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD);
 assert.equal(estimate.asOf,'2026-09-30');
 assert.deepEqual(estimate.basis.months,['2026-07','2026-08','2026-09']);
 assert.equal(estimate.basis.to,'2026-09-30');
 assert.deepEqual(estimate.businesses[0].dated.map(item=>[item.date,item.amount]),[['2026-10-01',80],['2026-10-31',30]]);
 assert.equal(estimate.businesses[0].total,110);
 const partial=buildCashEstimatesForRange(data,{from:'2026-10-15',to:'2026-11-15'});
 assert.deepEqual(partial.basis.months,estimate.basis.months);
 assert.deepEqual(partial.businesses[0].dated.map(item=>item.date),['2026-10-31','2026-11-01']);
});

test('시스템 날짜가 다음 날이나 다음 달이 되어도 저장한 기간·잔액·추정 근거는 이동하지 않는다',context=>{
 context.mock.timers.enable({apis:['Date'],now:new Date('2026-10-01T00:00:00+09:00')});
 const serialized=serializeCashPlanPeriod(DEFAULT_CASH_PLAN_PERIOD);
 const data=dataset({transactions:repeated('SERVICE',80),recurring:[schedule('first','2026-10-01',80)]});
 const calculate=()=>{const range=restoreCashPlanPeriod(serialized);return {plan:buildCashPlanForRange(data,range),estimates:buildCashEstimatesForRange(data,range)};};
 const original=calculate();
 for(const now of ['2026-10-02T00:00:00+09:00','2026-11-01T00:00:00+09:00']){
  context.mock.timers.setTime(new Date(now).getTime());assert.deepEqual(calculate(),original);
 }
});

test('사업자·계좌·날짜·필요자금 보고가 같은 시작 잔액과 범위를 쓰며 미정 예산은 날짜별에서 분리한다',()=>{
 const data=dataset({transactions:[...repeated('FIRST',80),...repeated('TENTH',70,[10,10,10]),...repeated('FIFTEENTH',30,[15,15,15]),...repeated('VARIABLE',310,[5,15,25]),row('closing','2026-09-30',1,'합성 마감',{direction:'in',balance:100}),row('after-start','2026-10-01',80,'FIRST',{balance:20})]});
 const plan=buildCashPlanForRange(data,DEFAULT_CASH_PLAN_PERIOD),estimates=buildCashEstimatesForRange(data,plan.range);
 const map=new Map(estimates.businesses.map(item=>[item.business.id,item]));
 const funding=buildAccountFunding(plan.businesses,map,'estimated');
 const timeline=buildFundingTimeline(funding,plan.range);
 const report=buildFundingReport(plan.businesses,map,'estimated',plan.range);
 assert.equal(estimates.businesses[0].total,490);assert.equal(funding[0].expenses,490);
 assert.equal(funding[0].requiredTopUp,390);assert.equal(report.requiredTopUp,390);
 assert.equal(estimates.businesses[0].undated[0].coveredDays,31);assert.equal(estimates.businesses[0].undated[0].amount,310);
 assert.equal(timeline.undatedExpenses,310);assert.equal(report.undatedExpenses,310);
 assert.equal(timeline.days[0].date,'2026-10-01');assert.equal(timeline.days[0].expenses,80);
 assert.equal(timeline.days.find(day=>day.date==='2026-10-10')!.additionalTopUp,50);
 assert.equal(timeline.days.find(day=>day.date==='2026-10-15')!.additionalTopUp,30);
 assert.equal(timeline.days.at(-1)!.cumulativeTopUp,80);assert.equal(report.datedRequiredTopUp,80);
 assert.deepEqual(report.businesses[0].rows.map(item=>[item.date,item.additionalTopUp]),[['2026-10-10',50],['2026-10-15',30]]);
});

test('등록 예정 지출과 추이 차트는 같은 범위로 계산하되 계좌 미지정 상태는 보존한다',()=>{
 const data=dataset({recurring:[schedule('first','2026-10-01',80),schedule('last','2026-10-31',30),schedule('income','2026-10-31',20,{direction:'in'})]});
 const plan=buildCashPlanForRange(data,DEFAULT_CASH_PLAN_PERIOD);
 const points=forecast(data,plan.asOf,plan.horizon).slice(1);
 const funding=buildAccountFunding(plan.businesses,new Map(),'registered');
 const report=buildFundingReport(plan.businesses,new Map(),'registered',plan.range);
 assert.equal(points.length,31);assert.equal(points[0].date,plan.range.from);assert.equal(points[0].b1,20);
 assert.equal(points.at(-1)!.date,plan.range.to);assert.equal(points.at(-1)!.b1,plan.businesses[0].projected);
 assert.equal(funding[0].unassignedExpenses,110);assert.equal(report.unassignedExpenses,110);
 assert.equal(funding[0].requiredTopUp,null);assert.equal(report.requiredTopUp,null);
});
