import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {buildCashPlan} from '../lib/finance/cash-plan';
import {buildCashEstimates,type CashDatedEstimate,type CashEstimateBusiness,type CashUndatedBudget} from '../lib/finance/cash-estimates';
import {emptyDataset,type Account,type Business,type Dataset,type Recurring,type Transaction} from '../lib/finance/types';

const business=(id:string,reserve=0):Business=>({id,name:`합성 사업자 ${id}`,representative:'',kind:'법인',reserve,color:'#123456'});
const account=(id:string,business_id='b1',balance=1000,date:string|null='2026-01-01'):Account=>({id,business_id,name:'합성 공통 통장명',bank:`합성은행 ${id}`,masked_number:'0000',opening_balance:balance,opening_balance_date:date});
const dataset=(extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,businesses:[business('b1')],accounts:[account('a1')],...extra});
const recurring=(id:string,date:string,amount:number,direction:'in'|'out'='out',business_id='b1'):Recurring=>({id,business_id,title:`합성 일정 ${id}`,amount,direction,day:Number(date.slice(-2)),start_date:date,end_date:null,frequency:'once'});
const dated=(accountId:string,date:string,amount:number,title='합성 정기 지출',businessId='b1'):CashDatedEstimate=>({groupKey:JSON.stringify([businessId,accountId,title]),businessId,accountId,title,date,amount});
const undated=(accountId:string,amount:number,from='2026-10-01',to='2026-10-30'):CashUndatedBudget=>({groupKey:JSON.stringify(['b1',accountId,'기간']),businessId:'b1',accountId,title:'합성 기간 예산',month:from.slice(0,7),from,to,coveredDays:30,monthDays:31,monthlyAmount:amount,amount,kind:'period-budget'});
const estimate=(events:CashDatedEstimate[]=[],budgets:CashUndatedBudget[]=[],owner=business('b1')):CashEstimateBusiness=>({business:owner,total:[...events,...budgets].reduce((sum,item)=>sum+item.amount,0),dated:events,undated:budgets,groups:[],exclusions:[]});
const funding=(data:Dataset,estimates:CashEstimateBusiness[]=[],basis:'registered'|'estimated'='estimated')=>buildAccountFunding(buildCashPlan(data,'2026-09-30').businesses,new Map(estimates.map(item=>[item.business.id,item])),basis);

test('동일한 통장명·적요라도 사업자와 실제 계좌 ID로 분리하고 여유 잔액과 부족액을 상계하지 않는다',()=>{
 const data=dataset({businesses:[business('b1',999999),business('b2')],accounts:[account('a1','b1',100),account('a2','b1',5000),account('a3','b2',50)],recurring:[recurring('future-income','2026-10-02',999999,'in')]});
 const result=funding(data,[estimate([dated('a1','2026-10-10',300),dated('a2','2026-10-10',100)]),estimate([dated('a3','2026-10-10',80,'합성 정기 지출','b2')],[],business('b2'))]);
 assert.deepEqual(result[0].accounts.map(item=>[item.account.id,item.expenses,item.afterExpenses,item.requiredTopUp]),[['a1',300,-200,200],['a2',100,4900,0]]);
 assert.equal(result[0].requiredTopUp,200);assert.equal(result[0].knownRequiredTopUp,200);assert.equal(result[0].expenses,400);
 assert.equal(result[1].requiredTopUp,30);assert.equal(result[1].accounts[0].expenses,80);
});

test('날짜 미정 기간 예산도 전액 포함하며 특정 부족 시작일은 단정하지 않는다',()=>{
 const result=funding(dataset({accounts:[account('a1','b1',100)]}),[estimate([dated('a1','2026-10-15',90),dated('a1','2026-10-05',60)],[undated('a1',75)])])[0];
 const item=result.accounts[0];
 assert.equal(item.datedExpenses,150);assert.equal(item.undatedExpenses,75);assert.equal(item.expenses,225);assert.equal(item.requiredTopUp,125);
 assert.equal(item.firstDatedShortfall,null);
 assert.deepEqual(item.items.map(row=>[row.date,row.amount]),[['2026-10-05',60],['2026-10-15',90],[null,75]]);
 assert.deepEqual([item.items[2].from,item.items[2].to],['2026-10-01','2026-10-30']);
 assert.equal(result.expenses,225);
});

