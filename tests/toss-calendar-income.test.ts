import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileTossSettlements} from '../lib/toss/reconcile';
import type {TossMerchant,TossSettlement,TossSettlementGroup} from '../lib/toss/types';
import {tossCalendarIncome,tossCashForecastPlan,tossFundingIncome} from '../lib/finance/toss-funding';
import {buildCashPlan} from '../lib/finance/cash-plan';
import {buildLatestCashBalances} from '../lib/finance/latest-cash-balances';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

const range={from:'2026-11-01',to:'2026-11-30'},payoutDate='2026-11-03';
const merchant:TossMerchant={merchantId:'synthetic-mid',businessId:'synthetic-business',accountId:'synthetic-account',label:'합성 상점'};
const dataset=():Dataset=>({...emptyDataset,businesses:[{id:merchant.businessId,name:'합성 사업자',representative:'',kind:'법인',reserve:0,color:'#123456'}],accounts:[{id:merchant.accountId,business_id:merchant.businessId,name:'합성 입금 통장',bank:'합성 은행',masked_number:'0001',opening_balance:20,opening_balance_date:range.from}]});
const settlement=(patch:Partial<TossSettlement>={}):TossSettlement=>({merchant_id:merchant.merchantId,transaction_key:'synthetic-provider-1',payment_key:'synthetic-payment-1',business_id:merchant.businessId,account_id:merchant.accountId,paid_out_date:payoutDate,sold_date:'2026-11-01',amount:100,pay_out_amount:100,fee_amount:0,synced_at:'2026-11-02T00:00:00.000Z',...patch});
const deposit=(patch:Partial<Transaction>={}):Transaction=>({id:'synthetic-bank-1',business_id:merchant.businessId,account_id:merchant.accountId,upload_id:null,txn_date:payoutDate,amount:100,direction:'in',description:'주식회사 토스페이먼츠',raw_gwamok:'',category_id:null,is_internal:false,balance:120,tax_invoice:false,dedup_hash:'synthetic-bank',manually_classified:false,...patch});
const group=(patch:Partial<TossSettlementGroup>={}):TossSettlementGroup=>({id:'synthetic-group',businessId:merchant.businessId,accountId:merchant.accountId,date:payoutDate,merchantIds:[merchant.merchantId],amount:100,receivedAmount:0,pendingAmount:100,status:'pending',matchedTransactionIds:[],reason:null,...patch});

test('11/2 → 11/3 → 11/4에도 같은 정산을 원래 지급일에 유지하고 미확인은 현금에 더하지 않는다',()=>{
 const data=dataset(),rows=[settlement()],original=JSON.stringify({data,rows});
 const labels=['입금 예정','오늘 입금 확인 필요','지급일 경과 · 입금 확인 필요'];
 const statuses=['pending','confirmation-needed','overdue'];
 let originalKey='';
 for(const [index,asOf] of ['2026-11-02','2026-11-03','2026-11-04'].entries()){
  const groups=reconcileTossSettlements(data,rows,[merchant],asOf),calendar=tossCalendarIncome(groups,range,asOf);
  assert.equal(calendar.length,1);assert.equal(calendar[0].date,payoutDate);assert.equal(calendar[0].amount,100);
  assert.equal(calendar[0].label,labels[index]);assert.equal(calendar[0].status,statuses[index]);assert.equal(calendar[0].noCash,true);
  if(originalKey)assert.equal(calendar[0].key,originalKey);else originalKey=calendar[0].key;
  assert.equal(tossFundingIncome(groups,range,asOf).reduce((sum,row)=>sum+row.amount,0),index===0?100:0);
  assert.equal(calendar[0].pendingAmount,index===0?100:0);
  assert.equal(buildLatestCashBalances(data,asOf).businesses[0].accounts[0].snapshot.balance,20);
 }
 assert.equal(JSON.stringify({data,rows}),original);
});

