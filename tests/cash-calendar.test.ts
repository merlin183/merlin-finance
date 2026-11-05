import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCashCalendarModel,type CashCalendarInput,type CashCalendarModel} from '../lib/finance/cash-calendar';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildCashPlanWorksheetModel} from '../lib/finance/cash-plan-worksheet-model';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';
import type {BankPlanActual,BankPlanCoverage} from '../lib/finance/clobe-plan-actuals';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

const range={from:'2027-04-01',to:'2027-04-30'},asOf='2027-04-10';
const row=(id:string,date:string,amount:number,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',txn_date:date,amount,balance:null,direction:'out',description:'합성 서비스',upload_id:null,raw_gwamok:'',category_id:'fee',is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const history=(amount=100)=>['01','02','03'].map(month=>row(`history-${month}`,`2027-${month}-15`,amount));
const dataset=(transactions:Transaction[]=history(),extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,
 businesses:[{id:'b1',name:'합성 사업자',representative:'',kind:'법인',reserve:0,color:'#123456'},{id:'b2',name:'다른 합성 사업자',representative:'',kind:'법인',reserve:0,color:'#654321'}],
 accounts:[{id:'a1',business_id:'b1',name:'원본 계좌',bank:'합성 은행',masked_number:'0001',opening_balance:1000,opening_balance_date:'2027-03-31'},{id:'a2',business_id:'b1',name:'계획 계좌',bank:'합성 은행',masked_number:'0002',opening_balance:2000,opening_balance_date:'2027-03-31'},{id:'a3',business_id:'b2',name:'다른 사업자 계좌',bank:'합성 은행',masked_number:'0003',opening_balance:3000,opening_balance_date:'2027-03-31'}],
 categories:[{id:'fee',name:'지급수수료',group_name:'영업지출',is_operating:true,is_internal:false},{id:'transfer',name:'계좌간이체',group_name:'내부이동',is_operating:false,is_internal:true},{id:'loan',name:'대여금',group_name:'내부이동',is_operating:false,is_internal:true}],transactions,...extra});
const edit=(extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:'saved-plan',business_id:'b1',source_type:'estimated',source_key:cashEstimateSourceKey(row('source',asOf,1)),month:'2027-04',title:'합성 서비스 계획',account_id:'a1',plan_date:'2027-04-15',amount:100,memo:'합성 메모',excluded:false,version:1,updated_at:`${asOf}T00:00:00Z`,...extra});
const bank=(id:string,amount:number,extra:Partial<BankPlanActual>={}):BankPlanActual=>({account_id:'a1',business_id:'b1',external_transaction_id:id,txn_date:'2027-04-06',txn_time:'10:00:00',amount,balance:1000-amount,description:'합성 서비스',party:null,source_details:{basic:'합성 서비스'},currency:'KRW',source:'clobe',collected_at:`${asOf}T08:00:00Z`,synced_at:`${asOf}T08:00:00Z`,transaction_id:null,...extra});
const coverage=(extra:Partial<BankPlanCoverage>={}):BankPlanCoverage=>({account_id:'a1',business_id:'b1',from:range.from,to:asOf,collected_at:`${asOf}T08:00:00Z`,synced_at:`${asOf}T08:00:00Z`,status:'complete',reason:null,source:'clobe',currency:'KRW',...extra});
const observed=(amount:number)=>dataset(history(),{bank_plan_actuals:amount?[bank('observation',amount)]:[],bank_plan_coverage:[coverage()]});

function prepare(data:Dataset,edits:CashPlanEdit[]=[],extra:Partial<Pick<CashCalendarInput,'range'|'asOf'|'basis'|'businessId'|'accountId'>>={}){
 const input={range,asOf,basis:'estimated' as const,...extra};
 const editable=buildEditableCashPlan(data,input.range,input.asOf,edits);
 const funding=buildAccountFunding(editable.plan.businesses,new Map(editable.estimates.businesses.map(item=>[item.business.id,item])),input.basis);
 const args={data,items:editable.items,funding,...input};
 const before=JSON.stringify(args),calendar=buildCashCalendarModel(args);
 assert.equal(JSON.stringify(args),before);
 const worksheet=buildCashPlanWorksheetModel({data,editable,range:input.range,asOf:input.asOf,basis:input.basis});
 return {calendar,args,editable,funding,worksheet};
}
const day=(calendar:CashCalendarModel,date:string)=>calendar.days.find(item=>item.date===date)!;
const entries=(calendar:CashCalendarModel)=>[...calendar.days.flatMap(item=>item.items),...calendar.undatedItems];
const actualEntries=(calendar:CashCalendarModel)=>entries(calendar).filter(item=>item.kind==='actual');

