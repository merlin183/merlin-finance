import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCashPlan} from '../lib/finance/cash-plan';
import {emptyDataset,type Account,type Business,type Dataset,type Recurring,type Transaction} from '../lib/finance/types';

const business=(id:string,reserve=0):Business=>({id,name:`합성 사업자 ${id}`,representative:'',kind:'법인',reserve,color:'#123456'});
const account=(id:string,business_id='b1',balance=1000,date:string|null='2026-01-01'):Account=>({id,business_id,name:`합성 계좌 ${id}`,bank:'합성은행',masked_number:'0000',opening_balance:balance,opening_balance_date:date});
const transaction=(id:string,account_id:string,date:string,amount:number,direction:'in'|'out'='out',balance:number|null=null):Transaction=>({id,business_id:'b1',account_id,upload_id:null,txn_date:date,amount,direction,balance,description:'합성 예정 비용',raw_gwamok:'',category_id:null,is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false});
const recurring=(id:string,start_date:string,amount:number,direction:'in'|'out'='out',extra:Partial<Recurring>={}):Recurring=>({id,business_id:'b1',title:`합성 일정 ${id}`,amount,direction,day:Number(start_date.slice(-2)),start_date,end_date:null,frequency:'once',...extra});
const dataset=(extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,businesses:[business('b1',100)],accounts:[account('a1')],...extra});

test('여러 통장 잔액과 각각의 근거를 보존하고 사업자별 지출·입금·잔여 금액을 계산한다',()=>{
 const data=dataset({
  businesses:[business('b1',100),business('b2',30)],
  accounts:[account('a1'),account('a2','b1',500),account('a3','b2',100)],
  transactions:[transaction('bank-close','a1','2026-09-20',200,'out',800),transaction('calculated','a2','2026-09-28',50),transaction('future','a1','2026-10-01',700,'out',100)],
  recurring:[recurring('rent','2026-10-01',300),recurring('sale','2026-10-05',200,'in'),recurring('other-business','2026-10-02',20,'out',{business_id:'b2'})],
 });
 const before=JSON.stringify(data);
 const plan=buildCashPlan(data,'2026-09-30');
 assert.deepEqual(plan.range,{from:'2026-10-01',to:'2026-10-30'});
 assert.equal(plan.horizon,30);
 const first=plan.businesses[0],second=plan.businesses[1];
 assert.equal(first.balance,1250);assert.equal(first.knownBalance,1250);
 assert.deepEqual(first.accounts.map(({snapshot})=>[snapshot.balance,snapshot.source,snapshot.date]),[[800,'statement','2026-09-20'],[450,'calculated','2026-09-28']]);
 assert.equal(first.expenses,300);assert.equal(first.income,200);
 assert.equal(first.afterExpenses,950);assert.equal(first.projected,1150);
 assert.equal(first.reserve,100);assert.equal(first.available,850);
 assert.equal(second.balance,100);assert.equal(second.expenses,20);assert.equal(second.available,50);
 assert.equal(second.accounts[0].snapshot.source,'opening');
 assert.equal(JSON.stringify(data),before);
});

test('일부 통장이 미설정이면 합계를 추정하지 않고 알려진 잔액만 별도 소계로 반환한다',()=>{
 const plan=buildCashPlan(dataset({
  accounts:[account('known','b1',750),account('missing','b1',99999,null),account('not-started','b1',99999,'2026-10-01')],
  recurring:[recurring('expense','2026-10-01',200),recurring('income','2026-10-02',100,'in')],
 }),'2026-09-30');
 const item=plan.businesses[0];
 assert.equal(item.balance,null);assert.equal(item.knownBalance,750);
 assert.deepEqual(item.accounts.map(({snapshot})=>snapshot.source),['opening','unavailable','unavailable']);
 assert.equal(item.afterExpenses,null);assert.equal(item.projected,null);assert.equal(item.available,null);
 assert.equal(item.expenses,200);assert.equal(item.income,100);
});

test('통장 잔액 충돌을 개시잔액으로 덮지 않고 잔액과 예상 잔여를 미확정으로 유지한다',()=>{
 const data=dataset({accounts:[account('conflict'),account('known','b1',500)],transactions:[
  transaction('first','conflict','2026-09-20',100,'out',900),
  transaction('disconnected','conflict','2026-09-20',200,'out',400),
 ]});
 const result=buildCashPlan(data,'2026-09-30').businesses[0];
 assert.equal(result.accounts[0].snapshot.source,'conflict');
 assert.equal(result.accounts[0].snapshot.date,'2026-09-20');
 assert.equal(result.balance,null);assert.equal(result.knownBalance,500);
 assert.equal(result.afterExpenses,null);assert.equal(result.projected,null);assert.equal(result.available,null);
});

test('계좌가 없는 사업자와 0원·음수 잔액을 구분하고 등록 일정 없는 사업자도 남긴다',()=>{
 const plan=buildCashPlan(dataset({businesses:[business('none'),business('zero'),business('negative')],accounts:[account('zero-account','zero',0),account('negative-account','negative',-100)]}),'2026-09-30');
 assert.equal(plan.businesses.length,3);
 const [none,zero,negative]=plan.businesses;
 assert.equal(none.balance,null);assert.equal(none.knownBalance,0);assert.deepEqual(none.accounts,[]);
 assert.equal(zero.balance,0);assert.equal(zero.afterExpenses,0);assert.equal(zero.projected,0);
 assert.equal(negative.balance,-100);assert.equal(negative.afterExpenses,-100);
 for(const item of plan.businesses){assert.equal(item.registeredItemCount,0);assert.deepEqual(item.scheduledExpenses,[]);assert.deepEqual(item.scheduledIncome,[]);}
});

