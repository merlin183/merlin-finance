import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCashEstimateBudgetsForRange,buildCashEstimatesForRange,buildRemainingCashEstimatesForRange,cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import {DEFAULT_CASH_PLAN_PERIOD} from '../lib/finance/cash-plan-period';
import {buildCurrentCashPlanForRange} from '../lib/finance/cash-plan';
import {buildAccountFunding} from '../lib/finance/account-funding';
import {buildFundingReport} from '../lib/finance/funding-report';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

const row=(id:string,date:string,amount:number,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',txn_date:date,amount,balance:null,direction:'out',description:'합성 서비스',upload_id:null,raw_gwamok:'',category_id:'fee',is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const history=(amount=100,days=[15,15,15],extra:Partial<Transaction>={})=>['07','08','09'].map((month,index)=>row(`history-${month}`,`2026-${month}-${String(days[index]).padStart(2,'0')}`,amount,extra));
const dataset=(transactions:Transaction[],extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,businesses:[{id:'b1',name:'합성 사업자',representative:'',kind:'법인',reserve:0,color:'#123456'}],categories:[{id:'fee',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true},{id:'loan',name:'대여금',group_name:'내부이동',is_internal:true,is_operating:false}],transactions,...extra});

test('이미 반영된 출금은 월 예산에서 차감하며 부분 지급·초과 지급을 다른 항목으로 전가하지 않는다',()=>{
 for(const [spent,remaining] of [[0,100],[40,60],[100,0],[150,0]]){
  const data=dataset([...history(),...(spent?[row('actual','2026-10-02',spent)]:[])]);
  const result=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02').businesses[0];
  assert.equal(result.total,remaining);assert.equal(result.dated.length,remaining?1:0);
  if(remaining){assert.equal(result.dated[0].originalAmount,100);assert.equal(result.dated[0].recordedAmount,spent);}
 }
 const data=dataset([...history(),row('actual','2026-10-02',150)]);
 const result=buildRemainingCashEstimatesForRange(data,{from:'2026-10-01',to:'2026-11-30'},'2026-10-02').businesses[0];
 assert.deepEqual(result.dated.map(item=>[item.date,item.amount]),[['2026-11-15',100]]);
});

test('동일 사업자·계좌·명시된 상대방만 연결하며 입금·내부이체·미래·다른 월은 차감하지 않는다',()=>{
 const base=history(100,[15,15,15],{description:'은행 공통 표기',source_details:{counterparty:'상대방 A'}});
 const identity={description:'다른 은행 표기',source_details:{counterparty:'상대방 A'}};
 const data=dataset([...base,
  row('valid','2026-10-02',20,identity),row('different-description','2026-10-02',80,{description:'상대방 A'}),
  row('different-counterparty','2026-10-02',80,{...identity,source_details:{counterparty:'상대방 B'}}),
  row('other-account','2026-10-02',80,{...identity,account_id:'a2'}),row('other-business','2026-10-02',80,{...identity,business_id:'b2'}),
  row('income','2026-10-02',80,{...identity,direction:'in'}),row('internal','2026-10-02',80,{...identity,is_internal:true}),
  row('loan','2026-10-02',80,{...identity,category_id:'loan'}),row('linked','2026-10-02',80,identity),
  row('future','2026-10-03',80,identity),row('other-month','2026-06-15',80,identity),
 ],{links:[{id:'l1',out_transaction_id:'linked',in_transaction_id:'synthetic-income'}]});
 const result=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02').businesses[0];
 assert.equal(result.total,80);assert.equal(result.dated[0].recordedAmount,20);
});

test('정확한 원본 표기의 전각·공백·대소문자 정규화는 실적에도 동일하게 적용한다',()=>{
 const data=dataset([...history(100,[15,15,15],{description:'SYNTHETIC SERVICE'}),row('actual','2026-10-02',40,{description:'  ｓｙｎｔｈｅｔｉｃ   ｓｅｒｖｉｃｅ  '})]);
 const result=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02').businesses[0];
 assert.equal(result.total,60);assert.equal(result.dated[0].recordedAmount,40);
});