function assertTotals(calendar:CashCalendarModel){
 for(const entry of calendar.days){
  for(const [kind,amount] of [['actual',entry.actualExpenses],['planned',entry.plannedExpenses],['confirmed',entry.confirmedExpenses]] as const){
   assert.equal(entry.items.filter(item=>item.kind===kind).reduce((total,item)=>total+item.amount,0),amount);
   assert.equal(entry.businesses.reduce((total,item)=>total+(kind==='actual'?item.actualExpenses:kind==='planned'?item.plannedExpenses:item.confirmedExpenses),0),amount);
  }
 }
 assert.equal(calendar.actualExpenses,calendar.days.reduce((total,item)=>total+item.actualExpenses,0));
 assert.equal(calendar.plannedExpenses,calendar.days.reduce((total,item)=>total+item.plannedExpenses,0)+calendar.undatedPlannedExpenses);
 assert.equal(calendar.plannedExpenses,calendar.datedPlannedExpenses+calendar.undatedPlannedExpenses);
 assert.equal(calendar.confirmedExpenses,calendar.days.reduce((total,item)=>total+item.confirmedExpenses,0));
 assert.equal(calendar.undatedPlannedExpenses,calendar.undatedItems.filter(item=>item.kind==='planned').reduce((total,item)=>total+item.amount,0));
}

test('동기화 재조회 0 → 일부 → 전체 출금은 실제와 남은 예정으로 바뀌며 이전 모델을 변경하지 않는다',()=>{
 const snapshots:CashCalendarModel[]=[];
 for(const [amount,remaining] of [[0,100],[40,60],[100,0]] as const){
  const {calendar,editable,funding,worksheet}=prepare(observed(amount));
  snapshots.push(calendar);
  assert.deepEqual([calendar.actualExpenses,calendar.plannedExpenses],[amount,remaining]);
  assert.equal(day(calendar,'2027-04-06').actualExpenses,amount);
  assert.equal(day(calendar,'2027-04-15').plannedExpenses,remaining);
  assert.equal(calendar.plannedExpenses,funding.reduce((total,item)=>total+item.expenses,0));
  assert.equal(calendar.plannedExpenses,worksheet.businesses.reduce((total,item)=>total+item.remainingTotal,0));
  assert.equal(calendar.confirmedExpenses,0);
  if(amount){assert.equal(actualEntries(calendar)[0].source,'bank-query');assert.equal(actualEntries(calendar)[0].planLink,editable.items[0].key);}
  if(remaining)assert.equal(entries(calendar).find(item=>item.kind==='planned')?.planLink,editable.items[0].key);
  assertTotals(calendar);
 }
 assert.deepEqual(snapshots.map(item=>[item.actualExpenses,item.plannedExpenses]),[[0,100],[40,60],[100,0]]);
});

test('반복 월 예산의 작은 출금으로 완납을 추측하지 않으며 실제액은 예산으로 자르지 않는다',()=>{
 for(const [actual,remaining] of [[1,99],[70,30],[135,0]]){
  const {calendar}=prepare(observed(actual));
  assert.deepEqual([calendar.actualExpenses,calendar.plannedExpenses],[actual,remaining]);
  assert.equal(actualEntries(calendar)[0].amount,actual);
 }
 // A complete confirmation can close a bill below its budget. It is still
 // the observed withdrawal amount, not the original budget, on the calendar.
 const {calendar}=prepare(observed(70),[edit({confirmed_amount:70,confirmed_date:'2027-04-06',confirmation_complete:true,confirmation_memo:'합성 완료 확인'})]);
 assert.deepEqual([calendar.actualExpenses,calendar.plannedExpenses,calendar.confirmedExpenses],[70,0,0]);
});

