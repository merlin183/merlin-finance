import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAccountFunding,type AccountFundingBusiness,type AccountFundingItem} from '../lib/finance/account-funding';
import {buildFundingTimeline} from '../lib/finance/funding-timeline';
import {buildCashPlan} from '../lib/finance/cash-plan';
import type {CashEstimateBusiness} from '../lib/finance/cash-estimates';
import {emptyDataset,type Business,type Dataset} from '../lib/finance/types';

const range={from:'2026-10-01',to:'2026-10-30'};
const owner=(id='b1'):Business=>({id,name:'합성 공통 사업자명',representative:'',kind:'법인',reserve:999999,color:'#123456'});
const item=(date:string|null,amount:number,key=`${date}-${amount}`):AccountFundingItem=>({key,date,title:'합성 지출',amount,note:'합성',...(date===null?{from:range.from,to:range.to}:{})});
const funding=(id:string,balance:number|null,items:AccountFundingItem[],businessId='b1'):AccountFundingBusiness=>{
 const expenses=items.reduce((sum,row)=>sum+row.amount,0);
 const requiredTopUp=balance===null?null:Math.max(0,expenses-balance);
 return {business:owner(businessId),accounts:[{account:{id,business_id:businessId,name:'합성 공통 통장명',bank:'합성은행',masked_number:'0000',opening_balance:0,opening_balance_date:null},snapshot:{balance,date:balance===null?null:'2026-09-30',source:balance===null?'unavailable':'statement',transactionId:null,message:'합성 잔액'},items,expenses,datedExpenses:items.filter(row=>row.date!==null).reduce((sum,row)=>sum+row.amount,0),undatedExpenses:items.filter(row=>row.date===null).reduce((sum,row)=>sum+row.amount,0),afterExpenses:balance===null?null:balance-expenses,requiredTopUp,calculationStatus:'estimated',firstDatedShortfall:null}],expenses,requiredTopUp,knownRequiredTopUp:requiredTopUp??0,unknownAccountCount:balance===null?1:0,unassignedExpenses:0,unassignedItems:[]};
};

test('10일과 15일의 추가 입금은 앞선 지출을 누적하고 이전 보충액을 중복 청구하지 않는다',()=>{
 const timeline=buildFundingTimeline([funding('a1',100,[item('2026-10-15',300),item('2026-10-10',200)])],range);
 assert.equal(timeline.days.length,30);
 const tenth=timeline.days.find(day=>day.date==='2026-10-10')!;
 const fifteenth=timeline.days.find(day=>day.date==='2026-10-15')!;
 assert.deepEqual([tenth.expenses,tenth.additionalTopUp,tenth.cumulativeTopUp],[200,100,100]);
 assert.deepEqual([fifteenth.expenses,fifteenth.additionalTopUp,fifteenth.cumulativeTopUp],[300,300,400]);
 assert.deepEqual([fifteenth.accounts[0].cumulativeExpenses,fifteenth.accounts[0].projectedBalance],[500,-400]);
 assert.equal(timeline.days[10].additionalTopUp,0);
 assert.equal(timeline.days[10].cumulativeTopUp,100);
 assert.equal(timeline.days.reduce((sum,day)=>sum+day.additionalTopUp!,0),400);
 assert.equal(fifteenth.accounts[0].items.length,1);
});

test('같은 이름이어도 사업자·계좌를 유지하고 타 계좌의 여유 잔액을 상계하지 않는다',()=>{
 const first=funding('a1',100,[item('2026-10-10',200)]);
 first.accounts.push(funding('a2',10000,[item('2026-10-10',50)]).accounts[0]);
 const second=funding('a3',20,[item('2026-10-10',70)],'b2');
 const day=buildFundingTimeline([first,second],range).days[9];
 assert.equal(day.additionalTopUp,150);
 assert.deepEqual(day.accounts.map(row=>[row.business.id,row.account.id,row.additionalTopUp]),[['b1','a1',100],['b1','a2',0],['b2','a3',50]]);
});

test('사업자별 당일 지출은 여러 통장의 전체 지출액을 합산하고 여유 잔액을 차감하지 않는다',()=>{
 const first=funding('a1',100,[item('2026-10-10',200),item('2026-10-15',400)]);
 first.accounts.push(funding('a2',10000,[item('2026-10-10',50)]).accounts[0]);
 const second=funding('a3',10000,[item('2026-10-10',70)],'b2');
 const third=funding('a4',0,[],'b3');
 const result=buildFundingTimeline([first,second,third],range);
 const tenth=result.days[9];
 assert.deepEqual(tenth.businesses.map(row=>[row.business.id,row.expenses,row.unassignedExpenses,row.accounts.map(account=>account.account.id)]),[
  ['b1',250,0,['a1','a2']],['b2',70,0,['a3']],['b3',0,0,['a4']],
 ]);
 assert.deepEqual([tenth.expenses,tenth.additionalTopUp,tenth.cumulativeTopUp,tenth.knownAdditionalTopUp,tenth.knownCumulativeTopUp],[320,100,100,100,100]);
 assert.equal(tenth.businesses[0].accounts[0],tenth.accounts[0]);
 assert.equal(tenth.businesses[1].accounts[0].additionalTopUp,0);
 assert.deepEqual(result.days[14].businesses.map(row=>row.expenses),[400,0,0]);
 assert.deepEqual([result.days[14].expenses,result.days[14].additionalTopUp,result.days[14].cumulativeTopUp],[400,400,500]);
 assert.deepEqual(result.days[0].businesses.map(row=>[row.business.id,row.expenses]),[['b1',0],['b2',0],['b3',0]]);
 for(const day of result.days)assert.equal(day.businesses.reduce((sum,row)=>sum+row.expenses,0),day.expenses);
});