test('일부 잔액이 미확인이어도 다른 통장의 부족액은 계산하고 전체 합계는 확정하지 않는다',()=>{
 const result=funding(dataset({accounts:[account('known','b1',50),account('unknown','b1',99999,null)]}),[estimate([dated('known','2026-10-01',100),dated('unknown','2026-10-01',300)])])[0];
 assert.equal(result.accounts[0].requiredTopUp,50);assert.equal(result.accounts[1].expenses,300);assert.equal(result.accounts[1].afterExpenses,null);assert.equal(result.accounts[1].requiredTopUp,null);
 assert.equal(result.accounts[1].firstDatedShortfall,null);assert.equal(result.requiredTopUp,null);assert.equal(result.knownRequiredTopUp,50);assert.equal(result.unknownAccountCount,1);assert.equal(result.expenses,400);
});

test('충돌 잔액의 근거를 유지하고 개시잔액이나 0으로 대체하지 않는다',()=>{
 const row=(id:string,amount:number,balance:number):Transaction=>({id,business_id:'b1',account_id:'a1',upload_id:null,txn_date:'2026-09-20',amount,direction:'out',balance,description:'합성 거래',raw_gwamok:'',category_id:null,is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false});
 const result=funding(dataset({transactions:[row('first',100,900),row('disconnected',200,400)]}),[estimate([dated('a1','2026-10-01',100)])])[0];
 assert.equal(result.accounts[0].snapshot.source,'conflict');assert.equal(result.accounts[0].snapshot.balance,null);assert.equal(result.requiredTopUp,null);
});

test('0원·음수 잔액·계좌 없음은 구분하고 지출이 없더라도 음수 잔액은 보충액에 포함한다',()=>{
 const data=dataset({businesses:[business('b1'),business('empty')],accounts:[account('zero','b1',0),account('negative','b1',-150)]});
 for(const basis of ['estimated','registered'] as const){
  const result=funding(data,[],basis);
  assert.deepEqual(result[0].accounts.map(item=>[item.expenses,item.afterExpenses,item.requiredTopUp]),[[0,0,0],[0,-150,150]],basis);
  assert.equal(result[0].requiredTopUp,150,basis);assert.equal(result[0].expenses,0,basis);
  assert.equal(result[0].accounts[0].calculationStatus,basis);
  assert.deepEqual(result[1].accounts,[],basis);assert.equal(result[1].requiredTopUp,null,basis);
 }
});

test('등록 지출은 단일 계좌에도 임의 배분하지 않고 사업자 미지정 목록으로 남긴다',()=>{
 const data=dataset({recurring:[recurring('later','2026-10-20',300),recurring('earlier','2026-10-02',200),recurring('income','2026-10-01',10000,'in')]});
 const result=funding(data,[estimate([dated('a1','2026-10-01',999)])],'registered')[0];
 assert.equal(result.expenses,500);assert.equal(result.unassignedExpenses,500);assert.equal(result.requiredTopUp,null);assert.equal(result.knownRequiredTopUp,0);assert.equal(result.unknownAccountCount,1);
 assert.deepEqual(result.unassignedItems.map(item=>[item.date,item.amount]),[['2026-10-02',200],['2026-10-20',300]]);
 const item=result.accounts[0];
 assert.equal(item.snapshot.balance,1000);assert.equal(item.expenses,null);assert.equal(item.afterExpenses,null);assert.equal(item.requiredTopUp,null);assert.equal(item.calculationStatus,'unassigned');assert.deepEqual(item.items,[]);
});

