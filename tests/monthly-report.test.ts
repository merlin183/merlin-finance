import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMonthlyReport,monthlyReportMetrics} from '../lib/finance/monthly-report';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildCashPlanWorksheetModel} from '../lib/finance/cash-plan-worksheet-model';
import {cashPlanEstimateOptions} from '../lib/finance/cash-plan-policy';
import {cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {emptyDataset,type Category,type Dataset,type Transaction} from '../lib/finance/types';

const month='2026-10',asOf='2026-10-21',range={from:'2026-10-01',to:'2026-10-31'};
const category=(id:string,name:string,extra:Partial<Category>={}):Category=>({id,name,group_name:'합성 분류',is_internal:false,is_operating:true,...extra});
const row=(id:string,amount:number,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',txn_date:'2026-10-10',amount,direction:'out',description:'합성 서비스',upload_id:null,raw_gwamok:'',category_id:'fees',is_internal:false,balance:null,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const dataset=(transactions:Transaction[]=[],extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,
 businesses:[{id:'b1',name:'합성 사업자 A',representative:'',kind:'법인',reserve:0,color:'#123456'},{id:'b2',name:'합성 사업자 B',representative:'',kind:'법인',reserve:0,color:'#654321'}],
 accounts:[{id:'a1',business_id:'b1',name:'합성 통장 A',bank:'합성 은행',masked_number:'0001',opening_balance:1000,opening_balance_date:'2026-09-30'},{id:'a2',business_id:'b2',name:'합성 통장 B',bank:'합성 은행',masked_number:'0002',opening_balance:2000,opening_balance_date:'2026-09-30'}],
 categories:[category('sales','매출'),category('fees','지급수수료'),category('internal','계좌간이체',{is_internal:true}),category('payroll','급여'),category('bonus','상여금')],transactions,...extra,
});
const history=(name='합성 반복 서비스',amount=100)=>['07','08','09'].map(m=>row(`history-${name}-${m}`,amount,{txn_date:`2026-${m}-25`,description:name}));
const edit=(source:Transaction,extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:'edit-1',business_id:'b1',source_type:'estimated',source_key:cashEstimateSourceKey(source),month,title:'사용자 수정 계획',account_id:'a1',plan_date:'2026-10-27',amount:200,memo:'합성 메모',excluded:false,version:1,updated_at:'2026-10-20T00:00:00Z',...extra});

test('월 양끝과 기준일까지만 현금 실적에 포함하고 매출은 저장된 매출 입금만 사용한다',()=>{
 const data=dataset([
  row('previous',99,{txn_date:'2026-09-30',direction:'in',category_id:'sales'}),
  row('month-first',10,{txn_date:'2026-10-01',direction:'in',category_id:'sales'}),
  row('today',20,{txn_date:asOf,direction:'in',category_id:'sales'}),
  row('tomorrow',900,{txn_date:'2026-10-22',direction:'in',category_id:'sales'}),
  row('month-last',30,{txn_date:'2026-10-31',direction:'in',category_id:'sales'}),
  row('next',999,{txn_date:'2026-11-01',direction:'in',category_id:'sales'}),
  row('fees-in',40,{direction:'in'}),row('unmapped-in',50,{direction:'in',category_id:null}),
  row('sales-out',60,{category_id:'sales'}),
 ]);
 const report=buildMonthlyReport(data,[],month,asOf),first=report.businesses[0];
 assert.deepEqual(report.range,range);assert.deepEqual(report.actualRange,{from:'2026-10-01',to:asOf});
 assert.equal(first.sales.amount,30);assert.deepEqual(first.sales.transactions.map(t=>t.id),['month-first','today']);
 assert.equal(first.otherIncome.amount,90);assert.equal(first.externalOutflow.amount,60);assert.equal(first.metrics.other.amount,60);
 assert.equal(first.lastTransactionDate,asOf);assert.equal(report.businesses[1].sales.amount,0);assert.equal(report.businesses[1].lastTransactionDate,null);
 const finished=buildMonthlyReport(data,[],month,'2026-11-10');
 assert.equal(finished.totals.sales,960);assert.equal(finished.actualRange?.to,'2026-10-31');
 const future=buildMonthlyReport(data,[],'2026-11',asOf);
 assert.equal(future.actualRange,null);assert.equal(future.totals.sales,0);assert.equal(future.totals.externalOutflow,0);
});

