import test from 'node:test';
import assert from 'node:assert/strict';
import {cashPlanPlannedPaymentChange} from '../lib/finance/cash-plan-planned-payment';
import {cashPlanChangesSchema,type CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {cashPlanPaymentConfirmationChange} from '../lib/finance/cash-plan-payment-confirmation';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildCashPlanWorksheetModel} from '../lib/finance/cash-plan-worksheet-model';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {buildFundingTimeline} from '../lib/finance/funding-timeline';
import {cashPlanUserMemo} from '../lib/finance/cash-plan-memo';
import {addDays,today} from '../lib/finance/format';
import {emptyDataset,type Dataset} from '../lib/finance/types';

const businessId='10000000-0000-4000-8000-000000000001',accountId='10000000-0000-4000-8000-000000000002',editId='10000000-0000-4000-8000-000000000003';
const range={from:'2027-04-01',to:'2027-04-30'},asOf='2027-04-13';
const dataset:Dataset={...emptyDataset,businesses:[{id:businessId,name:'Synthetic company',representative:'',kind:'법인',reserve:0,color:'#123456'}],accounts:[{id:accountId,business_id:businessId,name:'Synthetic account',bank:'Synthetic bank',masked_number:'0001',opening_balance:200,opening_balance_date:'2027-03-31'}]};
const saved=(extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:editId,business_id:businessId,source_type:'manual',source_key:editId,month:'2027-04',title:'Synthetic card bill',account_id:accountId,plan_date:'2027-04-15',amount:300,memo:'[clobe-card-bill:synthetic-bill]\n대체 계획 키: synthetic-source\nOriginal user memo',excluded:false,payment_kind:'general',payment_status:'pending',version:3,updated_at:'2027-04-12T00:00:00Z',...extra});
const model=(edit:CashPlanEdit)=>buildEditableCashPlan(dataset,range,asOf,[edit]);
const item=(edit=saved())=>model(edit).items[0];
function applied(edit:CashPlanEdit,change:ReturnType<typeof cashPlanPlannedPaymentChange>):CashPlanEdit{
 const {action,...fields}=change;assert.equal(action,'save');return {...edit,...fields,version:fields.version+1};
}

test('예정 날짜·금액은 save로 저장하고 실제 출금 확인의 미래일 제한은 유지한다',()=>{
 const future=addDays(today(),35),edit=saved({month:future.slice(0,7),plan_date:future});
 const source={...item(),month:edit.month,date:future,edit};
 const change=cashPlanPlannedPaymentChange(source,{date:future,amount:550,memo:'New memo'});
 assert.equal(change.action,'save');assert.equal(change.plan_date,future);assert.equal(change.amount,550);
 assert.equal(cashPlanChangesSchema.safeParse({changes:[change]}).success,true);
 const confirmation=cashPlanPaymentConfirmationChange(source,{date:future,amount:550,complete:true});
 assert.equal(cashPlanChangesSchema.safeParse({changes:[confirmation]}).success,false);
 assert.ok(!Object.keys(change).some(key=>key.startsWith('confirmed_')||key.startsWith('confirmation_')));
});

test('예정 수정은 원본 식별자·계좌·CAS·상태와 카드 provenance를 보존한다',()=>{
 const original=saved(),source=item(original),before=JSON.stringify({original,source});
 const change=cashPlanPlannedPaymentChange(source,{amount:600,date:'2027-04-20',memo:'Updated note'});
 assert.deepEqual([change.id,change.version,change.business_id,change.source_type,change.source_key,change.month,change.title,change.account_id,change.payment_kind,change.payment_status,change.excluded],
  [original.id,original.version,original.business_id,original.source_type,original.source_key,original.month,original.title,original.account_id,'general','pending',false]);
 assert.equal(change.memo,'[clobe-card-bill:synthetic-bill]\n대체 계획 키: synthetic-source\nUpdated note');
 assert.equal(cashPlanUserMemo(change.memo),'Updated note');
 assert.equal(cashPlanPlannedPaymentChange(source,{amount:600,date:'2027-04-20',memo:''}).memo,'[clobe-card-bill:synthetic-bill]\n대체 계획 키: synthetic-source');
 assert.equal(JSON.stringify({original,source}),before);
});

