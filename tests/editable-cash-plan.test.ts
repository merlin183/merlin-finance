import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildRemainingCashEstimatesForRange,cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import {buildCurrentCashForecast} from '../lib/finance/cash-plan';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {buildFundingReport} from '../lib/finance/funding-report';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

const range={from:'2026-10-01',to:'2026-10-31'},asOf='2026-10-02';
const row=(id:string,date:string,amount:number,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',txn_date:date,amount,balance:null,direction:'out',description:'합성 서비스',upload_id:null,raw_gwamok:'',category_id:'fee',is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const history=(amount=100,days=[15,15,15],extra:Partial<Transaction>={})=>['07','08','09'].map((month,index)=>row(`history-${month}`,`2026-${month}-${String(days[index]).padStart(2,'0')}`,amount,extra));
const dataset=(transactions:Transaction[]=history(),extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,
 businesses:[{id:'b1',name:'합성 사업자',representative:'',kind:'법인',reserve:10,color:'#123456'}],
 accounts:[{id:'a1',business_id:'b1',name:'원본 계좌',bank:'합성 은행',masked_number:'0001',opening_balance:1000,opening_balance_date:'2026-09-30'},{id:'a2',business_id:'b1',name:'계획 계좌',bank:'합성 은행',masked_number:'0002',opening_balance:1000,opening_balance_date:'2026-09-30'}],
 categories:[{id:'fee',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true}],transactions,...extra});
const groupKey=cashEstimateSourceKey(row('key','2026-10-01',1));
const edit=(extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:'edit-1',business_id:'b1',source_type:'estimated',source_key:groupKey,month:'2026-10',title:'편집 서비스',account_id:'a1',plan_date:'2026-10-15',amount:120,memo:'합성 메모',excluded:false,version:1,updated_at:'2026-10-02T00:00:00Z',...extra});
const funding=(model:ReturnType<typeof buildEditableCashPlan>,basis:'estimated'|'registered'='estimated')=>buildAccountFunding(model.plan.businesses,new Map(model.estimates.businesses.map(item=>[item.business.id,item])),basis)[0];

test('편집이 없으면 기존 잔여 예산과 일치하고 금액이 소진되어도 편집 항목은 남는다',()=>{
 for(const days of [[15,15,15],[1,1,1],[5,15,25]]){
  const data=dataset([...history(100,days),row('actual','2026-10-02',40)]);
  const model=buildEditableCashPlan(data,range,asOf,[]),legacy=buildRemainingCashEstimatesForRange(data,range,asOf);
  assert.equal(model.estimates.businesses[0].total,legacy.businesses[0].total);
  assert.deepEqual(model.estimates.businesses[0].dated.map(item=>[item.date,item.amount]),legacy.businesses[0].dated.map(item=>[item.date,item.amount]));
  assert.deepEqual(model.estimates.businesses[0].undated.map(item=>[item.month,item.amount]),legacy.businesses[0].undated.map(item=>[item.month,item.amount]));
 }
 const model=buildEditableCashPlan(dataset([...history(),row('actual','2026-10-02',150)]),range,asOf,[]);
 assert.equal(model.estimates.businesses[0].total,0);assert.equal(model.items.length,1);
 assert.equal(model.items[0].amount,100);assert.equal(model.items[0].recordedAmount,150);assert.equal(model.items[0].remainingAmount,0);
});

test('월 전체 수정 예산에서 신규 실적을 계속 빼며 초과 지출을 다른 월로 전가하지 않는다',()=>{
 const selected={from:'2026-10-01',to:'2026-11-30'},override=edit({amount:200});
 const beforeData=dataset([...history(),row('partial','2026-10-01',40)]),before=JSON.stringify(beforeData);
 const initial=buildEditableCashPlan(beforeData,selected,asOf,[override]);
 const updated=buildEditableCashPlan({...beforeData,transactions:[...beforeData.transactions,row('new','2026-10-02',70)]},selected,asOf,[override]);
 assert.deepEqual(initial.estimates.businesses[0].dated.map(item=>[item.date,item.amount]),[['2026-10-15',160],['2026-11-15',100]]);
 assert.deepEqual(updated.estimates.businesses[0].dated.map(item=>[item.date,item.amount]),[['2026-10-15',90],['2026-11-15',100]]);
 const over=buildEditableCashPlan(dataset([...history(),row('over','2026-10-01',300)]),selected,asOf,[override]);
 assert.deepEqual(over.estimates.businesses[0].dated.map(item=>[item.date,item.amount]),[['2026-11-15',100]]);
 assert.equal(JSON.stringify(beforeData),before);assert.equal(override.amount,200);
});

