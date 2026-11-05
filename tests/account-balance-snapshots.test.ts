import test from 'node:test';
import assert from 'node:assert/strict';
import {accountSnapshot} from '../lib/finance/balances';
import type {AccountBalanceSnapshot} from '../lib/finance/account-balance-types';
import {buildLatestCashBalances,latestBalanceRecordLabel} from '../lib/finance/latest-cash-balances';
import {buildCashPlanForRange,buildCurrentCashForecast,buildCurrentCashPlanForRange} from '../lib/finance/cash-plan';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {buildFundingTimeline} from '../lib/finance/funding-timeline';
import {buildFundingReport} from '../lib/finance/funding-report';
import {cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import {positions,currentCashPositions} from '../lib/finance/aggregate';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';
import {emptyDataset,type Account,type Dataset,type Transaction} from '../lib/finance/types';

const asOf='2027-04-02',range={from:'2027-04-01',to:'2027-04-30'};
const account=(id='a1',extra:Partial<Account>={}):Account=>({id,business_id:'b1',name:`합성 통장 ${id}`,bank:'합성 은행',masked_number:'0000',opening_balance:1000,opening_balance_date:'2027-03-31',...extra});
const row=(id:string,date:string,amount:number,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',txn_date:date,amount,direction:'out',balance:null,description:'합성 구독',raw_gwamok:'',category_id:'fee',upload_id:null,is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const snapshot=(extra:Partial<AccountBalanceSnapshot>={}):AccountBalanceSnapshot=>({account_id:'a1',business_id:'b1',balance:400,balance_date:asOf,collected_at:`${asOf}T12:00:00`,synced_at:`${asOf}T03:01:00Z`,source:'clobe',currency:'KRW',...extra});
const dataset=(extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,businesses:[{id:'b1',name:'합성 사업자',representative:'',kind:'법인',reserve:0,color:'#123456'}],accounts:[account()],categories:[{id:'fee',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true}],...extra});

test('현재 잔액만 명시적으로 Clobe 수집액을 사용하고 과거 원장 계산은 보존한다',()=>{
 const source=snapshot(),rows=[row('closing','2027-03-31',1,{direction:'in',balance:1000})];
 const before=JSON.stringify({source,rows});
 const legacy=accountSnapshot(account(),rows,asOf),current=accountSnapshot(account(),rows,asOf,[source]);
 assert.equal(legacy.balance,1000);assert.equal(legacy.source,'statement');
 assert.equal(current.balance,400);assert.equal(current.source,'clobe');assert.equal(current.date,asOf);
 assert.equal(current.collectedAt,source.collected_at);assert.equal(current.ledgerBalance,1000);assert.equal(current.transactionId,null);
 assert.match(current.message,/거래 기준 잔액과 차이.*남은 지출 확인/);
 assert.deepEqual(accountSnapshot(account(),rows,'2027-04-01',[source]),accountSnapshot(account(),rows,'2027-04-01'));
 const data=dataset({transactions:rows,balance_snapshots:[source]});
 assert.equal(buildCurrentCashPlanForRange(data,range,asOf).businesses[0].balance,400);
 assert.equal(buildCashPlanForRange(data,range).businesses[0].balance,1000);
 assert.equal(positions(data,asOf)[0].balance,1000);
 assert.equal(currentCashPositions(data,asOf)[0].balance,400);
 assert.equal(positions(data,asOf,30,data.balance_snapshots)[0].balance,400);
 assert.equal(currentCashPositions(data,'2027-04-01')[0].balance,1000);
 assert.equal(latestBalanceRecordLabel(buildLatestCashBalances(data,asOf).businesses[0]),'Clobe 수집 기준 04-02 12:00');
 const mixed=buildLatestCashBalances({...data,accounts:[account(),account('a2')]},asOf).businesses[0];
 assert.equal(latestBalanceRecordLabel(mixed),`2027-03-31 ~ ${asOf} 기록 · Clobe 04-02 12:00 포함`);
 assert.equal(JSON.stringify({source,rows}),before);
});

test('0원·음수 수집액을 보존하고 확인된 일치 잔액은 차이 경고 없이 표시한다',()=>{
 for(const balance of [0,-20])assert.equal(accountSnapshot(account(),[],asOf,[snapshot({balance})]).balance,balance);
 const result=accountSnapshot(account(),[],asOf,[snapshot({balance:1000})]);
 assert.match(result.message,/일치/);assert.doesNotMatch(result.message,/차이/);
});

test('원장보다 오래된 수집액과 미래 원본·유실 시각·환산 외화·잘못된 연결은 사용하지 않는다',()=>{
 const rows=[row('latest',asOf,1,{direction:'in',balance:1000})],original=accountSnapshot(account(),rows,asOf);
 const rejected:Partial<AccountBalanceSnapshot>[]=[
  {balance_date:'2027-04-01',collected_at:'2027-04-01T12:00:00'},
  {balance_date:'2027-04-03',collected_at:'2027-04-03T12:00:00',synced_at:'2027-04-03T03:01:00Z'},
  {collected_at:''},{collected_at:'2027-04-02'},{collected_at:'2027-04-02T25:00:00'},
  {collected_at:'2027-04-02T12:00:00+15:00'},{collected_at:'2027-04-01T12:00:00'},
  {synced_at:''},{synced_at:'2027-04-02T02:00:00Z'},{synced_at:'2027-04-02T03:01:00'},
  {balance:1.5},{balance:Infinity},{account_id:'a2'},{business_id:'b2'},
 ];
 for(const extra of rejected)assert.deepEqual(accountSnapshot(account(),rows,asOf,[snapshot(extra)]),original,JSON.stringify(extra));
 for(const extra of [{currency:'USD'},{source:'other'},{currency:undefined},{collected_at:undefined},{balance_date:'2027-02-30',collected_at:'2027-02-30T12:00:00'}]){
  const invalid={...snapshot(),...extra} as unknown as AccountBalanceSnapshot;
  assert.deepEqual(accountSnapshot(account(),rows,asOf,[invalid]),original);
 }
});

test('같은 날짜라도 수집 후의 거래시각이 있으면 최신 원장을 우선하며 배열순서로 고르지 않는다',()=>{
 const earlier=row('before',asOf,100,{balance:900,txn_time:'11:00:00'}),later=row('after',asOf,100,{direction:'in',balance:1000,txn_time:'13:00:00'});
 assert.equal(accountSnapshot(account(),[earlier],asOf,[snapshot()]).source,'clobe');
 for(const rows of [[earlier,later],[later,earlier]]){
  const resolved=accountSnapshot(account(),rows,asOf,[snapshot()]);
  assert.equal(resolved.balance,1000);assert.equal(resolved.source,'statement');assert.equal(resolved.transactionId,'after');
 }
 const laterWithoutBalance=row('later-no-balance','2027-04-03',250);
 assert.equal(accountSnapshot(account(),[earlier,laterWithoutBalance],'2027-04-03',[snapshot()]).source,'calculated');
 assert.equal(accountSnapshot(account(),[earlier,laterWithoutBalance],'2027-04-03',[snapshot()]).balance,650);
});

test('시각 없는 은행일은 원본 수집일을 보존하고 timezone은 비교에만 사용한다',()=>{
 const rows=[row('known',asOf,100,{balance:900,txn_time:'13:00:00'})];
 const source=snapshot({collected_at:`${asOf}T05:00:00Z`,synced_at:`${asOf}T05:01:00Z`});
 const result=accountSnapshot(account(),rows,asOf,[source]);
 assert.equal(result.source,'clobe');assert.equal(result.date,asOf);assert.equal(result.collectedAt,source.collected_at);
 const noTime=[row('no-time',asOf,100,{balance:900})];
 assert.equal(accountSnapshot(account(),noTime,asOf,[snapshot()]).balance,400);
});

test('검증된 최신 수집액은 원본 충돌·무자료를 현재 현금만 해결하며 거래 증거는 보존한다',()=>{
 const rows=[row('disconnected-a','2027-04-01',10,{balance:90}),row('disconnected-b','2027-04-01',20,{balance:20})],before=JSON.stringify(rows);
 assert.equal(accountSnapshot(account(),rows,asOf).source,'conflict');
 const result=accountSnapshot(account(),rows,asOf,[snapshot()]);
 assert.equal(result.balance,400);assert.equal(result.ledgerBalance,null);assert.match(result.message,/확인 필요/);
 const missing=account('a1',{opening_balance_date:null});
 assert.equal(accountSnapshot(missing,[],asOf).source,'unavailable');
 assert.equal(accountSnapshot(missing,[],asOf,[snapshot()]).balance,400);
 assert.equal(JSON.stringify(rows),before);
});

test('동일 수집시각의 모순은 원장으로 돌아가고 오래된 응답·배열순서가 최신액을 덮지 않는다',()=>{
 const old=snapshot({balance:300,collected_at:`${asOf}T11:00:00`}),newer=snapshot({balance:700,collected_at:`${asOf}T12:00:00`});
 for(const sources of [[old,newer],[newer,old]])assert.equal(accountSnapshot(account(),[],asOf,sources).balance,700);
 for(const sources of [[old,{...old,balance:900}],[{...old,balance:900},old]])assert.equal(accountSnapshot(account(),[],asOf,sources).balance,1000);
 assert.equal(accountSnapshot(account('a1',{opening_balance_date:'2027-04-03'}),[],'2027-04-03',[snapshot()]).source,'opening');
});

test('신규 거래가 0건이어도 snapshot 갱신으로 잔액·필요자금·일별 보충·예측이 함께 갱신된다',()=>{
 const saved:CashPlanEdit={id:'manual-plan',business_id:'b1',source_type:'manual',source_key:'manual-plan',month:'2027-04',title:'합성 카드 계획',account_id:'a1',plan_date:'2027-04-15',amount:1500,memo:'합성 사용자 메모',excluded:false,version:4,updated_at:`${asOf}T00:00:00Z`};
 const original=dataset(),updated={...original,balance_snapshots:[snapshot({balance:2000})]};
 const before=JSON.stringify({original,updated,saved});
 const evaluate=(data:Dataset)=>{
  const current=buildLatestCashBalances(data,asOf).businesses[0],model=buildEditableCashPlan(data,range,asOf,[saved]);
  const estimates=new Map(model.estimates.businesses.map(item=>[item.business.id,item]));
  const accounts=buildAccountFunding(model.plan.businesses,estimates,'registered');
  const timeline=buildFundingTimeline(accounts,range,asOf),report=buildFundingReport(model.plan.businesses,estimates,'registered',range,asOf);
  return {current,model,accounts,timeline,report,forecast:buildCurrentCashForecast(model.plan)};
 };
 const old=evaluate(original),fresh=evaluate(updated);
 assert.equal(old.current.balance,1000);assert.equal(fresh.current.balance,2000);
 assert.equal(old.model.plan.businesses[0].afterExpenses,-500);assert.equal(fresh.model.plan.businesses[0].afterExpenses,500);
 assert.equal(old.accounts[0].requiredTopUp,500);assert.equal(fresh.accounts[0].requiredTopUp,0);
 assert.equal(old.report.requiredTopUp,500);assert.equal(fresh.report.requiredTopUp,0);
 assert.equal(old.timeline.days.at(-1)?.cumulativeTopUp,500);assert.equal(fresh.timeline.days.at(-1)?.cumulativeTopUp,0);
 assert.equal(old.forecast.at(-1)?.b1,-500);assert.equal(fresh.forecast.at(-1)?.b1,500);
 assert.deepEqual(fresh.model.items.map(item=>[item.amount,item.remainingAmount,item.date,item.memo,item.edit?.version]),[[1500,1500,'2027-04-15','합성 사용자 메모',4]]);
 assert.deepEqual(fresh.model.plan.range,range);assert.deepEqual(fresh.model.plan.businesses[0].accounts[0].snapshot,fresh.current.accounts[0].snapshot);
 assert.equal(original.transactions.length,updated.transactions.length);assert.equal(JSON.stringify({original,updated,saved}),before);
});

test('실제 출금 차감은 거래 근거만 사용하고 수집액만으로 계획 지급을 자동 판정하지 않는다',()=>{
 const history=['01','02','03'].map(month=>row(`history-${month}`,`2027-${month}-15`,1500));
 const key=cashEstimateSourceKey(history[0]);
 const saved:CashPlanEdit={id:'estimated-plan',business_id:'b1',source_type:'estimated',source_key:key,month:'2027-04',title:'합성 구독 예산',account_id:'a1',plan_date:'2027-04-15',amount:1500,memo:'저장한 메모',excluded:false,version:2,updated_at:`${asOf}T00:00:00Z`};
 const source=dataset({transactions:history,balance_snapshots:[snapshot({balance:750})]}),actual={...source,transactions:[...history,row('actual',asOf,250,{txn_time:'10:00:00',balance:750})]};
 const unresolved=buildEditableCashPlan(source,range,asOf,[saved]),recorded=buildEditableCashPlan(actual,range,asOf,[saved]);
 assert.equal(unresolved.items[0].recordedAmount,0);assert.equal(unresolved.items[0].remainingAmount,1500);
 assert.equal(recorded.items[0].recordedAmount,250);assert.equal(recorded.items[0].remainingAmount,1250);
 assert.equal(unresolved.plan.businesses[0].balance,750);assert.equal(recorded.plan.businesses[0].balance,750);
 const estimateMap=new Map(recorded.estimates.businesses.map(item=>[item.business.id,item]));
 assert.equal(buildAccountFunding(recorded.plan.businesses,estimateMap,'estimated')[0].requiredTopUp,500);
});

test('계좌별·사업자별 잔액과 부족액은 분리하며 다른 통장 잉여로 부족액을 상계하지 않는다',()=>{
 const data=dataset({businesses:[...dataset().businesses,{id:'b2',name:'합성 다른 사업자',representative:'',kind:'법인',reserve:0,color:'#654321'}],accounts:[account(),account('a2'),account('a3',{business_id:'b2'})],balance_snapshots:[snapshot({balance:200}),snapshot({account_id:'a2',balance:5000}),snapshot({account_id:'a3',business_id:'b2',balance:100})]});
 const saved:CashPlanEdit[]=[['b1','a1',1000],['b2','a3',800]].map(([businessId,accountId,amount],index)=>({id:`manual-${index}`,business_id:String(businessId),source_type:'manual',source_key:`manual-${index}`,month:'2027-04',title:'합성 지급',account_id:String(accountId),plan_date:'2027-04-15',amount:Number(amount),memo:'',excluded:false,version:1,updated_at:`${asOf}T00:00:00Z`}));
 const model=buildEditableCashPlan(data,range,asOf,saved),estimates=new Map(model.estimates.businesses.map(item=>[item.business.id,item]));
 const funding=buildAccountFunding(model.plan.businesses,estimates,'registered'),report=buildFundingReport(model.plan.businesses,estimates,'registered',range,asOf);
 assert.deepEqual(model.plan.businesses.map(item=>item.balance),[5200,100]);
 assert.deepEqual(funding.map(item=>item.requiredTopUp),[800,700]);assert.equal(report.requiredTopUp,1500);
 assert.deepEqual(buildLatestCashBalances(data,asOf).businesses.map(item=>item.balance),[5200,100]);
});