test('명시된 은행 basic/detail의 유일한 정확 표기는 원본 description 예산의 실적으로 연결한다',()=>{
 const bankLabel='SYNTHETIC INS002',amount=178376;
 for(const details of [
  {basic:'합성 보험회사',detail:'  ｓｙｎｔｈｅｔｉｃ   ｉｎｓ００２  '},
  {basic:bankLabel,counterparty:'합성 보험회사'},
 ]){
  const data=dataset([...history(amount,[5,5,5],{description:bankLabel,source_details:{basic:bankLabel}}),
   row('clobe-new','2026-10-05',amount,{description:`합성 보험회사 · ${bankLabel}`,source_details:details}),
  ]);
  const before=JSON.stringify(data),original=buildCashEstimateBudgetsForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-07');
  const remaining=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-07');
  assert.equal(remaining.businesses[0].total,0);assert.deepEqual(remaining.businesses[0].undated,[]);
  assert.equal(remaining.businesses[0].groups[0].key,cashEstimateSourceKey(data.transactions[0]));
  assert.deepEqual(remaining.businesses[0].groups,original.businesses[0].groups);
  assert.equal(JSON.stringify(data),before);
 }
});

test('은행 표기 연결도 원본 사업자·계좌·출금 범위를 유지하며 미래·입금·내부이동을 제외한다',()=>{
 const details={basic:'합성 회사',detail:'SYNTHETIC INS002'},different={description:'합성 회사 · SYNTHETIC INS002',source_details:details};
 const data=dataset([...history(100,[15,15,15],{description:'SYNTHETIC INS002'}),
  row('valid','2026-10-02',20,different),row('wrong-bank','2026-10-02',80,{...different,account_id:'a2'}),
  row('wrong-business','2026-10-02',80,{...different,business_id:'b2'}),row('income','2026-10-02',80,{...different,direction:'in'}),
  row('internal','2026-10-02',80,{...different,is_internal:true}),row('loan','2026-10-02',80,{...different,category_id:'loan'}),
  row('linked','2026-10-02',80,different),row('future','2026-10-03',80,different),
 ],{links:[{id:'l1',out_transaction_id:'linked',in_transaction_id:'synthetic-income'}]});
 const result=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02').businesses[0];
 assert.equal(result.total,80);assert.equal(result.dated[0].recordedAmount,20);
});

test('기존 상대방 전용 예산을 다른 상대방이나 상대방 없는 은행 표기로 추측해 연결하지 않는다',()=>{
 const label='SYNTHETIC INS002';
 for(const counterparty of [undefined,'상대방 B']){
  const data=dataset([...history(100,[15,15,15],{description:label,source_details:{basic:label,counterparty:'상대방 A'}}),
   row('actual','2026-10-02',100,{description:`다른 표기 · ${label}`,source_details:{basic:'다른 표기',detail:label,counterparty}}),
  ]);
  const result=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02').businesses[0];
  assert.equal(result.total,100);assert.equal(result.dated[0].recordedAmount,0);
 }
});

test('같은 은행 표기를 쓰는 과거 상대방이 별도로 존재하면 description 예산 우회 매칭은 보류한다',()=>{
 const label='SYNTHETIC INS002';
 const competing=history(100,[15,15,15],{description:'다른 기본표기',source_details:{detail:label,counterparty:'상대방 A'}}).map(item=>({...item,id:`party-${item.id}`}));
 const data=dataset([...history(100,[15,15,15],{description:label}),...competing,
  row('unknown','2026-10-02',100,{description:`상대방 B · ${label}`,source_details:{basic:'상대방 B',detail:label,counterparty:'상대방 B'}}),
 ]);
 const result=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02').businesses[0];
 assert.equal(result.total,200);assert.ok(result.dated.every(item=>item.recordedAmount===0));
});

test('신규 원본에 같은 은행 표기지만 서로 다른 명시 상대방이 있으면 하나의 예산으로 합치지 않는다',()=>{
 const label='SYNTHETIC INS002';
 const data=dataset([...history(100,[15,15,15],{description:label}),
  ...['상대방 A','상대방 B'].map((party,index)=>row(`different-party-${index}`,'2026-10-02',40,
   {description:`${party} · ${label}`,source_details:{basic:party,detail:label,counterparty:party}})),
 ]);
 const result=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02').businesses[0];
 assert.equal(result.total,100);assert.equal(result.dated[0].recordedAmount,0);
});

test('명시된 상대방 예산이 이미 있으면 그 예산만 한 번 차감하고 description 예산은 그대로 둔다',()=>{
 const label='SYNTHETIC INS002';
 const partyHistory=history(100,[15,15,15],{description:'상대방 전용 표기',source_details:{counterparty:'상대방 A'}}).map(item=>({...item,id:`party-${item.id}`}));
 const data=dataset([...history(100,[15,15,15],{description:label}),...partyHistory,
  row('paid','2026-10-02',40,{description:`상대방 A · ${label}`,source_details:{counterparty:'상대방 A',detail:label}}),
 ]);
 const result=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02').businesses[0];
 assert.equal(result.total,160);
 assert.deepEqual(result.dated.map(item=>[item.title,item.recordedAmount]).sort(),[[label,0],['상대방 A',40]].sort());
});

