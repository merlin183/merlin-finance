import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFundingReport} from '../lib/finance/funding-report';
import {buildCashPlan,buildCurrentCashPlanForRange} from '../lib/finance/cash-plan';
import {buildCashEstimates,type CashDatedEstimate,type CashEstimateBusiness,type CashEstimateGroup,type CashUndatedBudget} from '../lib/finance/cash-estimates';
import {emptyDataset,type Account,type Business,type Dataset,type Transaction} from '../lib/finance/types';

const range={from:'2026-10-01',to:'2026-10-30'};
const business=(id='b1'):Business=>({id,name:`합성 사업자 ${id}`,representative:'',kind:'법인',reserve:999999,color:'#123456'});
const account=(id='a1',balance=100,business_id='b1',date:string|null='2026-09-30'):Account=>({id,business_id,name:'합성 공통 통장',bank:'합성은행',masked_number:`합성-${id}`,opening_balance:balance,opening_balance_date:date});
const dataset=(extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,businesses:[business()],accounts:[account()],...extra});
const dated=(date:string,amount:number,accountId='a1',businessId='b1',title='합성 정기 출금',groupKey=title):CashDatedEstimate=>({groupKey,businessId,accountId,title,date,amount});
const budget=(amount:number,accountId='a1',businessId='b1'):CashUndatedBudget=>({groupKey:'budget',businessId,accountId,title:'합성 비정기 출금',month:'2026-10',from:range.from,to:range.to,coveredDays:30,monthDays:31,monthlyAmount:amount,amount,kind:'period-budget'});
const estimate=(dated:CashDatedEstimate[]=[],undated:CashUndatedBudget[]=[],id='b1',groups:CashEstimateGroup[]=[]):CashEstimateBusiness=>({business:business(id),total:[...dated,...undated].reduce((sum,item)=>sum+item.amount,0),dated,undated,groups,exclusions:[]});
const group=(key:string,categoryNames:string[],accountId='a1',businessId='b1'):CashEstimateGroup=>({key,businessId,accountId,label:'원본 거래처',categoryId:null,categoryNames,monthlyAverage:0,monthlyAmounts:[],sourceCount:0,sourceIds:[],expectedDay:10,monthEnd:false});
const report=(data:Dataset,estimates:CashEstimateBusiness[]=[],basis:'registered'|'estimated'='estimated')=>{
 const plan=buildCashPlan(data,'2026-09-30');
 return buildFundingReport(plan.businesses,new Map(estimates.map(item=>[item.business.id,item])),basis,plan.range);
};

test('현재 음수 잔액의 보충일은 고정 계획 시작일이 아니라 오늘부터 표시한다',()=>{
 const data=dataset({accounts:[account('a1',-100)]});
 const plan=buildCurrentCashPlanForRange(data,range,'2026-10-02');
 const result=buildFundingReport(plan.businesses,new Map([['b1',estimate([dated('2026-10-10',200)])]]),'estimated',range,plan.asOf);
 assert.deepEqual(result.range,range);
 assert.deepEqual(result.businesses[0].rows.map(row=>[row.date,row.additionalTopUp,row.initialShortfall]),[['2026-10-02',100,true],['2026-10-10',200,false]]);
 assert.equal(result.requiredTopUp,300);
 assert.equal(result.datedRequiredTopUp,300);
});

test('종료된 조회기간에는 현재 잔액의 보충일을 과거 날짜로 만들지 않는다',()=>{
 const plan=buildCurrentCashPlanForRange(dataset({accounts:[account('a1',-100)]}),range,'2026-11-02');
 const result=buildFundingReport(plan.businesses,new Map(),'estimated',range,plan.asOf);
 assert.equal(result.requiredTopUp,100);
 assert.equal(result.datedRequiredTopUp,null);
 assert.equal(result.earliestFundingDate,null);
 assert.deepEqual(result.businesses[0].rows,[]);
 assert.equal(result.businesses[0].fundingDateIncomplete,true);
});

test('이미 도래한 등록 일정은 재차감하지 않고 지급 확인 전 전체 필요액을 확정하지 않는다',()=>{
 const data=dataset({recurring:[{id:'past',business_id:'b1',title:'합성 지난 일정',amount:200,direction:'out',day:1,start_date:'2026-10-01',end_date:null,frequency:'once'}]});
 const plan=buildCurrentCashPlanForRange(data,range,'2026-10-02');
 const result=buildFundingReport(plan.businesses,new Map(),'registered',range,plan.asOf);
 assert.equal(result.requiredTopUp,null);
 assert.equal(result.datedRequiredTopUp,null);
 assert.equal(result.businesses[0].funding.expenses,0);
 assert.equal(result.businesses[0].funding.unconfirmedItems?.[0].amount,200);
 assert.equal(result.businesses[0].fundingDateIncomplete,true);
 assert.equal(result.businesses[0].funding.accounts[0].afterExpenses,null);
});