test('오늘 입금이 일치하면 달력에 완료로 남고 현재 잔액·현금 시나리오에는 재가산하지 않는다',()=>{
 const data=dataset();data.transactions=[deposit()];
 const original=JSON.stringify(data);
 for(const asOf of [payoutDate,'2026-11-04']){
  const groups=reconcileTossSettlements(data,[settlement()],[merchant],asOf),calendar=tossCalendarIncome(groups,range,asOf);
  assert.equal(calendar.length,1);assert.equal(calendar[0].status,'received');assert.equal(calendar[0].label,'입금 완료');
  assert.equal(calendar[0].amount,100);assert.equal(calendar[0].receivedAmount,100);assert.equal(calendar[0].differenceAmount,0);assert.equal(calendar[0].pendingAmount,0);
  assert.deepEqual(calendar[0].matchedTransactionIds,['synthetic-bank-1']);assert.deepEqual(tossFundingIncome(groups,range,asOf),[]);
  const plan=buildCashPlan(data,asOf),forecast=tossCashForecastPlan(plan,tossFundingIncome(groups,range,asOf));
  assert.equal(forecast.businesses[0].income,0);assert.equal(forecast.businesses[0].projected,plan.businesses[0].afterExpenses);
  assert.equal(buildLatestCashBalances(data,asOf).businesses[0].accounts[0].snapshot.balance,120);
 }
 assert.equal(JSON.stringify(data),original);
});

test('분할 입금은 한 번만 확인하고 일부·과입금 차액을 확정 잔금으로 사용하지 않는다',()=>{
 const data=dataset();
 data.transactions=[deposit({amount:40,balance:60}),deposit({id:'synthetic-bank-2',amount:60,balance:120}),deposit({id:'synthetic-bank-2',amount:60,balance:120})];
 let groups=reconcileTossSettlements(data,[settlement()],[merchant],payoutDate),calendar=tossCalendarIncome(groups,range,payoutDate);
 assert.equal(calendar.length,1);assert.equal(calendar[0].status,'received');assert.equal(calendar[0].receivedAmount,100);
 assert.deepEqual(calendar[0].matchedTransactionIds,['synthetic-bank-1','synthetic-bank-2']);
 for(const [amount,label,difference] of [[40,'부분 입금 · 차액 확인',60],[110,'입금 차액 확인',-10]] as const){
  data.transactions=[deposit({amount,balance:20+amount})];
  groups=reconcileTossSettlements(data,[settlement()],[merchant],payoutDate);calendar=tossCalendarIncome(groups,range,payoutDate);
  assert.equal(calendar[0].status,'confirmation-needed');assert.equal(calendar[0].label,label);
  assert.equal(calendar[0].amount,100);assert.equal(calendar[0].receivedAmount,amount);assert.equal(calendar[0].differenceAmount,difference);assert.equal(calendar[0].pendingAmount,0);
  assert.equal(calendar[0].noCash,true);assert.deepEqual(tossFundingIncome(groups,range,payoutDate),[]);
 }
});

test('취소는 원본 순정산액에 이미 포함되며 0·음수·원본 충돌은 완료 입금으로 표시하지 않는다',()=>{
 const data=dataset(),asOf='2026-11-02',positive=settlement(),cancel=(amount:number)=>settlement({transaction_key:'synthetic-cancel',amount,pay_out_amount:amount});
 let groups=reconcileTossSettlements(data,[positive,cancel(-20)],[merchant],asOf),calendar=tossCalendarIncome(groups,range,asOf);
 assert.equal(calendar[0].amount,80);assert.equal(calendar[0].status,'pending');assert.equal(tossFundingIncome(groups,range,asOf)[0].amount,80);
 groups=reconcileTossSettlements(data,[positive,cancel(-100)],[merchant],asOf);calendar=tossCalendarIncome(groups,range,asOf);
 assert.equal(calendar.length,1);assert.equal(calendar[0].amount,0);assert.equal(calendar[0].status,'zero');assert.equal(calendar[0].label,'정산액 0');assert.match(calendar[0].reason??'',/통장 입금 완료를 뜻하지/);assert.deepEqual(tossFundingIncome(groups,range,asOf),[]);
 groups=reconcileTossSettlements(data,[cancel(-25)],[merchant],asOf);calendar=tossCalendarIncome(groups,range,asOf);
 assert.equal(calendar[0].amount,-25);assert.equal(calendar[0].status,'adjustment');assert.equal(calendar[0].label,'정산 차감액 확인');assert.deepEqual(tossFundingIncome(groups,range,asOf),[]);
 groups=reconcileTossSettlements(data,[positive,settlement({pay_out_amount:80})],[merchant],asOf);calendar=tossCalendarIncome(groups,range,asOf);
 assert.equal(calendar[0].status,'confirmation-needed');assert.match(calendar[0].reason??'',/같은 정산 거래/);assert.equal(calendar[0].pendingAmount,0);assert.deepEqual(tossFundingIncome(groups,range,asOf),[]);
});