test('품목·계좌 변경은 실적 정체성을 바꾸지 않고 지정한 계좌의 계획과 필요액에 반영한다',()=>{
 const data=dataset([...history(),row('original-payment','2026-10-01',40),row('other-account','2026-10-02',70,{account_id:'a2'}),row('other-party','2026-10-02',90,{description:'다른 상대방'})]);
 const model=buildEditableCashPlan(data,range,asOf,[edit({account_id:'a2',amount:200,title:'바뀐 품목'})]);
 const item=model.items[0],accounts=funding(model).accounts;
 assert.equal(item.source_key,groupKey);assert.equal(item.sourceAccountId,'a1');assert.equal(item.accountId,'a2');
 assert.equal(item.recordedAmount,40);assert.equal(item.remainingAmount,160);
 assert.equal(accounts[0].expenses,0);assert.equal(accounts[1].expenses,160);
 assert.equal(accounts[1].items[0].title,'바뀐 품목');assert.match(accounts[1].items[0].note,/합성 메모/);
});

test('새 은행 basic/detail 실적은 기존 편집 키와 계획 계좌를 유지한 채 원본 예산에서만 차감한다',()=>{
 const originalLabel='SYNTHETIC INS002',source=history(178376,[5,5,5],{description:originalLabel,source_details:{basic:originalLabel}});
 const originalKey=cashEstimateSourceKey(source[0]);
 const saved=edit({source_key:originalKey,title:'사용자 수정 보험 계획',amount:200000,account_id:'a2',plan_date:'2026-10-05'});
 const actual=row('clobe-new','2026-10-05',178376,{description:`합성 보험회사 · ${originalLabel}`,source_details:{basic:'합성 보험회사',detail:originalLabel}});
 const wrongAccount=row('wrong-account','2026-10-05',99999,{...actual,id:'wrong-account',account_id:'a2'});
 const data=dataset([...source,actual,wrongAccount]),before=JSON.stringify({data,saved});
 const model=buildEditableCashPlan(data,range,'2026-10-07',[saved]);
 const item=model.items[0];
 assert.equal(item.source_key,originalKey);assert.equal(item.sourceAccountId,'a1');assert.equal(item.accountId,'a2');
 assert.equal(item.title,saved.title);assert.equal(item.date,saved.plan_date);assert.equal(item.amount,200000);
 assert.equal(item.recordedAmount,178376);assert.equal(item.remainingAmount,21624);
 assert.equal(model.estimates.businesses[0].undated[0].expectedDate,'2026-10-05');
 assert.equal(funding(model).accounts[0].expenses,0);assert.equal(funding(model).accounts[1].expenses,21624);
 assert.equal(JSON.stringify({data,saved}),before);
});

test('원본 반복 근거가 사라진 상대방 편집 예산이 있으면 description 예산으로 이중 차감하지 않는다',()=>{
 const label='SYNTHETIC INS002';
 const actual=row('actual','2026-10-02',40,{description:`상대방 A · ${label}`,source_details:{counterparty:'상대방 A',detail:label}});
 const originalKey=cashEstimateSourceKey(row('key','2026-09-15',100,{description:label}));
 const saved=edit({source_key:cashEstimateSourceKey(actual),title:'저장된 상대방 A 계획',amount:100});
 const data=dataset([...history(100,[15,15,15],{description:label}),actual]);
 const model=buildEditableCashPlan(data,range,asOf,[saved]);
 const base=model.items.find(item=>item.source_key===originalKey)!,counterparty=model.items.find(item=>item.source_key===saved.source_key)!;
 assert.equal(base.recordedAmount,0);assert.equal(base.remainingAmount,100);
 assert.equal(counterparty.recordedAmount,40);assert.equal(counterparty.remainingAmount,60);
 assert.equal(model.estimates.businesses[0].total,160);
});