test('사업자·계좌별 날짜 보고는 추가분만 요청하고 다른 계좌 여유금·예정 입금·유보액을 상계하지 않는다',()=>{
 const data=dataset({businesses:[business(),business('b2')],accounts:[account(),account('surplus',10000),account('other',0,'b2')],recurring:[{id:'income',business_id:'b1',title:'합성 예정 수금',amount:1000000,direction:'in',day:1,start_date:'2026-10-01',end_date:null,frequency:'once'}]});
 const result=report(data,[estimate([
  dated('2026-10-15',300,'a1','b1','합성 임차료','rent'),
  dated('2026-10-10',150,'a1','b1','합성 보험','insurance'),
  dated('2026-10-10',50,'a1','b1','합성 통신','phone'),
  dated('2026-10-10',20,'surplus'),
 ],[],undefined,[group('rent',['임차료']),group('insurance',['보험료']),group('phone',['통신비','보험료'])]),estimate([dated('2026-10-10',75,'other','b2')],[],'b2')]);
 const first=result.businesses[0];
 assert.equal(first.balance,10100);assert.equal(first.knownBalance,10100);
 assert.equal(first.requiredTopUp,400);assert.equal(first.datedRequiredTopUp,400);
 assert.deepEqual(first.rows.map(row=>[row.date,row.account.id,row.expenses,row.additionalTopUp,row.cumulativeTopUp]),[['2026-10-10','a1',200,100,100],['2026-10-15','a1',300,300,400]]);
 assert.equal(first.rows.reduce((sum,row)=>sum+row.additionalTopUp!,0),400);
 assert.deepEqual(first.rows[0].items.map(item=>item.title),['합성 보험','합성 통신']);
 assert.deepEqual(first.rows[0].categoryNames,['보험료','통신비']);
 assert.equal(first.earliestFundingDate,'2026-10-10');assert.equal(first.fundingDateIncomplete,false);
 assert.equal(result.requiredTopUp,475);assert.equal(result.datedRequiredTopUp,475);assert.equal(result.knownDatedRequiredTopUp,475);
 assert.equal(result.earliestFundingDate,'2026-10-10');
});

test('날짜 미정 예산은 전체 필요액에만 포함하고 지급 날짜를 만들지 않는다',()=>{
 const result=report(dataset(),[estimate([dated('2026-10-15',150)],[budget(500)],undefined,[group('budget',['지급수수료'])])]);
 const first=result.businesses[0];
 assert.equal(first.requiredTopUp,550);assert.equal(first.datedRequiredTopUp,50);
 assert.equal(first.rows.length,1);assert.equal(first.rows[0].additionalTopUp,50);
 assert.equal(first.earliestFundingDate,'2026-10-15');assert.equal(first.fundingDateIncomplete,true);
 assert.equal(first.undatedAccounts[0].expenses,500);assert.equal(first.undatedAccounts[0].items[0].date,null);
 assert.deepEqual(first.undatedAccounts[0].categoryNames,['지급수수료']);
 assert.equal(result.undatedExpenses,500);assert.equal(result.requiredTopUp,550);assert.equal(result.datedRequiredTopUp,50);
});

test('미확인 잔액은 확인 필요 행으로 보존하고 이미 음수인 계좌는 첫날 기존 부족액으로 구분한다',()=>{
 const data=dataset({businesses:[business(),business('empty')],accounts:[account('negative',-100),account('unknown',9999,'b1',null),account('known',50)]});
 const result=report(data,[estimate([dated('2026-10-10',250,'unknown'),dated('2026-10-15',100,'known')])]);
 const first=result.businesses[0];
 assert.equal(first.balance,null);assert.equal(first.knownBalance,-50);
 assert.equal(first.requiredTopUp,null);assert.equal(first.knownRequiredTopUp,150);
 assert.equal(first.datedRequiredTopUp,null);assert.equal(first.knownDatedRequiredTopUp,150);
 assert.deepEqual(first.rows.map(row=>[row.date,row.account.id,row.additionalTopUp,row.initialShortfall]),[['2026-10-01','negative',100,true],['2026-10-10','unknown',null,false],['2026-10-15','known',50,false]]);
 assert.equal(first.rows[0].expenses,0);assert.deepEqual(first.rows[0].items,[]);
 assert.equal(first.rows[1].expenses,250);assert.equal(first.fundingDateIncomplete,true);
 assert.equal(first.earliestFundingDate,'2026-10-01');
 assert.equal(result.requiredTopUp,null);assert.equal(result.knownRequiredTopUp,150);
 assert.equal(result.unknownAccountCount,1);assert.equal(result.missingAccountBusinessCount,1);
 assert.equal(result.businesses[1].earliestFundingDate,null);assert.equal(result.businesses[1].balance,null);
 const empty=report(dataset({businesses:[],accounts:[]}));
 assert.equal(empty.requiredTopUp,null);assert.equal(empty.datedRequiredTopUp,null);assert.equal(empty.earliestFundingDate,null);
});

