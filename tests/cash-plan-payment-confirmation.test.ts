import test from 'node:test';
import assert from 'node:assert/strict';
import {cashPlanChangesSchema,type CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {cashPlanPaymentConfirmation,cashPlanPaymentConfirmationChange,cashPlanPaymentConfirmationNetAmount} from '../lib/finance/cash-plan-payment-confirmation';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildCashPlanWorksheetModel} from '../lib/finance/cash-plan-worksheet-model';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {buildFundingReport} from '../lib/finance/funding-report';
import {buildCurrentCashForecast} from '../lib/finance/cash-plan';
import {cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

const bid='10000000-0000-4000-8000-000000000001',aid='10000000-0000-4000-8000-000000000002',eid='10000000-0000-4000-8000-000000000003';
const range={from:'2026-10-01',to:'2026-10-31'},asOf='2026-10-13';
const row=(id:string,date:string,amount:number):Transaction=>({id,business_id:bid,account_id:aid,txn_date:date,amount,balance:null,direction:'out',description:'Synthetic service',upload_id:null,raw_gwamok:'',category_id:'fees',is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false});
const history=['07','08','09'].map(month=>row(`past-${month}`,`2026-${month}-15`,100));
const data=(actual=0):Dataset=>({...emptyDataset,businesses:[{id:bid,name:'Synthetic company',representative:'',kind:'법인',reserve:0,color:'#123456'}],accounts:[{id:aid,business_id:bid,name:'Synthetic account',bank:'Synthetic bank',masked_number:'0001',opening_balance:1000,opening_balance_date:'2026-09-30'}],categories:[{id:'fees',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true}],transactions:[...history,...(actual?[row('bank-actual','2026-10-10',actual)]:[])]});
const edit=(extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:eid,business_id:bid,source_type:'estimated',source_key:cashEstimateSourceKey(history[0]),month:'2026-10',title:'Saved service',account_id:aid,plan_date:'2026-10-15',amount:100,memo:'Original memo',excluded:false,version:2,updated_at:'2026-10-12T00:00:00Z',confirmed_amount:40,confirmed_date:'2026-10-10',confirmation_complete:false,confirmation_memo:'Confirmed from bank',...extra});
const model=(dataset:Dataset,edits:CashPlanEdit[],selected=range)=>buildEditableCashPlan(dataset,selected,asOf,edits);
const returnEdit=(extra:Partial<CashPlanEdit>={},returnedAmount=30,returnedDate='2026-10-12'):CashPlanEdit=>{
 const source=edit({confirmed_amount:80,...extra}),item=model(data(),[source]).items.find(item=>item.source_key===source.source_key)!;
 const change=cashPlanPaymentConfirmationChange(item,{amount:source.confirmed_amount!,date:source.confirmed_date!,complete:source.confirmation_complete!,memo:source.confirmation_memo,returnedAmount,returnedDate});
 return {...source,confirmation_memo:change.confirmation_memo};
};

test('부분 출금 확인과 나중에 적용한 동일 은행 실적은 한번만 차감하고 잔액은 그대로다',()=>{
 const saved=edit(),dataset=data(),before=JSON.stringify({saved,dataset});
 const initial=model(dataset,[saved]),same=model(data(40),[saved]),more=model(data(70),[saved]);
 assert.equal(initial.items[0].remainingAmount,60);assert.equal(same.items[0].remainingAmount,60);assert.equal(more.items[0].remainingAmount,30);
 assert.equal(initial.plan.businesses[0].balance,model(dataset,[]).plan.businesses[0].balance);
 assert.equal(JSON.stringify({saved,dataset}),before);
});