test('계좌 미지정 지출은 소속 사업자에 한 번만 포함하고 날짜 미정 예산은 매일 배분하지 않는다',()=>{
 const first=funding('a1',1000,[item('2026-10-10',100),item(null,900)]);
 first.accounts.push(funding('a2',1000,[item('2026-10-10',200)]).accounts[0]);
 first.unassignedItems=[item('2026-10-10',300),item(null,600)];
 const second=funding('a3',null,[item('2026-10-10',50)],'b2');
 second.unassignedItems=[item('2026-10-10',400),item(null,700),item('2026-09-30',999),item('2026-10-31',999),item('2026-10-00',999)];
 const third=funding('a4',0,[],'b3');
 third.accounts=[];
 third.unassignedItems=[item('2026-10-10',500)];
 const result=buildFundingTimeline([first,second,third],range);
 const day=result.days[9];
 assert.deepEqual(day.businesses.map(row=>[row.business.id,row.expenses,row.unassignedExpenses,row.accounts.map(account=>account.account.id)]),[
  ['b1',600,300,['a1','a2']],['b2',450,400,['a3']],['b3',500,500,[]],
 ]);
 assert.deepEqual([day.expenses,day.additionalTopUp,day.cumulativeTopUp,day.knownAdditionalTopUp,day.knownCumulativeTopUp,day.unknownAccountCount],[1550,null,null,0,0,1]);
 assert.equal(result.unassignedExpenses,2500);
 assert.equal(result.undatedExpenses,2200);
 assert.equal(result.missingAccountBusinessCount,1);
 assert.equal(result.days.reduce((sum,row)=>sum+row.expenses,0),1550);
 for(const daily of result.days){
  assert.equal(daily.businesses.reduce((sum,row)=>sum+row.expenses,0),daily.expenses);
  if(daily.date!=='2026-10-10')assert.deepEqual(daily.businesses.map(row=>[row.expenses,row.unassignedExpenses]),[[0,0],[0,0],[0,0]]);
 }
});

test('날짜 미정 예산은 날짜별 지출과 보충액에 섞지 않고 기간 예산으로 별도 보존한다',()=>{
 const result=buildFundingTimeline([funding('a1',100,[item('2026-10-10',150),item(null,500)])],range);
 assert.equal(result.undatedExpenses,500);
 assert.equal(result.days.at(-1)!.cumulativeTopUp,50);
 assert.equal(result.days[9].accounts[0].undatedExpenses,500);
 assert.equal(result.days.reduce((sum,day)=>sum+day.expenses,0),150);
 assert.equal(result.days.reduce((sum,day)=>sum+day.additionalTopUp!,0),50);
});

test('잔액 미확인과 충돌은 날짜별 금액을 0으로 만들지 않고 계산 가능한 소계를 유지한다',()=>{
 const unknown=funding('a2',null,[item('2026-10-10',250)],'b2');
 unknown.accounts[0].snapshot.source='conflict';
 const result=buildFundingTimeline([funding('a1',100,[item('2026-10-10',150)]),unknown],range);
 const day=result.days[9];
 assert.equal(result.unknownAccountCount,1);
 assert.equal(day.expenses,400);
 assert.equal(day.additionalTopUp,null);assert.equal(day.cumulativeTopUp,null);
 assert.equal(day.knownAdditionalTopUp,50);assert.equal(day.knownCumulativeTopUp,50);
 assert.equal(day.accounts[1].projectedBalance,null);assert.equal(day.accounts[1].additionalTopUp,null);
 assert.equal(day.accounts[1].snapshot.source,'conflict');
});

test('계좌 미지정 지출은 날짜별 총지출에 포함하되 어느 통장의 부족액인지 추측하지 않는다',()=>{
 const business=funding('a1',1000,[]);
 business.accounts[0].expenses=null;business.accounts[0].calculationStatus='unassigned';
 business.unassignedItems=[item('2026-10-15',500),item(null,200)];business.unassignedExpenses=700;
 const result=buildFundingTimeline([business],range);
 assert.equal(result.unassignedExpenses,700);assert.equal(result.undatedExpenses,200);
 assert.equal(result.days[14].expenses,500);assert.equal(result.days[14].accounts[0].expenses,0);
 assert.equal(result.days[14].additionalTopUp,null);assert.equal(result.days[14].accounts[0].additionalTopUp,null);
 assert.equal(result.days[14].knownAdditionalTopUp,0);assert.equal(result.unknownAccountCount,1);
});