test('모든 외부 출금을 한 비용행에만 집계하고 미분류·기타·보험금·카드대금을 보존한다',()=>{
 const groups=[
  ['payroll','급여','payroll',11],['bonus','상여금','payroll',12],['rent','임차료','rent',13],['management','관리비','rent',14],
  ['ads','광고선전비','advertising',15],['ins','보험료','insurance',16],['insurance-money','보험금','insurance',17],
  ['phone','통신비','telecom',18],['fees','지급수수료','fees',19],['tax','세금과공과','taxes',20],
  ['retire','퇴직금','retirement',21],['card','카드대금결제','cards',22],
  ['refund','현금환불','refundUnknown',23],['cash','현금출금','refundUnknown',24],['misc','잡비용','refundUnknown',25],
  ['other','비품','other',26],['unmapped','미매핑','unmapped',27],
 ] as const;
 const data=dataset(groups.map(([id,,,amount])=>row(id,amount,{category_id:id})),{
  categories:groups.map(([id,name])=>category(id,name,{is_fixed:true})),
 });
 data.transactions.push(row('missing-category',28,{category_id:null}),row('deleted-category',29,{category_id:'unknown'}));
 const result=buildMonthlyReport(data,[],month,asOf).businesses[0];
 assert.equal(result.externalOutflow.amount,groups.reduce((sum,[,,,n])=>sum+n,0)+57);
 assert.equal(result.metrics.payroll.amount,23);assert.equal(result.metrics.insurance.amount,33);
 assert.equal(result.metrics.refundUnknown.amount,72);assert.equal(result.metrics.cards.amount,22);assert.equal(result.metrics.unmapped.amount,84);
 const expenseCells=monthlyReportMetrics.filter(m=>m.kind==='expense').map(m=>result.metrics[m.id]);
 assert.equal(expenseCells.reduce((sum,cell)=>sum+cell.amount,0),result.externalOutflow.amount);
 assert.deepEqual(expenseCells.flatMap(cell=>cell.transactions.map(t=>t.id)).sort(),data.transactions.map(t=>t.id).sort());
 assert.equal(result.checks.find(check=>check.id.endsWith(':unmapped'))?.transactions.length,3);
});

test('내부이동과 대여금은 제외하되 분리된 수수료는 외부 비용·원본 식별자로 한 번 반영한다',()=>{
 const transfer=row('transfer',100500,{category_id:'internal',is_internal:true,transfer_fee_amount:500,transfer_fee_category_id:'fees'});
 const data=dataset([
  transfer,row('transfer-in',100000,{direction:'in',category_id:'internal',is_internal:true,business_id:'b2',account_id:'a2'}),
  row('category-internal',3000,{category_id:'internal',is_internal:false}),row('flag-internal',4000,{category_id:'fees',is_internal:true}),
  row('normal-fee',700),
 ]);
 const report=buildMonthlyReport(data,[],month,asOf),first=report.businesses[0];
 assert.equal(first.externalOutflow.amount,1200);assert.equal(first.metrics.fees.amount,1200);assert.equal(report.totals.otherIncome,0);
 const projected=first.metrics.fees.transactions.find(t=>t.accounting_component==='fee')!;
 assert.equal(projected.id,'transfer:fee');assert.equal(projected.accounting_source_id,'transfer');assert.equal(projected.accounting_source_amount,100500);assert.equal(projected.amount,500);
 assert.equal(transfer.amount,100500);assert.equal(transfer.balance,null);assert.equal(data.transactions.length,5);
});

test('남은 계획은 저장된 수정·제외와 같은 계산을 사용하며 다음달 세금을 섞지 않는다',()=>{
 const source=history(),excludedHistory=history('합성 제외 서비스',50),actual=row('partial',40,{description:source[0].description});
 const data=dataset([...source,...excludedHistory,actual]);
 const edits=[edit(source[0]),edit(excludedHistory[0],{id:'excluded',excluded:true}),
  edit(source[0],{id:'manual',source_type:'manual',source_key:'synthetic-manual',title:'월말 직접 추가',amount:300,plan_date:'2026-10-31'}),
  edit(source[0],{id:'tax',source_type:'manual',source_key:'synthetic-tax',month:'2026-11',title:'다음달 세금',plan_date:'2026-11-02',amount:900,payment_kind:'tax'}),
 ];
 const expected=buildEditableCashPlan(data,range,asOf,edits),worksheet=buildCashPlanWorksheetModel({data,editable:expected,basis:'estimated',range,asOf});
 const result=buildMonthlyReport(data,edits,month,asOf),first=result.businesses[0];
 assert.equal(first.remainingTotal,worksheet.businesses[0].remainingTotal);assert.equal(first.remainingTotal,expected.estimates.businesses[0].total);
 assert.equal(first.remainingTotal,460);assert.equal(first.remainingDated,460);assert.equal(first.remainingUndated,0);
 assert.equal(first.externalOutflow.amount,40);assert.equal(first.forecastOutflow,500);
 assert.deepEqual(first.remainingPlan.map(item=>[item.title,item.date,item.amount]),[['사용자 수정 계획','2026-10-27',160],['월말 직접 추가','2026-10-31',300]]);
 assert.equal(first.remainingPlan[0].transactions[0].id,'partial');assert.ok(!first.remainingPlan.some(item=>item.title==='다음달 세금'));
});