test('완료 확인은 원래 추정액과 날짜를 보존하고 필요금액·팝업·예측에서 남은 계획만 제거한다',()=>{
 const saved=edit({source_type:'manual',source_key:eid,plan_date:'2026-10-15',amount:200,confirmed_amount:130,confirmation_complete:true});
 const dataset=data(),complete=model(dataset,[saved]),pending=model(dataset,[{...saved,confirmed_amount:null,confirmed_date:null,confirmation_complete:false,confirmation_memo:''}]);
 const item=complete.items.find(item=>item.source_type==='manual')!;
 assert.deepEqual([item.amount,item.date,item.remainingAmount],[200,'2026-10-15',0]);
 assert.equal(complete.plan.businesses[0].expenses,0);assert.equal(pending.plan.businesses[0].expenses,200);
 const estimates=new Map(complete.estimates.businesses.map(row=>[row.business.id,row]));
 const fund=buildAccountFunding(complete.plan.businesses,estimates,'registered')[0];
 assert.equal(fund.expenses,0);assert.equal(fund.accounts[0].afterExpenses,1000);
 assert.equal(buildFundingReport(complete.plan.businesses,estimates,'registered',range,asOf).businesses[0].funding.expenses,0);
 assert.equal(buildCurrentCashForecast(complete.plan).at(-1)?.[bid],1000);
 const worksheet=buildCashPlanWorksheetModel({data:dataset,editable:complete,basis:'registered',range,asOf});
 const view=worksheet.businesses[0].rows[0];
 assert.deepEqual([view.originalAmount,view.recordedAmount,view.remainingAmount,view.status],[200,130,0,'confirmed']);
 assert.equal(view.confirmation?.memo,'Confirmed from bank');assert.equal(view.editorItem.edit?.id,eid);
});

test('부분 확인된 지난 등록 일정은 남은 예산으로 남고 임의 미래 날짜로 이동하지 않는다',()=>{
 const recurring={id:eid,business_id:bid,title:'Registered payment',amount:100,direction:'out' as const,start_date:'2026-10-05',end_date:null,day:5,frequency:'once' as const};
 const saved=edit({source_type:'registered',source_key:eid,plan_date:'2026-10-05'}),dataset={...data(),recurring:[recurring]},plan=model(dataset,[saved]);
 assert.equal(plan.plan.businesses[0].unconfirmedExpenses?.length,0);assert.equal(plan.plan.businesses[0].undatedExpenses?.[0].amount,60);
 assert.equal(plan.plan.businesses[0].undatedExpenses?.[0].expectedDate,'2026-10-05');assert.equal(plan.plan.businesses[0].expenses,60);
 assert.ok(buildCurrentCashForecast(plan.plan).every(point=>point[bid]===null));
});

test('날짜 미정 부분 확인은 해당 선택구간에만 차감하고 다음 월에 영향을 주지 않는다',()=>{
 const saved=edit({plan_date:null,amount:310,confirmed_amount:40,confirmed_date:'2026-10-02'});
 const later=model(data(),[saved],{from:'2026-10-10',to:'2026-10-20'});assert.equal(later.items[0].remainingAmount,110);
 const both=model(data(),[saved],{from:'2026-10-01',to:'2026-11-30'});
 assert.equal(both.items.find(item=>item.month==='2026-10')?.remainingAmount,270);
 assert.equal(both.items.find(item=>item.month==='2026-11')?.remainingAmount,100);
});

test('확인 해제는 자동 실적 기반으로 돌아오고 제외·세금·다른 월·미래 확인은 보호한다',()=>{
 const baseline=edit(),cleared={...baseline,confirmed_amount:null,confirmed_date:null,confirmation_complete:false,confirmation_memo:''};
 assert.equal(model(data(30),[cleared]).items[0].remainingAmount,70);
 for(const patch of [{confirmed_date:'2026-09-30'},{confirmed_date:'2026-10-14'},{confirmed_amount:Number.MAX_SAFE_INTEGER+1},{confirmed_date:'2026-10-32'}])assert.equal(model(data(),[edit(patch)]).items[0].remainingAmount,100);
 assert.equal(model(data(),[edit({excluded:true})]).items[0].remainingAmount,0);
 const tax=edit({source_type:'manual',source_key:eid,payment_kind:'tax',payment_status:'pending'});
 assert.equal(model(data(),[tax]).items.find(item=>item.source_type==='manual')?.remainingAmount,100);
});

test('확인 API schema는 날짜·금액·소유권·중복·완료 상태를 검증하며 helper는 원본 계획을 보존한다',()=>{
 const item=model(data(),[]).items[0],change=cashPlanPaymentConfirmationChange(item,{amount:40,date:'2026-10-10',complete:false,memo:'User checked'});
 assert.ok(cashPlanChangesSchema.safeParse({changes:[change]}).success);assert.equal(change.version,0);
 assert.equal(change.amount,item.amount);assert.equal(change.plan_date,item.date);assert.equal(change.source_key,item.source_key);
 for(const patch of [{confirmed_amount:0},{confirmed_amount:-1},{confirmed_amount:0.5},{confirmed_amount:Number.MAX_SAFE_INTEGER+1},{confirmed_date:'2026-09-30'},{confirmed_date:'2099-10-01'},{confirmed_date:null},{confirmed_amount:null},{excluded:true},{owner_id:bid},{payment_kind:'tax'},{confirmation_memo:'x'.repeat(2001)}])assert.equal(cashPlanChangesSchema.safeParse({changes:[{...change,...patch}]}).success,false);
 assert.equal(cashPlanChangesSchema.safeParse({changes:[change,change]}).success,false);
 const saved=model(data(),[edit()]).items[0],clear=cashPlanPaymentConfirmationChange(saved,null);
 assert.ok(cashPlanChangesSchema.safeParse({changes:[clear]}).success);assert.equal(clear.confirmed_amount,null);assert.equal(clear.confirmation_memo,'');
 assert.throws(()=>cashPlanPaymentConfirmationChange(item,null));
 assert.throws(()=>cashPlanPaymentConfirmationChange({...item,paymentKind:'tax'},{amount:1,date:'2026-10-10',complete:true}));
});