test('basic/detail이 서로 다른 원본 예산을 지목하거나 부분 표기·메모만 맞으면 자동 차감하지 않는다',()=>{
 const first='SYNTHETIC INS002',second='SYNTHETIC CARD';
 const data=dataset([...history(100,[15,15,15],{description:first}),...history(50,[15,15,15],{description:second}).map(item=>({...item,id:`card-${item.id}`})),
  row('two-budgets','2026-10-02',100,{description:'복합 내역',source_details:{basic:first,detail:second}}),
  row('partial','2026-10-02',100,{description:'부분 내역',source_details:{detail:'SYNTHETIC INS'}}),
  row('memo-only','2026-10-02',100,{description:'다른 내역',source_details:{memo:first,note:second,record:first}}),
 ]);
 const result=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02').businesses[0];
 assert.equal(result.total,150);assert.ok(result.dated.every(item=>item.recordedAmount===0));
});

test('급여 같은 일반 은행 표기나 숫자·기호만으로는 의미 있는 예산을 추측해 연결하지 않는다',()=>{
 for(const label of ['급여','1000','---']){
  const data=dataset([...history(100,[15,15,15],{description:label}),
   row('actual','2026-10-02',100,{description:'합성 상대방 · 기본표기',source_details:{detail:label}}),
  ]);
  const result=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02').businesses[0];
  if(label==='급여'){assert.equal(result.total,0);assert.equal(result.groups.length,0);}
  else{assert.equal(result.total,100);assert.equal(result.dated[0].recordedAmount,0);}
 }
});

test('예상일이 지난 잔여 예산은 원래 날짜를 보존한 날짜 미정 항목이며 오늘 예상일은 유지한다',()=>{
 const data=dataset([...history(100,[1,1,1]),row('part','2026-10-01',40)]);
 const today=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-01').businesses[0];
 assert.equal(today.dated[0].date,'2026-10-01');assert.equal(today.dated[0].amount,60);
 const past=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02').businesses[0];
 assert.deepEqual(past.dated,[]);assert.equal(past.undated[0].amount,60);
 assert.equal(past.undated[0].status,'date-passed');assert.equal(past.undated[0].expectedDate,'2026-10-01');
 assert.equal(past.undated[0].originalAmount,100);assert.equal(past.undated[0].recordedAmount,40);
 const ended=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-11-02').businesses[0];
 assert.equal(ended.total,60);assert.equal(ended.undated[0].expectedDate,'2026-10-01');
});

test('날짜 미정 부분 기간은 이미 안분된 금액에서 기간 안 실적만 빼며 다시 안분하지 않는다',()=>{
 const data=dataset([...history(310,[5,15,25]),row('before-period','2026-10-02',200),row('in-period','2026-10-16',40),row('not-yet','2026-10-22',200)]);
 const result=buildRemainingCashEstimatesForRange(data,{from:'2026-10-15',to:'2026-10-31'},'2026-10-20').businesses[0];
 assert.equal(result.dated.length,0);assert.equal(result.undated.length,1);
 const item=result.undated[0];assert.equal(item.originalAmount,170);assert.equal(item.recordedAmount,40);assert.equal(item.amount,130);
 assert.equal(item.coveredDays,17);assert.equal(item.monthDays,31);assert.equal(result.total,130);
});

test('향후 조회 월의 아직 완료되지 않은 근거 월과 미래 날짜 자료를 사용하지 않는다',()=>{
 const data=dataset([...history(100),row('future-evidence','2026-10-15',90000),row('future-payment','2026-11-15',90000)]);
 const result=buildRemainingCashEstimatesForRange(data,{from:'2026-11-01',to:'2026-11-30'},'2026-10-02');
 assert.deepEqual(result.basis.months,['2026-07','2026-08','2026-09']);
 assert.equal(result.businesses[0].total,100);assert.equal(result.businesses[0].dated[0].recordedAmount,0);
 assert.equal(result.businesses[0].groups[0].sourceCount,3);
});

test('현재 입금은 지출 예산을 감소시키지 않으며 원본·기존 전체 예산 API를 변경하지 않는다',()=>{
 const data=dataset([...history(100),row('actual','2026-10-02',40),row('income','2026-10-02',9999,{direction:'in'})]);
 const before=JSON.stringify(data),original=buildCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD);
 const remaining=buildRemainingCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02');
 assert.equal(original.businesses[0].total,100);assert.equal(remaining.businesses[0].total,60);
 assert.equal(original.businesses[0].dated[0].originalAmount,undefined);
 assert.equal(remaining.asOf,'2026-10-02');assert.equal(JSON.stringify(data),before);
 assert.deepEqual(buildCashEstimatesForRange(data,DEFAULT_CASH_PLAN_PERIOD),original);
 assert.equal(remaining.businesses[0].total,remaining.businesses[0].dated.reduce((sum,item)=>sum+item.amount,0)+remaining.businesses[0].undated.reduce((sum,item)=>sum+item.amount,0));
});