test('등록 지출이 없고 수입만 있으면 계좌별 부족액에 수입을 넣지 않는다',()=>{
 const data=dataset({accounts:[account('a1','b1',-200)],recurring:[recurring('income','2026-10-01',999999,'in')]});
 const result=funding(data,[],'registered')[0];
 assert.equal(result.accounts[0].expenses,0);assert.equal(result.accounts[0].requiredTopUp,200);assert.equal(result.unassignedExpenses,0);assert.equal(result.requiredTopUp,200);
});

test('삭제·다른 사업자 계좌를 가리키는 추정 항목도 빠뜨리지 않고 미지정 지출로 남긴다',()=>{
 const data=dataset({businesses:[business('b1'),business('b2')],accounts:[account('a1','b1',50),account('a2','b2',500)]});
 const result=funding(data,[estimate([dated('a1','2026-10-01',100),dated('missing','2026-10-02',75),dated('a2','2026-10-03',30),dated('a1','2026-10-04',20,'잘못된 사업자 참조','b2')],[undated('missing',25)])])[0];
 assert.equal(result.accounts[0].expenses,100);assert.equal(result.accounts[0].requiredTopUp,50);
 assert.equal(result.unassignedExpenses,150);assert.equal(result.unassignedItems.length,4);assert.equal(result.expenses,250);assert.equal(result.requiredTopUp,null);assert.equal(result.knownRequiredTopUp,50);
 assert.match(result.unassignedItems[0].note,/계좌 확인 필요/);
});

test('부족 시작일은 같은 날 지출을 합쳐 누적하고 연도를 포함한 날짜순으로 계산한다',()=>{
 const data=dataset({accounts:[account('a1','b1',100)]});
 const result=funding(data,[estimate([dated('a1','2027-01-01',30,'새해'),dated('a1','2026-12-31',60,'연말 첫째'),dated('a1','2026-12-31',40,'연말 둘째'),dated('a1','2027-01-02',10,'후속')])])[0];
 assert.equal(result.accounts[0].firstDatedShortfall,'2027-01-01');
 assert.deepEqual(result.accounts[0].items.map(item=>item.date),['2026-12-31','2026-12-31','2027-01-01','2027-01-02']);
 assert.equal(result.accounts[0].requiredTopUp,40);
});

test('이미 음수인 잔액을 미래 지출일부터 부족해지는 것으로 표시하지 않는다',()=>{
 const result=funding(dataset({accounts:[account('a1','b1',-100)]}),[estimate([dated('a1','2026-10-15',200)])])[0];
 assert.equal(result.accounts[0].requiredTopUp,300);
 assert.equal(result.accounts[0].firstDatedShortfall,null);
});

test('실제 계획·추정 계산기 결과를 그대로 소비하고 입력 배열·맵·자료를 변경하지 않는다',()=>{
 const row=(id:string,month:string,day:string,amount:number,account_id:string):Transaction=>({id,business_id:'b1',account_id,upload_id:null,txn_date:`2026-${month}-${day}`,amount,direction:'out',balance:null,description:account_id==='a1'?'합성 임대료':'합성 비정기 구독',raw_gwamok:'',category_id:null,is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false});
 const data=dataset({accounts:[account('a1','b1',1000),account('a2','b1',1000)],transactions:[row('j1','06','05',100,'a1'),row('j2','07','05',100,'a1'),row('j3','08','05',100,'a1'),row('u1','06','03',100,'a2'),row('u2','07','15',100,'a2'),row('u3','08','26',100,'a2')]});
 const plans=buildCashPlan(data,'2026-09-30').businesses;
 const estimates=buildCashEstimates(data,'2026-09-30').businesses;
 const byBusiness=new Map(estimates.map(item=>[item.business.id,item]));
 const before=JSON.stringify([data,plans,estimates,[...byBusiness]]);
 const result=buildAccountFunding(plans,byBusiness,'estimated');
 assert.equal(result[0].expenses,estimates[0].total);
 assert.equal(result[0].accounts[0].datedExpenses,100);assert.equal(result[0].accounts[1].undatedExpenses,97);
 assert.equal(JSON.stringify([data,plans,estimates,[...byBusiness]]),before);
});