test('등록 예정 지출과 잘못된 계좌 참조를 임의 통장에 배정하지 않는다',()=>{
 const data=dataset({recurring:[{id:'expense',business_id:'b1',title:'합성 등록 지급',amount:200,direction:'out',day:15,start_date:'2026-10-15',end_date:null,frequency:'once'}]});
 const registered=report(data,[],'registered').businesses[0];
 assert.equal(registered.requiredTopUp,null);assert.equal(registered.datedRequiredTopUp,null);
 assert.deepEqual(registered.rows,[]);assert.equal(registered.unassignedItems[0].title,'합성 등록 지급');
 assert.equal(registered.unassignedItems[0].date,'2026-10-15');assert.equal(registered.earliestFundingDate,null);
 assert.equal(registered.fundingDateIncomplete,true);
 const orphan=report(dataset(),[estimate([dated('2026-10-10',200,'missing')],[budget(50,'missing')])]);
 assert.equal(orphan.requiredTopUp,null);assert.equal(orphan.unassignedExpenses,250);assert.equal(orphan.undatedExpenses,50);
 assert.equal(orphan.businesses[0].unassignedItems.length,2);assert.deepEqual(orphan.businesses[0].rows,[]);
 assert.deepEqual(orphan.businesses[0].undatedAccounts,[]);
});

test('계정과목 사유는 실제 동일 사업자·계좌의 그룹 연결에서만 읽고 거래처명으로 추측하지 않는다',()=>{
 const result=report(dataset(),[estimate([
  dated('2026-10-10',150,'a1','b1','급여처럼 보이는 원본 제목','missing'),
  dated('2026-10-15',200,'a1','b1','합성 수취인','wrong-business'),
  dated('2026-10-20',200,'a1','b1','다른 합성 수취인','wrong-account'),
 ],[],undefined,[group('wrong-business',['급여'],'a1','b2'),group('wrong-account',['급여'],'a2')])]);
 assert.ok(result.businesses[0].rows.every(row=>row.categoryNames.length===0));
 assert.equal(result.businesses[0].rows[0].items[0].title,'급여처럼 보이는 원본 제목');
});

test('조회 기간 밖 자료는 보고 합계와 날짜 행에서 모두 제외하고 잘못된 기간은 거부한다',()=>{
 const data=dataset();const plans=buildCashPlan(data,'2026-09-30').businesses;
 const estimates=new Map([['b1',estimate([dated('2026-09-30',10000),dated('2026-10-01',200),dated('2026-10-31',10000),dated('2026-10-00',10000)],[{...budget(10000),from:'2026-11-01',to:'2026-11-30'}])]]);
 const result=buildFundingReport(plans,estimates,'estimated',range);
 assert.equal(result.requiredTopUp,100);assert.equal(result.datedRequiredTopUp,100);assert.equal(result.undatedExpenses,0);
 assert.deepEqual(result.businesses[0].rows.map(row=>row.date),['2026-10-01']);
 assert.throws(()=>buildFundingReport(plans,estimates,'estimated',{from:'2026-10-30',to:'2026-10-01'}),RangeError);
});

test('실제 추정 계산기와 연결하며 입력 자료와 보고 항목 배열을 변경하지 않는다',()=>{
 const transactions:Transaction[]=['06','07','08'].map(month=>({id:`synthetic-${month}`,business_id:'b1',account_id:'a1',upload_id:null,txn_date:`2026-${month}-15`,amount:200,direction:'out',balance:null,description:'합성 임대료',raw_gwamok:'임차료',category_id:null,is_internal:false,tax_invoice:false,dedup_hash:`synthetic-${month}`,manually_classified:false}));
 const data=dataset({transactions});
 const plan=buildCashPlan(data,'2026-09-30');const projected=buildCashEstimates(data,'2026-09-30');
 const estimates=new Map(projected.businesses.map(item=>[item.business.id,item]));
 const original={plans:structuredClone(plan.businesses),estimates:structuredClone(estimates),range:{...range}};
 const result=buildFundingReport(plan.businesses,estimates,'estimated',range);
 assert.equal(result.requiredTopUp,100);assert.equal(result.businesses[0].rows[0].date,'2026-10-15');
 assert.deepEqual(result.businesses[0].rows[0].categoryNames,['임차료']);
 result.businesses[0].rows[0].items.push({...result.businesses[0].rows[0].items[0],key:'extra'});
 result.businesses[0].rows[0].categoryNames.push('합성 추가 과목');
 assert.deepEqual(plan.businesses,original.plans);assert.deepEqual(estimates,original.estimates);assert.deepEqual(range,original.range);
});