test('모든 월 제외는 정확한 사업자·계좌·원본 그룹에만 적용하고 복원하면 원본 추정으로 돌아간다',()=>{
 const data=dataset([...history(),...history(50,[15,15,15],{account_id:'a2'})]);
 const selected={from:'2026-10-01',to:'2026-11-30'},excluded=edit({id:'global',month:'*',plan_date:null,excluded:true});
 const hidden=buildEditableCashPlan(data,selected,asOf,[excluded,edit({amount:900})]);
 assert.equal(hidden.estimates.businesses[0].total,100);
 assert.equal(hidden.plan.businesses[0].balance,buildEditableCashPlan(data,selected,asOf,[]).plan.businesses[0].balance);
 assert.ok(hidden.items.filter(item=>item.source_key===groupKey).every(item=>item.excluded));
 assert.ok(hidden.items.filter(item=>item.sourceAccountId==='a2').every(item=>!item.excluded));
 const restored=buildEditableCashPlan(data,selected,asOf,[]);
 assert.equal(restored.estimates.businesses[0].total,300);
 const monthOnly=buildEditableCashPlan(data,selected,asOf,[edit({excluded:true})]);
 assert.equal(monthOnly.estimates.businesses[0].total,200);
});

test('날짜를 먼저 수정한 다음 조회기간을 거르며 지난 잔여 예상일은 날짜 미정으로 남긴다',()=>{
 const selected={from:'2026-10-10',to:'2026-10-20'},data=dataset(history(100,[25,25,25]));
 const key=cashEstimateSourceKey(data.transactions[0]);
 assert.equal(buildEditableCashPlan(data,selected,asOf,[]).estimates.businesses[0].total,0);
 const moved=buildEditableCashPlan(data,selected,asOf,[edit({source_key:key,plan_date:'2026-10-10'})]);
 assert.equal(moved.estimates.businesses[0].dated[0].date,'2026-10-10');assert.equal(moved.estimates.businesses[0].total,120);
 const outside=buildEditableCashPlan(data,selected,asOf,[edit({source_key:key,plan_date:'2026-10-21'})]);
 assert.equal(outside.estimates.businesses[0].total,0);assert.equal(outside.items[0].inRange,false);
 const overdue=buildEditableCashPlan(dataset(),range,asOf,[edit({plan_date:'2026-10-01'})]);
 assert.equal(overdue.estimates.businesses[0].dated.length,0);
 assert.equal(overdue.estimates.businesses[0].undated[0].expectedDate,'2026-10-01');
 const today=buildEditableCashPlan(dataset(),range,asOf,[edit({plan_date:'2026-10-02'})]);
 assert.equal(today.estimates.businesses[0].dated[0].date,asOf);
});

test('날짜 미정 수정액은 월 전체 예산을 한 번만 안분하고 해당 조회기간 실적만 차감한다',()=>{
 const data=dataset([...history(),row('outside','2026-10-01',50),row('inside','2026-10-16',40),row('future','2026-10-25',80)]);
 const model=buildEditableCashPlan(data,{from:'2026-10-15',to:'2026-10-31'},'2026-10-20',[edit({plan_date:null,amount:310})]);
 const item=model.estimates.businesses[0].undated[0];
 assert.equal(item.monthlyAmount,310);assert.equal(item.originalAmount,170);assert.equal(item.recordedAmount,40);assert.equal(item.amount,130);
 assert.equal(model.items[0].amount,310);assert.equal(model.items[0].recordedAmount,90);assert.equal(model.items[0].remainingAmount,130);
});

test('원본 반복 근거가 사라져도 월 수정 계획과 전체 제외 복원 항목은 유지한다',()=>{
 const model=buildEditableCashPlan(dataset([]),range,asOf,[edit()]);
 assert.equal(model.items[0].edit?.id,'edit-1');assert.equal(model.estimates.businesses[0].total,120);
 const excluded=buildEditableCashPlan(dataset([]),range,asOf,[edit({month:'*',plan_date:null,excluded:true})]);
 assert.equal(excluded.items.length,1);assert.equal(excluded.items[0].globalEdit?.id,'edit-1');assert.equal(excluded.items[0].excluded,true);assert.equal(excluded.estimates.businesses[0].total,0);
});