test('지난 날짜와 날짜 미정 잔여 예산을 유지하고 직접 완료 확인을 실적에 더하지 않는다',()=>{
 const source=history(),other=history('합성 날짜 미정',90),confirmed=history('합성 완료 서비스',70);
 const data=dataset([...source,...other,...confirmed]);
 const edits=[edit(source[0],{amount:120,plan_date:'2026-10-15'}),edit(other[0],{id:'undated',amount:90,plan_date:null}),
  edit(confirmed[0],{id:'confirmed',amount:70,plan_date:'2026-10-10',confirmed_amount:70,confirmed_date:'2026-10-10',confirmation_complete:true}),
 ];
 const result=buildMonthlyReport(data,edits,month,asOf).businesses[0];
 assert.equal(result.externalOutflow.amount,0);assert.equal(result.remainingTotal,210);assert.equal(result.forecastOutflow,210);
 assert.equal(result.remainingDated,0);assert.equal(result.remainingUndated,210);
 assert.deepEqual(result.remainingPlan.map(item=>[item.status,item.date,item.expectedDate,item.amount]),[['date-passed',null,'2026-10-15',120],['undated',null,null,90]]);
 assert.ok(!result.remainingPlan.some(item=>item.key.includes('합성 완료 서비스')));
});

test('원본 분류 검토는 현재 분류를 바꾸지 않으며 환불 후보를 매출로 합산하지 않는다',()=>{
 const data=dataset([
  row('source-sale',100,{direction:'in',source_details:{note:'Clobe 원본 분류(표시용): 매출'}}),
  row('refund-like',50,{direction:'in',source_details:{note:'Clobe 원본 분류(표시용): 지급수수료'}}),
  row('source-loan',30,{category_id:'payroll',source_details:{note:'Clobe 원본 분류(표시용): 대여금 상환'}}),
  row('source-rent',20,{source_details:{note:'Clobe 원본 분류(표시용): 임차료'}}),
  row('text-mention',10,{category_id:'payroll',source_details:{basic:'대출이란 글자가 있는 보통 적요'}}),
 ]);
 const report=buildMonthlyReport(data,[],month,asOf),first=report.businesses[0];
 assert.equal(first.sales.amount,0);assert.equal(first.otherIncome.amount,150);assert.equal(first.metrics.payroll.amount,40);assert.equal(first.metrics.fees.amount,20);
 const checkIds=(suffix:string)=>first.checks.find(check=>check.id.endsWith(`:${suffix}`))?.transactions.map(t=>t.id);
 assert.deepEqual(checkIds('sales-category'),['source-sale']);assert.deepEqual(checkIds('fee-income'),['refund-like']);
 assert.deepEqual(checkIds('payroll-source'),['source-loan']);assert.deepEqual(checkIds('rent-source'),['source-rent']);
 assert.equal(data.transactions[0].category_id,'fees');
});

test('사업자별 합계와 전체 합계가 일치하며 데이터·수정값·거래 순서를 변경하지 않는다',()=>{
 const source=history(),data=dataset([...source,row('b2-sale',500,{business_id:'b2',account_id:'a2',category_id:'sales',direction:'in'}),row('b1-fee',30,{description:source[0].description})]),edits=[edit(source[0])];
 const original=JSON.stringify({data,edits}),report=buildMonthlyReport(data,edits,month,asOf);
 assert.equal(report.totals.sales,500);assert.equal(report.totals.externalOutflow,30);assert.equal(report.totals.remainingTotal,170);assert.equal(report.totals.forecastOutflow,200);
 for(const key of ['remainingDated','remainingUndated','remainingTotal','forecastOutflow'] as const)assert.equal(report.totals[key],report.businesses.reduce((sum,business)=>sum+business[key],0));
 assert.equal(JSON.stringify({data,edits}),original);
 assert.throws(()=>buildMonthlyReport(data,edits,'2026-13',asOf),RangeError);
 assert.throws(()=>buildMonthlyReport(data,edits,month,'2026-02-30'),RangeError);
});

test('설치자가 선택한 급여 추정 제외 정책은 계획과 동일하며 실제 인건비는 그대로 보존한다',()=>{
 const data=dataset([...history('합성 급여',100).map(transaction=>({...transaction,category_id:'payroll'})),row('current-payroll',40,{category_id:'payroll',description:'합성 급여'})]);
 // Synthetic installer policy is opt-in and scoped to one business/category.
 data.businesses[0]={...data.businesses[0],name:' 예시 교육회사 '};
 const options=cashPlanEstimateOptions(data,[{businessName:'예시교육회사',categoryName:'급여'}]),expected=buildEditableCashPlan(data,range,asOf,[],options);
 const report=buildMonthlyReport(data,[],month,asOf,options);
 assert.deepEqual(options.excludedBusinessCategories,[{businessId:'b1',categoryId:'payroll'}]);
 assert.equal(expected.estimates.businesses[0].total,0);assert.equal(report.businesses[0].remainingTotal,0);
 assert.equal(report.businesses[0].metrics.payroll.amount,40);assert.equal(report.totals.externalOutflow,40);
 const other=dataset(data.transactions);
 assert.equal(buildMonthlyReport(other,[],month,asOf).businesses[0].remainingTotal,60);
});