test('미래 청구 예정액은 남은 지출과 해당 지급일의 계좌 필요자금에 반영하고 지급 완료로 처리하지 않는다',()=>{
 const original=saved(),change=cashPlanPlannedPaymentChange(item(original),{amount:600,date:'2027-04-20',memo:'Confirmed future invoice'}),updated=applied(original,change),editable=model(updated);
 const worksheet=buildCashPlanWorksheetModel({data:dataset,editable,basis:'registered',range,asOf}).businesses[0].rows[0];
 assert.deepEqual([worksheet.date,worksheet.originalAmount,worksheet.recordedAmount,worksheet.remainingAmount,worksheet.status],['2027-04-20',600,null,600,'confirmation-needed']);
 assert.equal(worksheet.confirmation,null);assert.equal(updated.confirmed_date,undefined);assert.equal(updated.confirmation_complete,undefined);
 const funding=buildAccountFunding(editable.plan.businesses,new Map(editable.estimates.businesses.map(row=>[row.business.id,row])),'registered');
 assert.equal(funding[0].accounts[0].expenses,600);assert.equal(funding[0].accounts[0].afterExpenses,-400);
 const timeline=buildFundingTimeline(funding,range,asOf),day=timeline.days.find(row=>row.date==='2027-04-20')!;
 assert.equal(day.accounts[0].expenses,600);assert.equal(day.accounts[0].additionalTopUp,400);
 assert.equal(timeline.days.find(row=>row.date==='2027-04-15')?.accounts[0].expenses,0);
 assert.equal(dataset.transactions.length,0);
});

test('기존 일부·완료 확인은 계획 수정으로 제거하거나 새로운 미래 출금으로 바꾸지 않는다',()=>{
 for(const complete of [false,true]){
  const original=saved({confirmed_amount:80,confirmed_date:'2027-04-10',confirmation_complete:complete,confirmation_memo:'Saved actual proof'});
  const change=cashPlanPlannedPaymentChange(item(original),{amount:600,date:'2027-04-20',memo:'Future plan note'}),updated=applied(original,change);
  const editable=model(updated),review=buildCashPlanWorksheetModel({data:dataset,editable,basis:'registered',range,asOf}).businesses[0].rows[0];
  assert.deepEqual([updated.confirmed_amount,updated.confirmed_date,updated.confirmation_complete,updated.confirmation_memo],[80,'2027-04-10',complete,'Saved actual proof']);
  assert.equal(review.recordedAmount,80);assert.equal(review.remainingAmount,complete?0:520);assert.equal(review.confirmation?.date,'2027-04-10');
  assert.equal(review.date,'2027-04-20');assert.equal(review.originalAmount,600);
 }
});

test('제외·세금·월 밖 날짜·잘못된 금액은 거부하며 날짜 미정과 0원은 기존 계획 규칙을 따른다',()=>{
 const source=item();
 for(const values of [{date:'2027-05-01',amount:100,memo:''},{date:'2027-04-31',amount:100,memo:''},{date:'2027-04-20',amount:-1,memo:''},{date:'2027-04-20',amount:1.1,memo:''},{date:'2027-04-20',amount:Number.MAX_SAFE_INTEGER+1,memo:''}])assert.throws(()=>cashPlanPlannedPaymentChange(source,values));
 assert.throws(()=>cashPlanPlannedPaymentChange({...source,excluded:true},{amount:100,date:'2027-04-20',memo:''}),/복원/);
 assert.throws(()=>cashPlanPlannedPaymentChange({...source,paymentKind:'tax'},{amount:100,date:'2027-04-20',memo:''}),/세금/);
 assert.throws(()=>cashPlanPlannedPaymentChange({...source,paymentKind:undefined,edit:saved({payment_kind:'tax'})},{amount:100,date:'2027-04-20',memo:''}),/세금/);
 const zero=cashPlanPlannedPaymentChange(source,{amount:0,date:null,memo:''});assert.equal(zero.amount,0);assert.equal(zero.plan_date,null);
});

test('저장되지 않은 추정·등록 원본도 기존 identity를 유지하며 신규 override로 저장한다',()=>{
 for(const source_type of ['estimated','registered'] as const){
  const source={...item(),source_type,source_key:source_type==='estimated'?'synthetic-source-group':editId,edit:undefined};
  const change=cashPlanPlannedPaymentChange(source,{amount:500,date:'2027-04-20',memo:cashPlanUserMemo(source.memo)});
  assert.equal(change.version,0);assert.notEqual(change.id,editId);assert.equal(change.source_type,source_type);assert.equal(change.source_key,source.source_key);
  assert.equal(change.memo,source.memo);assert.equal(cashPlanChangesSchema.safeParse({changes:[change]}).success,true);
 }
});