test('계좌가 없는 사업자와 빈 자료는 전체 필요액이 0원이라고 확정하지 않는다',()=>{
 const business=funding('a1',0,[]);business.accounts=[];
 const result=buildFundingTimeline([funding('a2',0,[item('2026-10-10',75)],'b2'),business],range);
 assert.equal(result.missingAccountBusinessCount,1);
 assert.equal(result.days[9].additionalTopUp,null);assert.equal(result.days[9].knownAdditionalTopUp,75);
 assert.equal(buildFundingTimeline([],range).days[0].additionalTopUp,null);
});

test('시작 잔액이 이미 음수이면 첫날 보충하고 이후 지출에만 추가 입금을 요구한다',()=>{
 const result=buildFundingTimeline([funding('a1',-100,[item('2026-10-15',250)])],range);
 assert.deepEqual([result.days[0].expenses,result.days[0].additionalTopUp,result.days[0].cumulativeTopUp],[0,100,100]);
 assert.deepEqual([result.days[1].additionalTopUp,result.days[1].cumulativeTopUp],[0,100]);
 assert.deepEqual([result.days[14].additionalTopUp,result.days[14].cumulativeTopUp],[250,350]);
});

test('같은 날 여러 출금·기간 경계·연말과 윤년을 처리하고 범위 밖 지출은 제외한다',()=>{
 const boundary={from:'2026-12-31',to:'2027-01-02'};
 const result=buildFundingTimeline([funding('a1',100,[item('2026-12-30',9999),item('2026-12-31',60),item('2026-12-31',40),item('2027-01-01',30),item('2027-01-02',20),item('2027-01-03',9999),item('2027-01-00',9999)])],boundary);
 assert.deepEqual(result.days.map(day=>[day.date,day.expenses,day.additionalTopUp]),[['2026-12-31',100,0],['2027-01-01',30,30],['2027-01-02',20,20]]);
 assert.deepEqual(buildFundingTimeline([], {from:'2028-02-28',to:'2028-03-01'}).days.map(day=>day.date),['2028-02-28','2028-02-29','2028-03-01']);
 assert.equal(buildFundingTimeline([], {from:'9999-12-31',to:'9999-12-31'}).days.length,1);
 assert.equal(result.days[0].accounts[0].items.length,2);
});

test('입력 자료·일자별 항목 배열을 변경하지 않으며 잘못된 조회 기간은 거부한다',()=>{
 const input=[funding('a1',100,[item('2026-10-15',100),item('2026-10-10',100),item(null,100)])];
 const before=structuredClone(input);const savedRange={...range};
 const result=buildFundingTimeline(input,range);
 assert.deepEqual(input,before);assert.deepEqual(range,savedRange);
 result.days[9].accounts[0].items.push(item('2026-10-10',200));
 assert.deepEqual(input,before);
 for(const invalid of [{from:'2026-02-30',to:'2026-03-01'},{from:'2026-10-15',to:'2026-10-10'},{from:'10/01/2026',to:'2026-10-30'}])assert.throws(()=>buildFundingTimeline(input,invalid),RangeError);
});

test('실제 계획과 계좌 계산기를 연결해도 예정 수입·사업자 예비금은 보충액을 상계하지 않는다',()=>{
 const business=owner();
 const data:Dataset={...emptyDataset,businesses:[business],accounts:[{id:'a1',business_id:business.id,name:'합성 통장',bank:'합성은행',masked_number:'0000',opening_balance:100,opening_balance_date:'2026-09-30'}],recurring:[{id:'income',business_id:business.id,title:'합성 예정 입금',amount:1000000,direction:'in',day:5,start_date:'2026-10-05',end_date:null,frequency:'once'}]};
 const plan=buildCashPlan(data,'2026-09-30');
 const estimate:CashEstimateBusiness={business,total:500,dated:[{groupKey:'first',businessId:business.id,accountId:'a1',title:'합성 첫 지출',date:'2026-10-10',amount:200},{groupKey:'second',businessId:business.id,accountId:'a1',title:'합성 다음 지출',date:'2026-10-15',amount:300}],undated:[],groups:[],exclusions:[]};
 const source=buildAccountFunding(plan.businesses,new Map([[business.id,estimate]]),'estimated');
 const result=buildFundingTimeline(source,plan.range);
 assert.equal(result.days[14].accounts[0].snapshot.balance,100);
 assert.equal(result.days[14].cumulativeTopUp,400);
 assert.equal(result.days[14].additionalTopUp,300);
});