test('실제일과 예상일, 실제계좌와 수정한 계획계좌를 분리하고 단일계좌 범위를 엄격히 적용한다',()=>{
 const data=observed(40),edits=[edit({account_id:'a2',plan_date:'2027-04-20',title:'변경한 계획'})];
 const {calendar}=prepare(data,edits);
 assert.deepEqual([day(calendar,'2027-04-06').actualExpenses,day(calendar,'2027-04-20').plannedExpenses],[40,60]);
 assert.deepEqual(actualEntries(calendar).map(item=>[item.accountId,item.date,item.title]),[['a1','2027-04-06','합성 서비스']]);
 assert.match(actualEntries(calendar)[0].note,/연결 계획: 변경한 계획/);
 assert.equal(entries(calendar).find(item=>item.kind==='planned')?.accountId,'a2');
 const original=prepare(data,edits,{accountId:'a1'}).calendar,moved=prepare(data,edits,{accountId:'a2'}).calendar;
 assert.deepEqual([original.actualExpenses,original.plannedExpenses],[40,0]);
 assert.deepEqual([moved.actualExpenses,moved.plannedExpenses],[0,60]);
});

test('원장과 은행 provider의 동일 출금 및 반복 ID는 한 번만 표시한다',()=>{
 const saved=row('saved','2027-04-06',40,{txn_time:'10:00:00',balance:960});
 for(const transaction_id of [null,saved.id]){
  const evidence=bank('same-bank',40,{transaction_id});
  const {calendar}=prepare(dataset([...history(),saved],{bank_plan_actuals:[evidence,{...evidence}],bank_plan_coverage:[coverage()]}));
  assert.equal(calendar.actualExpenses,40);assert.equal(actualEntries(calendar).length,1);
  assert.equal(actualEntries(calendar)[0].transactionId,saved.id);assert.equal(actualEntries(calendar)[0].source,'bank-query');
 }
 const duplicate=prepare(dataset([...history(),saved,{...saved}])).calendar;
 assert.equal(duplicate.actualExpenses,40);assert.equal(actualEntries(duplicate).length,1);
});

test('별도 거래 근거는 보존하고 불명확하거나 충돌하는 은행 중복은 추가 실제출금으로 만들지 않는다',()=>{
 const separate=prepare(dataset(history(),{bank_plan_actuals:[bank('first',40),bank('second',40,{txn_time:'11:00:00',balance:920})],bank_plan_coverage:[coverage()]})).calendar;
 assert.equal(separate.actualExpenses,80);assert.equal(actualEntries(separate).length,2);
 const ambiguous=prepare(dataset(history(),{bank_plan_actuals:[bank('first',40),bank('second',40)],bank_plan_coverage:[coverage()]})).calendar;
 assert.equal(ambiguous.actualExpenses,0);assert.equal(ambiguous.plannedExpenses,100);
 const collision=prepare(dataset(history(),{bank_plan_actuals:[bank('same-id',40),bank('same-id',60)],bank_plan_coverage:[coverage()]})).calendar;
 assert.equal(collision.actualExpenses,0);
 const badLedger=prepare(dataset([...history(),row('same-id','2027-04-06',20),row('same-id','2027-04-06',30)])).calendar;
 assert.equal(badLedger.actualExpenses,0);
});

test('계획 없는 출금·내부이체·대여금도 실제통장출금에 포함하며 입금과 미래 거래는 제외한다',()=>{
 const data=dataset([
  row('ordinary','2027-04-01',10,{description:'계획 없는 출금'}),
  row('internal','2027-04-02',20,{description:'합성 이체',category_id:'transfer',is_internal:true}),
  row('loan','2027-04-03',30,{description:'합성 대여',category_id:'loan'}),
  row('linked','2027-04-04',40,{description:'연결된 이동'}),
  row('incoming','2027-04-05',500,{direction:'in'}),row('future','2027-04-11',600),
  row('earlier','2027-03-31',700),row('next-month','2027-05-01',800),
 ],{links:[{id:'link',out_transaction_id:'linked',in_transaction_id:'synthetic-receipt'}]});
 const {calendar}=prepare(data);
 assert.equal(calendar.actualExpenses,100);assert.equal(actualEntries(calendar).length,4);
 assert.ok(actualEntries(calendar).every(item=>item.planLink===null));
 assert.match(actualEntries(calendar).find(item=>item.transactionId==='internal')!.note,/계좌간이체.*내부 자금 이동/);
 assert.match(actualEntries(calendar).find(item=>item.transactionId==='loan')!.note,/대여금/);
 assert.match(actualEntries(calendar).find(item=>item.transactionId==='linked')!.note,/내부 자금 이동/);
 assertTotals(calendar);
});