test('명시 반환은 기존 확인 메모에 원자적으로 저장하고 원래 출금·순지출·사용자 메모를 분리한다',()=>{
 const item=model(data(),[]).items[0],userMemo='  Receipt checked\nKeep this note  ';
 const change=cashPlanPaymentConfirmationChange(item,{amount:80,date:'2026-10-10',complete:false,memo:userMemo,returnedAmount:30,returnedDate:'2026-10-12'});
 assert.ok(cashPlanChangesSchema.safeParse({changes:[change]}).success);
 assert.equal(change.confirmed_amount,80);assert.equal('returnedAmount' in change,false);assert.match(change.confirmation_memo,/^\[cash-plan-return:v1:/);
 const saved=edit({...change}),confirmation=cashPlanPaymentConfirmation(saved,asOf)!;
 assert.deepEqual(confirmation,{amount:80,date:'2026-10-10',complete:false,memo:userMemo,returnedAmount:30,returnedDate:'2026-10-12'});
 assert.equal(cashPlanPaymentConfirmationNetAmount(80,confirmation),50);
 const legacy=cashPlanPaymentConfirmation(edit({confirmed_amount:40}),asOf)!;
 assert.deepEqual(legacy,{amount:40,date:'2026-10-10',complete:false,memo:'Confirmed from bank'});
 assert.equal(cashPlanPaymentConfirmationNetAmount(80,legacy),80);
});

test('반환 후 남은 예산만 복구하고 이후 추가 출금은 순지출에 합산하며 원본과 현재 잔액을 바꾸지 않는다',()=>{
 const saved=returnEdit(),dataset=data(80),before=JSON.stringify({saved,dataset});
 const returned=model(dataset,[saved]),withoutReturn=model(dataset,[edit({confirmed_amount:80})]);
 assert.deepEqual([returned.items[0].recordedAmount,returned.items[0].confirmedAmount,returned.items[0].remainingAmount],[80,80,50]);
 assert.equal(withoutReturn.items[0].remainingAmount,20);
 assert.equal(returned.plan.businesses[0].balance,withoutReturn.plan.businesses[0].balance);
 const estimates=new Map(returned.estimates.businesses.map(item=>[item.business.id,item]));
 assert.equal(returned.estimates.businesses[0].total,50);
 assert.equal(buildAccountFunding(returned.plan.businesses,estimates,'estimated')[0].expenses,50);
 assert.equal(buildFundingReport(returned.plan.businesses,estimates,'estimated',range,asOf).businesses[0].funding.expenses,50);
 assert.equal(model(data(120),[saved]).items[0].remainingAmount,10);
 assert.equal(model(data(150),[saved]).items[0].remainingAmount,0);
 assert.equal(JSON.stringify({saved,dataset}),before);
 const worksheet=buildCashPlanWorksheetModel({data:dataset,editable:returned,basis:'estimated',range,asOf}).businesses[0];
 assert.equal(worksheet.rows[0].recordedAmount,80);assert.equal(worksheet.rows[0].displayDateIsActual,true);
 assert.equal(worksheet.rows[0].recordedPaymentDates[0].amount,80);assert.equal(worksheet.actualOnlyRows.length,0);
});

test('전액 반환은 출금 확인액 양수를 보존하면서 순지출 0과 미완료 예산을 구분한다',()=>{
 const saved=returnEdit({},80),confirmation=cashPlanPaymentConfirmation(saved,asOf)!;
 assert.equal(confirmation.amount,80);assert.equal(cashPlanPaymentConfirmationNetAmount(80,confirmation),0);
 assert.equal(model(data(80),[saved]).items[0].remainingAmount,100);
 assert.equal(model(data(80),[{...saved,confirmation_complete:true}]).items[0].remainingAmount,0);
 const item=model(data(80),[saved]).items[0],clear=cashPlanPaymentConfirmationChange(item,null);
 assert.equal(clear.confirmation_memo,'');
 assert.equal(model(data(80),[edit({...clear})]).items[0].remainingAmount,20);
});

test('반환일은 마지막 누적 출금일보다 이를 수 있으며 날짜 미정 계획은 반환일의 조회구간만 반영한다',()=>{
 const saved=returnEdit({plan_date:null,amount:310,confirmed_amount:80,confirmed_date:'2026-10-10'},30,'2026-10-12');
 assert.equal(model(data(80),[saved]).items[0].remainingAmount,260);
 assert.equal(model(data(80),[saved],{from:'2026-10-01',to:'2026-10-10'}).items[0].remainingAmount,20);
 assert.equal(model(data(80),[saved],{from:'2026-10-11',to:'2026-10-13'}).items[0].remainingAmount,30);
 const earlierReturn=returnEdit({plan_date:null,amount:310,confirmed_amount:100,confirmed_date:'2026-10-11'},30,'2026-10-08');
 assert.equal(cashPlanPaymentConfirmation(earlierReturn,asOf)?.returnedDate,'2026-10-08');
 assert.equal(model(data(80),[earlierReturn],{from:'2026-10-01',to:'2026-10-10'}).items[0].remainingAmount,50);
});

test('미래·다른 달·비정상·중복 반환 표식은 은행 실적을 줄이지 않고 내부 표식도 메모에 노출하지 않는다',()=>{
 const marker=(value:unknown,version='v1')=>`[cash-plan-return:${version}:${encodeURIComponent(JSON.stringify(value))}]`;
 const invalid=[marker({amount:30,date:'2026-10-14'}),marker({amount:30,date:'2026-09-30'}),marker({amount:30,date:'2026-10-32'}),marker({amount:0,date:'2026-10-12'}),marker({amount:-1,date:'2026-10-12'}),marker({amount:81,date:'2026-10-12'}),marker({amount:Number.MAX_SAFE_INTEGER+1,date:'2026-10-12'}),marker({amount:'30',date:'2026-10-12'}),marker({amount:30,date:'2026-10-12',extra:true}),marker({amount:30,date:'2026-10-12'},'v2'),'[cash-plan-return:v1:%malformed]'];
 const valid=marker({amount:30,date:'2026-10-12'});invalid.push(valid+'\n'+valid);
 for(const stored of invalid){
  const saved=edit({confirmed_amount:80,confirmation_memo:stored+'\nVisible note'}),confirmation=cashPlanPaymentConfirmation(saved,asOf)!;
  assert.equal(confirmation.returnedAmount,undefined);assert.equal(confirmation.memo,'Visible note');
  assert.equal(cashPlanPaymentConfirmationNetAmount(80,confirmation),80);
  assert.equal(model(data(80),[saved]).items[0].remainingAmount,20);
 }
});

test('반환 저장은 잘못된 금액·날짜·붙여넣은 내부 표식과 전체 메모 길이를 거부하며 반환 없음은 기존 메모를 보존한다',()=>{
 const item=model(data(),[]).items[0],base={amount:80,date:'2026-10-10',complete:false,memo:'Original memo'};
 for(const patch of [{returnedAmount:-1,returnedDate:'2026-10-12'},{returnedAmount:81,returnedDate:'2026-10-12'},{returnedAmount:30.5,returnedDate:'2026-10-12'},{returnedAmount:30,returnedDate:'2026-09-30'},{returnedAmount:30,returnedDate:'2026-10-32'},{returnedAmount:30},{returnedDate:'2026-10-12'}])assert.throws(()=>cashPlanPaymentConfirmationChange(item,{...base,...patch}));
 for(const memo of ['[cash-plan-return:v1:any]','note [cash-plan-return:v2:any]'])assert.throws(()=>cashPlanPaymentConfirmationChange(item,{...base,memo}));
 assert.throws(()=>cashPlanPaymentConfirmationChange(item,{...base,memo:'x'.repeat(2000),returnedAmount:30,returnedDate:'2026-10-12'}));
 assert.equal(cashPlanPaymentConfirmationChange(item,{...base,memo:'x'.repeat(2000)}).confirmation_memo.length,2000);
 assert.equal(cashPlanPaymentConfirmationChange(item,{...base,returnedAmount:0,returnedDate:'2026-10-12'}).confirmation_memo,'Original memo');
});