test('달력은 양 끝 지급일을 포함하고 같은 그룹·계좌일의 중복을 한 번만 표시한다',()=>{
 const first=group({date:range.from}),last=group({id:'last',date:range.to});
 const groups=[first,{...first,merchantIds:[...first.merchantIds]},last,group({id:'outside-before',date:'2026-10-31'}),group({id:'outside-after',date:'2026-12-01'})];
 const original=JSON.stringify(groups),calendar=tossCalendarIncome(groups,range,'2026-10-30');
 assert.deepEqual(calendar.map(row=>row.date),[range.from,range.to]);assert.equal(calendar.reduce((sum,row)=>sum+row.amount,0),200);
 assert.equal(tossCalendarIncome([first,{...first,id:'duplicate-scope'}],range).length,1);
 assert.equal(JSON.stringify(groups),original);
});

test('같은 그룹 ID나 계좌일의 충돌은 합산하지 않고 확인 필요 한 건으로 보수적으로 표시한다',()=>{
 const first=group();
 for(const second of [{...first,amount:200,pendingAmount:200},{...first,id:'alias',amount:200,pendingAmount:200},{...first,date:'2026-11-04'}]){
  const input=[first,second],original=JSON.stringify(input),calendar=tossCalendarIncome(input,range,'2026-11-02');
  assert.equal(calendar.length,1);assert.equal(calendar[0].amount,100);assert.equal(calendar[0].status,'confirmation-needed');assert.equal(calendar[0].label,'정산 자료 확인 필요');
  assert.equal(calendar[0].pendingAmount,0);assert.equal(calendar[0].noCash,true);assert.match(calendar[0].reason??'',/같은 정산 묶음/);assert.equal(JSON.stringify(input),original);
 }
});

test('잘못된 기간·날짜·금액·빈 연결은 표시하지 않으며 사업자·계좌를 섞지 않는다',()=>{
 const source=group(),bad:Partial<TossSettlementGroup>[]=[{id:''},{businessId:' '},{accountId:''},{date:'2026-02-30'},{amount:NaN},{amount:Number.MAX_SAFE_INTEGER+1},{receivedAmount:-1},{pendingAmount:-1},{receivedAmount:0.5}];
 assert.deepEqual(tossCalendarIncome(bad.map(patch=>({...source,...patch})),range),[]);
 assert.deepEqual(tossCalendarIncome([source],{from:range.to,to:range.from}),[]);
 assert.deepEqual(tossCalendarIncome([source],{from:'2026-02-30',to:range.to}),[]);
 assert.deepEqual(tossCalendarIncome([source],range,'2026-02-30'),[]);
 const others=[source,group({id:'other-account',accountId:'synthetic-account-2'}),group({id:'other-business',businessId:'synthetic-business-2',accountId:'synthetic-account-3'})];
 const calendar=tossCalendarIncome(others,range,'2026-11-02');assert.equal(calendar.length,3);
 assert.deepEqual(calendar.map(row=>[row.businessId,row.accountId]),[[merchant.businessId,merchant.accountId],[merchant.businessId,'synthetic-account-2'],['synthetic-business-2','synthetic-account-3']]);
 const data=dataset();
 for(const mappings of [[],[{...merchant,businessId:'unmapped-business'}],[{...merchant,accountId:'unmapped-account'}]]){
  assert.deepEqual(tossCalendarIncome(reconcileTossSettlements(data,[settlement()],mappings,'2026-11-02'),range),[]);
 }
});