test('사업자 all은 부모가 넘긴 funding 범위를 확장하지 않으며 다른 소유 계좌와 미지정 예정은 섞지 않는다',()=>{
 const data=dataset([...history(),row('b1','2027-04-02',10),row('b1-second','2027-04-02',20,{account_id:'a2'}),row('b2','2027-04-02',30,{business_id:'b2',account_id:'a3'}),row('wrong-owner','2027-04-02',900,{business_id:'b1',account_id:'a3'}),row('unknown-account','2027-04-02',900,{account_id:'missing'})]);
 const {args}=prepare(data,[edit({account_id:null})]);
 const narrow={...args,funding:args.funding.filter(item=>item.business.id==='b1'),businessId:'all',accountId:'all'};
 const calendar=buildCashCalendarModel(narrow);
 assert.equal(calendar.actualExpenses,30);assert.equal(calendar.plannedExpenses,90);
 assert.ok(entries(calendar).every(item=>item.businessId==='b1'));
 const single=buildCashCalendarModel({...narrow,accountId:'a1'});
 assert.equal(single.actualExpenses,10);assert.equal(single.plannedExpenses,0);
 assert.ok(entries(single).every(item=>item.accountId==='a1'));
 const impossible=buildCashCalendarModel({...narrow,businessId:'b2'});
 assert.deepEqual([impossible.actualExpenses,impossible.plannedExpenses],[0,0]);
});

test('수동 출금 확인은 은행 실적으로 생성하지 않고 실거래와 중복되는 누적 금액을 빼서 별도 표시한다',()=>{
 const confirmed=edit({confirmed_amount:60,confirmed_date:'2027-04-07',confirmation_complete:false,confirmation_memo:'합성 확인 메모'});
 for(const [actual,manual,remaining] of [[0,60,40],[25,35,40],[80,0,20]]){
  const {calendar}=prepare(observed(actual),[confirmed]);
  assert.deepEqual([calendar.actualExpenses,calendar.confirmedExpenses,calendar.plannedExpenses],[actual,manual,remaining]);
  assert.equal(day(calendar,'2027-04-07').confirmedExpenses,manual);
  if(manual){
   const item=entries(calendar).find(item=>item.kind==='confirmed')!;
   assert.equal(item.source,'manual-confirmation');assert.match(item.note,/사용자 누적 출금 확인 60원.*합성 확인 메모/);
  }
  assertTotals(calendar);
 }
 const complete=prepare(observed(0),[{...confirmed,confirmation_complete:true}]).calendar;
 assert.deepEqual([complete.actualExpenses,complete.confirmedExpenses,complete.plannedExpenses],[0,60,0]);
 const tax=prepare(dataset([]),[edit({source_type:'manual',source_key:'tax',payment_kind:'tax',payment_status:'paid',amount:200})]).calendar;
 assert.deepEqual([tax.actualExpenses,tax.confirmedExpenses,tax.plannedExpenses],[0,0,0]);
});

test('계획 제외는 실제출금을 지우지 않으며 지난 실제일을 전체 선택기간에 보존한다',()=>{
 const {calendar}=prepare(observed(40),[edit({excluded:true})]);
 assert.deepEqual([calendar.actualExpenses,calendar.plannedExpenses],[40,0]);
 assert.equal(actualEntries(calendar)[0].planLink,null);
 assert.equal(calendar.days.length,30);assert.equal(calendar.days[0].date,range.from);assert.equal(calendar.days.at(-1)?.date,range.to);
 assert.equal(day(calendar,'2027-04-06').actualExpenses,40);
 const previous=prepare(dataset(),[],{range:{from:'2027-03-01',to:'2027-03-31'}}).calendar;
 assert.equal(previous.days.length,31);assert.equal(day(previous,'2027-03-15').actualExpenses,100);
});

test('날짜 미정과 지난 예상일의 남은 예산을 임의의 날짜로 옮기지 않고 합계를 맞춘다',()=>{
 const partial=dataset([...history(),row('partial','2027-04-06',40)]);
 for(const changes of [[],[edit({plan_date:null})]]){
  const {calendar,funding,worksheet}=prepare(partial,changes,{asOf:'2027-04-20'});
  assert.deepEqual([calendar.actualExpenses,calendar.plannedExpenses,calendar.undatedPlannedExpenses],[40,60,60]);
  assert.equal(calendar.datedPlannedExpenses,0);
  assert.equal(calendar.days.reduce((total,item)=>total+item.plannedExpenses,0),0);
  assert.equal(calendar.undatedItems.length,1);assert.equal(calendar.undatedItems[0].date,null);
  assert.equal(calendar.plannedExpenses,funding.reduce((total,item)=>total+item.expenses,0));
  assert.equal(calendar.plannedExpenses,worksheet.businesses.reduce((total,item)=>total+item.remainingTotal,0));
  assertTotals(calendar);
 }
});