test('계획은 기준일 다음 날부터 지정한 마지막 날까지 포함하고 기준일 일정은 제외한다',()=>{
 const data=dataset({recurring:[recurring('today','2026-09-30',100),recurring('tomorrow','2026-10-01',200),recurring('last','2026-10-30',300),recurring('after','2026-10-31',400)]});
 const month=buildCashPlan(data,'2026-09-30').businesses[0];
 assert.equal(month.registeredItemCount,4);
 assert.deepEqual(month.scheduledExpenses.map(item=>item.recurringId),['tomorrow','last']);
 assert.equal(month.expenses,500);
 const oneDay=buildCashPlan(data,'2026-09-30',1);
 assert.deepEqual(oneDay.range,{from:'2026-10-01',to:'2026-10-01'});
 assert.equal(oneDay.businesses[0].expenses,200);
 const thirtyOneDays=buildCashPlan(data,'2026-09-30',31);
 assert.equal(thirtyOneDays.range.to,'2026-10-31');assert.equal(thirtyOneDays.businesses[0].expenses,900);
});

test('월말 반복 일정은 윤년·다음 달 날짜로 펼치고 종료되거나 아직 시작하지 않은 일정은 제외한다',()=>{
 const data=dataset({recurring:[
  recurring('month-end','2024-01-31',100,'out',{frequency:'monthly',day:31}),
  recurring('ended','2024-01-15',900,'out',{frequency:'monthly',day:15,end_date:'2024-01-31'}),
  recurring('future-start','2024-04-10',800,'out',{frequency:'monthly',day:10}),
  recurring('one-off','2024-02-29',50),
  recurring('income','2024-02-29',25,'in'),
 ]});
 const item=buildCashPlan(data,'2024-01-31',60).businesses[0];
 assert.equal(item.registeredItemCount,5);
 assert.deepEqual(item.scheduledExpenses.map(event=>[event.recurringId,event.date,event.frequency,event.amount]),[
  ['month-end','2024-02-29','monthly',100],['one-off','2024-02-29','once',50],['month-end','2024-03-31','monthly',100],
 ]);
 assert.equal(item.expenses,250);assert.equal(item.income,25);
 assert.deepEqual(item.scheduledIncome[0],{date:'2024-02-29',title:'합성 일정 income',amount:25,direction:'in',frequency:'once',recurringId:'income',businessId:'b1'});
});

test('같은 이름의 과거 출금으로 예정 항목을 지우거나 반복 의무를 만들어내지 않는다',()=>{
 const data=dataset({transactions:[transaction('past','a1','2026-09-01',100),transaction('past-month','a1','2026-08-01',100)],recurring:[recurring('registered','2026-10-01',100,'out',{title:'합성 예정 비용'})]});
 const item=buildCashPlan(data,'2026-09-30').businesses[0];
 assert.equal(item.balance,800);assert.equal(item.expenses,100);assert.equal(item.scheduledExpenses.length,1);
 const withoutRegistration=buildCashPlan({...data,recurring:[]},'2026-09-30').businesses[0];
 assert.equal(withoutRegistration.registeredItemCount,0);assert.deepEqual(withoutRegistration.scheduledExpenses,[]);
 const expired=buildCashPlan({...data,recurring:[recurring('expired','2026-01-01',100,'out',{frequency:'monthly',day:1,end_date:'2026-09-01'})]},'2026-09-30').businesses[0];
 assert.equal(expired.registeredItemCount,1);assert.equal(expired.expenses,0);assert.deepEqual(expired.scheduledExpenses,[]);
});

test('잘못된 기준일·기간과 지원 연도를 벗어나는 예측은 계산하지 않는다',()=>{
 for(const date of ['invalid','2026-02-30','2026-9-30','2026-09-30T00:00:00Z','1899-12-31'])assert.throws(()=>buildCashPlan(dataset(),date),RangeError);
 for(const horizon of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>buildCashPlan(dataset(),'2026-09-30',horizon),RangeError);
 assert.throws(()=>buildCashPlan(dataset(),'9999-12-31',1),RangeError);
});

test('연말과 서머타임 변경에도 예정 기간과 원본 예정일이 이동하지 않는다',()=>{
 const previous=process.env.TZ;
 try{
  for(const timezone of ['Asia/Seoul','UTC','America/Los_Angeles']){
   process.env.TZ=timezone;
   const year=buildCashPlan(dataset({recurring:[recurring('new-year','2027-01-01',10)]}),'2026-12-31',1);
   assert.deepEqual(year.range,{from:'2027-01-01',to:'2027-01-01'},timezone);
   assert.equal(year.businesses[0].scheduledExpenses[0].date,'2027-01-01',timezone);
   const dst=buildCashPlan(dataset({recurring:[recurring('dst','2026-03-08',10)]}),'2026-03-07',1);
   assert.deepEqual(dst.range,{from:'2026-03-08',to:'2026-03-08'},timezone);
   assert.equal(dst.businesses[0].scheduledExpenses[0].date,'2026-03-08',timezone);
  }
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