test('직접 추가는 두 조회 기준에 각각 한 번 반영되고 이름이 같은 실적을 지급으로 추측하지 않는다',()=>{
 const manual=edit({id:'manual-edit',source_type:'manual',source_key:'manual-1',amount:80,title:'직접 계획'});
 const data=dataset([row('same-title','2026-10-01',80,{description:'직접 계획'})]);
 const model=buildEditableCashPlan(data,range,asOf,[manual]);
 assert.equal(model.estimates.businesses[0].total,80);assert.equal(model.plan.businesses[0].expenses,80);
 assert.equal(model.items[0].recordedAmount,0);assert.equal(model.items[0].remainingAmount,80);
 assert.equal(funding(model,'estimated').accounts[0].expenses,80);assert.equal(funding(model,'registered').accounts[0].expenses,80);
 const report=buildFundingReport(model.plan.businesses,new Map(model.estimates.businesses.map(item=>[item.business.id,item])),'registered',range,asOf);
 assert.equal(report.businesses[0].funding.expenses,80);
 const overdue=buildEditableCashPlan(data,range,asOf,[{...manual,plan_date:'2026-10-01'}]);
 assert.equal(overdue.plan.businesses[0].undatedExpenses?.[0].amount,80);assert.equal(overdue.plan.businesses[0].unconfirmedExpenses?.length,0);
 assert.equal(overdue.estimates.businesses[0].undated[0].expectedDate,'2026-10-01');
 assert.ok(buildCurrentCashForecast(overdue.plan).every(point=>point.b1===null));
 const today=buildEditableCashPlan(data,range,asOf,[{...manual,plan_date:asOf}]);
 assert.equal(today.estimates.businesses[0].dated[0].date,asOf);assert.equal(today.plan.businesses[0].scheduledExpenses[0].date,asOf);
 assert.equal(buildCurrentCashForecast(today.plan)[0].b1,today.plan.businesses[0].balance!-80);
});

test('등록 일정의 명시 계좌를 배분하고 지난 등록 일정은 확인 전 재차감하지 않는다',()=>{
 const recurring={id:'r1',business_id:'b1',title:'등록 계획',amount:100,direction:'out' as const,start_date:'2026-01-15',end_date:null,day:15,frequency:'monthly' as const};
 const data=dataset([],{recurring:[recurring]});
 const saved=edit({source_type:'registered',source_key:'r1',account_id:'a2',amount:80});
 const model=buildEditableCashPlan(data,range,asOf,[saved]);
 assert.equal(model.plan.businesses[0].expenses,80);assert.equal(model.estimates.businesses[0].total,0);
 assert.equal(funding(model,'registered').accounts[0].expenses,0);assert.equal(funding(model,'registered').accounts[1].expenses,80);
 assert.equal(funding(model,'registered').unassignedItems.length,0);
 assert.equal(buildCurrentCashForecast(model.plan).at(-1)?.b1,1920);
 const missingDate=buildEditableCashPlan(data,range,asOf,[{...saved,plan_date:null}]);
 assert.equal(funding(missingDate,'registered').accounts[1].undatedExpenses,80);assert.equal(missingDate.plan.businesses[0].expenses,80);
 assert.ok(buildCurrentCashForecast(missingDate.plan).every(point=>point.b1===null));
 const past=buildEditableCashPlan(data,range,asOf,[{...saved,plan_date:'2026-10-01'}]);
 assert.equal(past.plan.businesses[0].expenses,0);assert.equal(past.plan.businesses[0].unconfirmedExpenses?.[0].amount,80);assert.equal(past.plan.businesses[0].afterExpenses,null);
});

test('다른 월 날짜·잘못된 날짜를 적용하지 않고 다른 사업자 계좌를 자금 배분에 사용하지 않는다',()=>{
 for(const date of ['2026-11-15','2026-10-32']){
  const model=buildEditableCashPlan(dataset(),range,asOf,[edit({plan_date:date})]);
  assert.equal(model.items[0].edit,undefined);assert.equal(model.estimates.businesses[0].total,100);
 }
 const data=dataset();data.accounts.push({id:'foreign',business_id:'b2',name:'다른 사업자',bank:'합성',masked_number:'9999',opening_balance:10000,opening_balance_date:'2026-09-30'});
 const model=buildEditableCashPlan(data,range,asOf,[edit({account_id:'foreign'})]);
 assert.equal(model.items[0].accountId,null);assert.equal(funding(model).unassignedExpenses,120);assert.equal(funding(model).requiredTopUp,null);
});