test('선택기간 밖 실제는 달력 합계에 넣지 않되 해당 월 계획 차감과 수동 확인 중복 제거에는 유지한다',()=>{
 const data=dataset([...history(),row('early','2027-04-06',40)]);
 const saved=edit({plan_date:'2027-04-20',confirmed_amount:60,confirmed_date:'2027-04-12',confirmation_complete:false});
 const {calendar}=prepare(data,[saved],{range:{from:'2027-04-10',to:'2027-04-30'},asOf:'2027-04-12'});
 assert.deepEqual([calendar.actualExpenses,calendar.plannedExpenses,calendar.confirmedExpenses],[0,40,20]);
 assert.equal(day(calendar,'2027-04-20').plannedExpenses,40);
 assert.equal(day(calendar,'2027-04-12').confirmedExpenses,20);
});

test('등록 예정도 은행 근거의 일부/전체 출금에 따라 남은 금액만 유지하고 연결 없는 동일 이름은 추측하지 않는다',()=>{
 const registration={id:'registered',business_id:'b1',title:'합성 서비스',amount:100,direction:'out' as const,day:15,start_date:'2027-04-15',end_date:null,frequency:'once' as const};
 const saved=edit({source_type:'registered',source_key:'registered',title:'합성 서비스'});
 for(const [actual,remaining] of [[0,100],[40,60],[100,0]]){
  const data=dataset([],{recurring:[registration],bank_plan_actuals:actual?[bank('registered',actual)]:[],bank_plan_coverage:[coverage()]});
  const {calendar,editable}=prepare(data,[saved],{basis:'registered'});
  assert.deepEqual([calendar.actualExpenses,calendar.plannedExpenses],[actual,remaining]);
  if(actual)assert.equal(actualEntries(calendar)[0].planLink,editable.items[0].key);
 }
 const ledgerOnly=prepare(dataset([row('same-title','2027-04-06',40)],{recurring:[registration]}),[saved],{basis:'registered'}).calendar;
 assert.deepEqual([ledgerOnly.actualExpenses,ledgerOnly.plannedExpenses],[40,100]);
 assert.equal(actualEntries(ledgerOnly)[0].planLink,null);
});

test('원본 적요와 명시 상대방을 표시용으로 보존하며 수수료가 분리돼도 통장 원본 출금액을 사용한다',()=>{
 const source=row('source','2027-04-06',503,{description:'합성 은행 원본 적요',source_details:{counterparty:'합성 상대방',detail:'추가 원본 내역',memo:'합성 송금 메모'},category_id:'transfer',is_internal:true,transfer_fee_amount:3,transfer_fee_category_id:'fee'});
 const {calendar}=prepare(dataset([source]));
 const item=actualEntries(calendar)[0];
 assert.equal(item.amount,503);assert.equal(item.title,'합성 상대방');
 assert.match(item.note,/적요: 합성 은행 원본 적요/);assert.match(item.note,/세부내역: 추가 원본 내역/);assert.match(item.note,/이체메모: 합성 송금 메모/);
});

test('동결한 입력을 변경하지 않으며 월 양끝과 잘못된 조회기간·기준일을 검증한다',()=>{
 const data=dataset([row('first','2027-04-01',10),row('last','2027-04-30',20),row('next','2027-05-01',900)]);
 const {args}=prepare(data,[],{asOf:'2027-04-30'});
 const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}};
 freeze(args);
 const calendar=buildCashCalendarModel(args);
 assert.equal(calendar.actualExpenses,30);assert.equal(day(calendar,range.from).actualExpenses,10);assert.equal(day(calendar,range.to).actualExpenses,20);
 assertTotals(calendar);
 for(const invalid of [{range:{from:'2027-04-30',to:'2027-04-01'}},{range:{from:'2027-02-30',to:'2027-04-01'}},{asOf:'2027-02-30'}])assert.throws(()=>buildCashCalendarModel({...args,...invalid}),RangeError);
});
