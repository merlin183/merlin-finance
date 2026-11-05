import test from 'node:test';
import assert from 'node:assert/strict';
import {cashPlanChangesSchema,type CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {cashPlanPaymentConfirmationChange} from '../lib/finance/cash-plan-payment-confirmation';
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