test('유효하지 않은 현재 날짜·기간은 계산하지 않는다',()=>{
 assert.throws(()=>buildRemainingCashEstimatesForRange(dataset([]),DEFAULT_CASH_PLAN_PERIOD,'2026-02-30'),RangeError);
 assert.throws(()=>buildRemainingCashEstimatesForRange(dataset([]),{from:'2026-10-31',to:'2026-10-01'},'2026-10-02'),RangeError);
});

test('통합: 실제 출금 80으로 잔액 100이 20이 되면 남은 예산과 추가 필요액은 0이고 잔여는 20이다',()=>{
 const data=dataset([...history(80,[1,1,1]),row('closing','2026-09-30',1,{direction:'in',balance:100}),row('paid','2026-10-01',80,{balance:20})],{
  accounts:[{id:'a1',business_id:'b1',name:'합성 주계좌',bank:'합성 은행',masked_number:'0000',opening_balance:100,opening_balance_date:'2026-01-01'}],
 });
 const plan=buildCurrentCashPlanForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02');
 const estimates=buildRemainingCashEstimatesForRange(data,plan.range,plan.asOf);
 const map=new Map(estimates.businesses.map(item=>[item.business.id,item]));
 const funding=buildAccountFunding(plan.businesses,map,'estimated');
 const report=buildFundingReport(plan.businesses,map,'estimated',plan.range,plan.asOf);
 assert.equal(plan.businesses[0].balance,20);assert.equal(estimates.businesses[0].total,0);
 assert.equal(funding[0].accounts[0].afterExpenses,20);assert.equal(funding[0].accounts[0].requiredTopUp,0);
 assert.equal(report.businesses[0].balance,20);assert.equal(report.requiredTopUp,0);assert.equal(report.datedRequiredTopUp,0);
 assert.equal(report.businesses[0].timeline.days[0].date,'2026-10-02');assert.deepEqual(report.businesses[0].rows,[]);
});

test('통합: 해당 계좌에 신규 입금 100이면 계좌·날짜·보고 필요액이 함께 100 줄고 다른 통장 여유금은 상계하지 않는다',()=>{
 const accounts=[
  {id:'a1',business_id:'b1',name:'합성 지출계좌',bank:'합성 은행',masked_number:'0001',opening_balance:100,opening_balance_date:'2026-01-01'},
  {id:'a2',business_id:'b1',name:'합성 여유계좌',bank:'합성 은행',masked_number:'0002',opening_balance:1000,opening_balance_date:'2026-01-01'},
 ];
 const original=dataset([...history(300),row('closing','2026-09-30',1,{direction:'in',balance:100})],{accounts});
 const updated={...original,transactions:[...original.transactions,row('new-income','2026-10-02',100,{direction:'in',balance:200})]};
 const calculate=(data:Dataset)=>{
  const plan=buildCurrentCashPlanForRange(data,DEFAULT_CASH_PLAN_PERIOD,'2026-10-02');
  const estimates=buildRemainingCashEstimatesForRange(data,plan.range,plan.asOf);
  const map=new Map(estimates.businesses.map(item=>[item.business.id,item]));
  return {plan,estimates,funding:buildAccountFunding(plan.businesses,map,'estimated'),report:buildFundingReport(plan.businesses,map,'estimated',plan.range,plan.asOf)};
 };
 const before=calculate(original),after=calculate(updated);
 assert.equal(before.plan.businesses[0].balance,1100);assert.equal(after.plan.businesses[0].balance,1200);
 assert.equal(before.estimates.businesses[0].total,300);assert.equal(after.estimates.businesses[0].total,300);
 assert.equal(before.funding[0].requiredTopUp,200);assert.equal(after.funding[0].requiredTopUp,100);
 assert.equal(before.funding[0].accounts[1].requiredTopUp,0);assert.equal(after.funding[0].accounts[1].snapshot.balance,1000);
 assert.equal(before.report.requiredTopUp,200);assert.equal(after.report.requiredTopUp,100);
 assert.equal(before.report.datedRequiredTopUp,200);assert.equal(after.report.datedRequiredTopUp,100);
 assert.deepEqual(after.report.businesses[0].rows.map(item=>[item.account.id,item.date,item.additionalTopUp]),[['a1','2026-10-15',100]]);
});
