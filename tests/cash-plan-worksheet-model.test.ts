import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCashPlanWorksheetModel} from '../lib/finance/cash-plan-worksheet-model';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {cashEstimateSourceKey,type CashEstimateOptions} from '../lib/finance/cash-estimates';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';
import type {BankPlanActual,BankPlanCoverage} from '../lib/finance/clobe-plan-actuals';
import {cashCalendarActualTransactions} from '../lib/finance/cash-calendar';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

const range={from:'2027-04-01',to:'2027-04-30'},asOf='2027-04-12';
const row=(id:string,date:string,amount:number,extra:Partial<Transaction>={}):Transaction=>({id,business_id:'b1',account_id:'a1',txn_date:date,amount,balance:null,direction:'out',description:'합성 구독 서비스',raw_gwamok:'',category_id:'fee',upload_id:null,is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false,...extra});
const history=(amount=100,days=[5,5,5],extra:Partial<Transaction>={})=>['01','02','03'].map((month,index)=>row(`history-${month}-${extra.description??''}`,`2027-${month}-${String(days[index]).padStart(2,'0')}`,amount,extra));
const dataset=(transactions:Transaction[]=history(),extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,
 businesses:[{id:'b1',name:'합성 사업자',representative:'',kind:'법인',reserve:10,color:'#123456'}],
 accounts:[{id:'a1',business_id:'b1',name:'원본 계좌',bank:'합성 은행',masked_number:'0001',opening_balance:1000,opening_balance_date:'2027-03-31'},{id:'a2',business_id:'b1',name:'계획 계좌',bank:'합성 은행',masked_number:'0002',opening_balance:1000,opening_balance_date:'2027-03-31'}],
 categories:[{id:'fee',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true}],transactions,...extra});
const edit=(extra:Partial<CashPlanEdit>={}):CashPlanEdit=>({id:'saved-plan',business_id:'b1',source_type:'estimated',source_key:cashEstimateSourceKey(row('key',asOf,1)),month:'2027-04',title:'사용자 구독 계획',account_id:'a1',plan_date:'2027-04-05',amount:100,memo:'합성 메모',excluded:false,version:3,updated_at:`${asOf}T00:00:00Z`,...extra});
function review(data:Dataset,edits:CashPlanEdit[]=[],basis:'estimated'|'registered'='estimated',selected=range,now=asOf,options:CashEstimateOptions={}){
 const editable=buildEditableCashPlan(data,selected,now,edits,options);
 const before=JSON.stringify({data,edits,editable});
 const model=buildCashPlanWorksheetModel({data,editable,basis,range:selected,asOf:now,options});
 assert.equal(JSON.stringify({data,edits,editable}),before);
 return {editable,model,business:model.businesses[0],rows:model.businesses[0].rows};
}

test('예산을 전부 사용한 항목도 원래 날짜·전체 예상액·저장된 실적과 함께 남는다',()=>{
 const {editable,business,rows}=review(dataset([...history(),row('actual','2027-04-06',100)]));
 assert.equal(editable.estimates.businesses[0].total,0);assert.deepEqual(editable.estimates.businesses[0].dated,[]);assert.deepEqual(editable.estimates.businesses[0].undated,[]);
 assert.equal(rows.length,1);assert.equal(rows[0].date,'2027-04-05');
 assert.deepEqual([rows[0].originalAmount,rows[0].recordedAmount,rows[0].remainingAmount],[100,100,0]);
 assert.equal(rows[0].status,'spent');assert.equal(rows[0].statusLabel,'예산 소진');assert.doesNotMatch(rows[0].statusLabel,/지급 완료/);
 assert.deepEqual([business.originalTotal,business.recordedTotal,business.knownRecordedTotal,business.remainingTotal,business.hasUnknownRecorded],[100,100,100,0,false]);
});

test('지나간 1일·5일·8일은 날짜 미정으로 이동하지 않고 미반영·부분 출금을 구분한다',()=>{
 const transactions=[...history(100,[1,1,1],{description:'합성 A'}),...history(200,[5,5,5],{description:'합성 B'}),...history(300,[8,8,8],{description:'합성 C'}),row('partial','2027-04-06',80,{description:'합성 B'})];
 const {editable,rows}=review(dataset(transactions));
 assert.equal(editable.estimates.businesses[0].dated.length,0);assert.equal(editable.estimates.businesses[0].undated.length,3);
 assert.deepEqual(rows.map(item=>item.date),['2027-04-01','2027-04-05','2027-04-08']);
 assert.deepEqual(rows.map(item=>[item.originalAmount,item.recordedAmount,item.remainingAmount,item.status]),[[100,0,100,'pending'],[200,80,120,'partial'],[300,0,300,'pending']]);
 assert.match(rows[0].statusLabel,/확인 필요/);assert.match(rows[1].note,/동월 실적 2027-04-01 ~ 2027-04-30/);
});

test('초과 출금은 예산액으로 자르지 않고 표시하며 다른 품목과 상계하지 않는다',()=>{
 const data=dataset([...history(),...history(50,[8,8,8],{description:'합성 다른 품목'}),row('over','2027-04-06',170)]);
 const {rows,business}=review(data),first=rows.find(item=>item.title==='합성 구독 서비스')!,other=rows.find(item=>item.title==='합성 다른 품목')!;
 assert.deepEqual([first.originalAmount,first.recordedAmount,first.remainingAmount,first.status],[100,170,0,'over-budget']);
 assert.deepEqual([other.originalAmount,other.recordedAmount,other.remainingAmount],[50,0,50]);
 assert.deepEqual([business.originalTotal,business.recordedTotal,business.remainingTotal],[150,170,50]);
});

test('제외·전월·조회범위 밖 항목을 숨기고 estimated/registered 기준에 manual을 각각 한 번 포함한다',()=>{
 const registered={id:'registered',business_id:'b1',title:'합성 등록 일정',amount:80,direction:'out' as const,day:18,start_date:'2027-04-18',end_date:null,frequency:'once' as const};
 const manual=edit({id:'manual',source_type:'manual',source_key:'manual',title:'직접 추가 항목',plan_date:'2027-04-20',amount:70});
 const old=edit({id:'old',source_type:'manual',source_key:'old',month:'2027-03',plan_date:'2027-03-05',amount:999});
 const data=dataset(history(),{recurring:[registered]});
 const estimated=review(data,[manual,old]),fixed=review(data,[manual,old],'registered');
 assert.deepEqual(estimated.rows.map(item=>item.sourceType),['estimated','manual']);
 assert.deepEqual(fixed.rows.map(item=>item.sourceType),['registered','manual']);
 const hidden=review(data,[manual,edit({excluded:true})]);assert.deepEqual(hidden.rows.map(item=>item.key),[estimated.rows[1].key]);
 const global=review(data,[edit({month:'*',plan_date:null,excluded:true}),manual]);assert.equal(global.rows.length,1);
 const scoped=review(data,[manual], 'estimated',{from:'2027-04-10',to:'2027-04-15'});assert.deepEqual(scoped.rows,[]);
});

test('직접 추가·등록 항목은 같은 이름의 출금이 있어도 실적 0이나 지급 완료를 만들지 않는다',()=>{
 const data=dataset([row('similar','2027-04-05',80,{description:'합성 등록 일정'})],{recurring:[{id:'registered',business_id:'b1',title:'합성 등록 일정',amount:80,direction:'out',day:5,start_date:'2027-04-05',end_date:null,frequency:'once'}]});
 const manual=edit({id:'manual',source_type:'manual',source_key:'manual',title:'합성 등록 일정',amount:50});
 const {rows,business,editable}=review(data,[manual],'registered');
 assert.equal(rows.length,2);assert.ok(rows.every(item=>item.recordedAmount===null&&item.status==='confirmation-needed'));
 assert.ok(rows.every(item=>item.date==='2027-04-05'));assert.equal(business.recordedTotal,null);assert.equal(business.knownRecordedTotal,0);assert.equal(business.hasUnknownRecorded,true);
 assert.equal(editable.plan.businesses[0].unconfirmedExpenses?.length,1);assert.equal(editable.plan.businesses[0].afterExpenses,null);
});

test('납부 완료 표시는 이력을 남기되 저장되지 않은 실지급 금액을 만들지 않는다',()=>{
 const paid=edit({id:'tax-paid',source_type:'manual',source_key:'tax-paid',title:'합성 세금',amount:250,payment_kind:'tax',payment_status:'paid'});
 for(const basis of ['estimated','registered'] as const){
  const {rows,business}=review(dataset([]),[paid],basis);
  assert.equal(rows.length,1);assert.equal(rows[0].tax,true);assert.equal(rows[0].status,'paid');assert.equal(rows[0].date,'2027-04-05');
  assert.deepEqual([rows[0].originalAmount,rows[0].recordedAmount,rows[0].remainingAmount],[250,null,0]);
  assert.equal(business.recordedTotal,null);assert.equal(business.hasUnknownRecorded,true);
 }
});

test('날짜 미정은 선택구간 예산과 실적을 사용하며 완전히 소진된 초과 출금도 정확히 복구한다',()=>{
 const data=dataset([...history(300,[3,15,24]),row('before','2027-04-02',200),row('inside-a','2027-04-16',70),row('inside-b','2027-04-20',120),row('future','2027-04-25',500)]);
 const saved=edit({plan_date:null,amount:300}),selected={from:'2027-04-15',to:'2027-04-30'};
 const {editable,rows}=review(data,[saved],'estimated',selected,'2027-04-20');
 assert.equal(editable.items[0].recordedAmount,390);assert.equal(editable.estimates.businesses[0].total,0);
 assert.equal(rows[0].date,null);assert.deepEqual([rows[0].originalAmount,rows[0].recordedAmount,rows[0].remainingAmount],[160,190,0]);
 assert.equal(rows[0].status,'over-budget');assert.match(rows[0].note,/조회기간 실적 2027-04-15 ~ 2027-04-30/);
 assert.deepEqual([rows[0].from,rows[0].to],['2027-04-15','2027-04-30']);
});

test('날짜가 지정된 월 예산은 좁은 조회기간에도 기존 동월 실적 기준을 그대로 설명한다',()=>{
 const data=dataset([...history(),row('earlier-in-month','2027-04-02',30),row('refund','2027-04-10',20,{direction:'in'}),row('different-month','2027-03-31',60),row('future','2027-04-19',200)]);
 const saved=edit({plan_date:'2027-04-15'}),selected={from:'2027-04-10',to:'2027-04-20'};
 const {rows}=review(data,[saved],'estimated',selected,'2027-04-12');
 assert.deepEqual([rows[0].originalAmount,rows[0].recordedAmount,rows[0].remainingAmount],[100,30,70]);
 assert.match(rows[0].note,/동월 실적 2027-04-01 ~ 2027-04-30/);assert.equal(rows[0].date,'2027-04-15');
});

test('계획 계좌를 바꿔도 실적은 원래 사업자·계좌·거래처에서만 가져온다',()=>{
 const data=dataset([...history(),row('real','2027-04-06',40),row('other-account','2027-04-06',500,{account_id:'a2'}),row('other-business','2027-04-06',600,{business_id:'b2'}),row('other-party','2027-04-06',700,{description:'합성 다른 상대방'})]);
 const saved=edit({account_id:'a2',title:'사용자가 수정한 품목'}),{rows}=review(data,[saved]);
 assert.deepEqual([rows[0].originalAmount,rows[0].recordedAmount,rows[0].remainingAmount],[100,40,60]);
 assert.equal(rows[0].accountId,'a2');assert.equal(rows[0].sourceAccountId,'a1');assert.equal(rows[0].title,saved.title);
 assert.match(rows[0].note,/계획 계좌/);assert.match(rows[0].note,/실적 기준 계좌 원본 계좌/);
});

test('Clobe 원본 표기 연결·제외 정책과 숨겨진 청구 provenance는 기존 규칙을 재사용한다',()=>{
 const originalLabel='SYNTHETIC INS 123',data=dataset([...history(100,[5,5,5],{description:originalLabel,source_details:{basic:originalLabel}}),row('clobe','2027-04-06',40,{description:`합성 보험회사 · ${originalLabel}`,source_details:{basic:'합성 보험회사',detail:originalLabel}})]);
 const saved=edit({source_key:cashEstimateSourceKey(data.transactions[0]),memo:'[clobe-card-bill:synthetic-company:synthetic-key]\n대체 계획 키: ["synthetic-source"]\n사용자 메모'});
 const {rows}=review(data,[saved]);
 assert.equal(rows[0].recordedAmount,40);assert.equal(rows[0].remainingAmount,60);assert.match(rows[0].note,/사용자 메모/);assert.doesNotMatch(rows[0].note,/clobe-card-bill|synthetic-source/);
 const options={excludedBusinessCategories:[{businessId:'b1',categoryId:'fee'}]},excluded=review(data,[saved],'estimated',range,asOf,options);
 assert.equal(excluded.rows[0].recordedAmount,0);assert.equal(excluded.rows[0].remainingAmount,100);
});

test('기간은 두 경계를 포함하고 다른 월 예산은 섞지 않으며 잘못된 기간은 거부한다',()=>{
 const data=dataset([...history(),row('first','2027-04-01',40),row('last','2027-04-30',20),row('next','2027-05-01',500)]);
 const {rows}=review(data,[edit({plan_date:null})],'estimated',range,'2027-04-30');
 assert.deepEqual([rows[0].recordedAmount,rows[0].remainingAmount],[60,40]);
 const editable=buildEditableCashPlan(data,range,asOf,[]);
 assert.throws(()=>buildCashPlanWorksheetModel({data,editable,basis:'estimated',range:{from:'2027-04-30',to:'2027-04-01'},asOf}),RangeError);
 assert.throws(()=>buildCashPlanWorksheetModel({data,editable,basis:'estimated',range,asOf:'2027-02-30'}),RangeError);
});

test('날짜 미정 월 예산의 실제 지급일은 날짜별로 묶고 원장과 은행의 같은 출금은 한 번만 표시한다',()=>{
 const recurring=['01','02','03'].flatMap(month=>[row(`early-${month}`,`2027-${month}-02`,200),row(`late-${month}`,`2027-${month}-15`,200)]);
 const actual=row('actual','2027-04-02',60,{txn_time:'09:00:00',balance:940});
 const bank:BankPlanActual={account_id:'a1',business_id:'b1',external_transaction_id:'bank-actual',txn_date:'2027-04-02',txn_time:'09:00:00',amount:60,balance:940,description:actual.description,party:null,source_details:null,currency:'KRW',source:'clobe',collected_at:'2027-04-12T03:00:00Z',synced_at:'2027-04-12T04:00:00Z',transaction_id:'actual'};
 const coverage:BankPlanCoverage={account_id:'a1',business_id:'b1',from:'2027-04-01',to:asOf,collected_at:bank.collected_at,synced_at:bank.synced_at,status:'complete',reason:null,currency:'KRW',source:'clobe'};
 const data=dataset([...recurring,actual,row('same-day','2027-04-02',40),row('later','2027-04-10',80),row('future','2027-04-20',900)],{bank_plan_actuals:[bank],bank_plan_coverage:[coverage]});
 const {rows,editable,business}=review(data);
 assert.equal(rows[0].date,null);
 assert.equal(rows[0].displayDate,'2027-04-02');
 assert.deepEqual(rows[0].recordedPaymentDates,[{date:'2027-04-02',amount:100,transactionCount:2},{date:'2027-04-10',amount:80,transactionCount:1}]);
 assert.deepEqual([rows[0].originalAmount,rows[0].recordedAmount,rows[0].remainingAmount],[400,180,220]);
 assert.equal(business.remainingTotal,220);assert.equal(editable.estimates.businesses[0].total,220);
});

test('실제 지급일의 범위는 미정 예산의 조회기간과 지정일 예산의 동월 실적 범위를 각각 따른다',()=>{
 const data=dataset([...history(),row('early','2027-04-02',20),row('inside','2027-04-11',30),row('future','2027-04-19',40)]);
 const selected={from:'2027-04-10',to:'2027-04-20'};
 const undated=review(data,[edit({plan_date:null})],'estimated',selected).rows[0];
 const dated=review(data,[edit({plan_date:'2027-04-15'})],'estimated',selected).rows[0];
 assert.deepEqual(undated.recordedPaymentDates,[{date:'2027-04-11',amount:30,transactionCount:1}]);
 assert.equal(undated.recordedAmount,30);
 assert.deepEqual(dated.recordedPaymentDates,[{date:'2027-04-02',amount:20,transactionCount:1},{date:'2027-04-11',amount:30,transactionCount:1}]);
 assert.equal(dated.recordedAmount,50);
});

test('사용자 누적 확인일을 실제 통장 지급일로 만들지 않고 확인액과 별개로 원본 지급일만 표시한다',()=>{
 const saved=edit({plan_date:null,confirmed_amount:90,confirmed_date:'2027-04-08',confirmation_complete:false,confirmation_memo:'합성 확인'});
 const withoutActual=review(dataset(),[saved]).rows[0];
 assert.equal(withoutActual.recordedAmount,90);assert.deepEqual(withoutActual.recordedPaymentDates,[]);assert.equal(withoutActual.displayDate,null);
 const withActual=review(dataset([...history(),row('actual','2027-04-06',40)]),[saved]).rows[0];
 assert.equal(withActual.recordedAmount,90);assert.equal(withActual.remainingAmount,10);
 assert.equal(withActual.displayDate,null);assert.equal(withActual.date,null);
 assert.deepEqual(withActual.recordedPaymentDates,[{date:'2027-04-06',amount:40,transactionCount:1}]);
});

test('출금 연결이 모호한 계획에는 실제 지급일을 확정해 표시하지 않는다',()=>{
 const data=dataset([...history(),row('actual','2027-04-06',40)]);
 const editable=buildEditableCashPlan(data,range,asOf,[]);
 const before=JSON.stringify(editable);
 const ambiguous={...editable,items:editable.items.map(item=>({...item,recordedAmbiguous:true,reconciliationReason:'합성 연결 후보 중복'}))};
 const worksheet=buildCashPlanWorksheetModel({data,editable:ambiguous,basis:'estimated',range,asOf});
 assert.deepEqual(worksheet.businesses[0].rows[0].recordedPaymentDates,[]);
 assert.equal(worksheet.businesses[0].rows[0].displayDate,'2027-04-05');
 assert.equal(worksheet.businesses[0].rows[0].status,'confirmation-needed');
 assert.equal(JSON.stringify(editable),before);
});

test('실제로 지급된 미정 항목의 표시 정렬만 앞당기고 원본 날짜·월 예산·남은 합계를 보존한다',()=>{
 const data=dataset([
  ...history(200,[2,15,25]),...history(50,[5,5,5],{description:'합성 보험 A'}),...history(30,[6,6,6],{description:'합성 보험 B'}),
  row('paid-b','2027-04-02',30),row('paid-a','2027-04-02',40),
 ]);
 const {rows,business,editable}=review(data);
 assert.deepEqual(rows.map(item=>item.displayDate),['2027-04-02','2027-04-05','2027-04-06']);
 assert.deepEqual(rows.map(item=>item.date),[null,'2027-04-05','2027-04-06']);
 assert.equal(rows[0].sourceType,'estimated');assert.equal(rows[0].editorItem.source_key,cashEstimateSourceKey(data.transactions[0]));
 assert.deepEqual([rows[0].originalAmount,rows[0].recordedAmount,rows[0].remainingAmount],[200,70,130]);
 assert.equal(rows[0].editorItem.date,null);assert.equal(rows[0].editorItem.amount,200);
 assert.equal(business.originalTotal,280);assert.equal(business.remainingTotal,210);
 assert.equal(editable.estimates.businesses[0].total,210);
});

test('지정된 계획도 원래 계획일 대신 실제일로 정렬하되 원본 일정과 소진 계산은 보존한다',()=>{
 const data=dataset([
  ...history(100,[15,15,15],{description:'합성 조기 지급'}),...history(200,[1,1,1],{description:'합성 지연 지급'}),...history(50,[5,5,5],{description:'합성 미지급'}),
  row('early','2027-04-02',100,{description:'합성 조기 지급'}),row('late','2027-04-10',200,{description:'합성 지연 지급'}),
 ]);
 const {rows,business,editable}=review(data);
 assert.deepEqual(rows.map(item=>item.displayDate),['2027-04-02','2027-04-05','2027-04-10']);
 assert.deepEqual(rows.map(item=>item.displayDateIsActual),[true,false,true]);
 assert.deepEqual(rows.map(item=>item.date),['2027-04-15','2027-04-05','2027-04-01']);
 assert.deepEqual(rows.map(item=>item.remainingAmount),[0,50,0]);
 assert.equal(business.remainingTotal,50);assert.equal(editable.estimates.businesses[0].total,50);
 assert.deepEqual(editable.items.map(item=>item.date).sort(),['2027-04-01','2027-04-05','2027-04-15']);
});

test('지정일 일부 출금의 표시일은 실제일이어도 남은 지급 일정과 원래 출금 계좌를 변경하지 않는다',()=>{
 const data=dataset([...history(100,[15,15,15]),row('actual','2027-04-02',40)]);
 const saved=edit({plan_date:'2027-04-15',account_id:'a2'}),{rows,editable}=review(data,[saved]);
 const result=rows[0],future=editable.estimates.businesses[0].dated[0];
 assert.equal(result.displayDate,'2027-04-02');assert.equal(result.displayDateIsActual,true);
 assert.equal(result.date,'2027-04-15');assert.equal(result.accountId,'a2');assert.equal(result.sourceAccountId,'a1');
 assert.deepEqual([result.recordedAmount,result.remainingAmount],[40,60]);
 assert.deepEqual([future.date,future.accountId,future.amount],['2027-04-15','a2',60]);
 assert.equal(result.editorItem.date,saved.plan_date);assert.equal(result.editorItem.accountId,saved.account_id);
});

test('지정 계획의 수동 누적 확인이 실제 출금보다 크면 원래 계획일을 유지한다',()=>{
 const data=dataset([...history(100,[15,15,15]),row('actual','2027-04-02',40)]);
 const saved=edit({plan_date:'2027-04-15',confirmed_amount:90,confirmed_date:'2027-04-08',confirmation_complete:false,confirmation_memo:'합성 확인'});
 const result=review(data,[saved]).rows[0];
 assert.equal(result.displayDate,'2027-04-15');assert.equal(result.displayDateIsActual,false);
 assert.deepEqual(result.recordedPaymentDates,[{date:'2027-04-02',amount:40,transactionCount:1}]);
 assert.deepEqual([result.recordedAmount,result.remainingAmount],[90,10]);
});

test('연결 계획이 없는 실제 출금도 별도 보존하되 예산과 반영 출금 합계에는 더하지 않는다',()=>{
 const data=dataset([...history(),row('matched','2027-04-06',40),row('one-off','2027-04-02',25,{description:'합성 일회 출금'}),row('move','2027-04-03',50,{description:'합성 자금 이동',category_id:'internal'}),row('income','2027-04-02',500,{direction:'in'})],{categories:[{id:'fee',name:'지급수수료',group_name:'영업지출',is_internal:false,is_operating:true},{id:'internal',name:'계좌간이체',group_name:'내부이동',is_internal:true,is_operating:false}]});
 const {rows,business,editable}=review(data);
 assert.equal(rows.length,1);assert.deepEqual([business.originalTotal,business.recordedTotal,business.remainingTotal],[100,40,60]);
 assert.equal(editable.estimates.businesses[0].total,60);
 assert.deepEqual(business.actualOnlyRows.map(item=>[item.transactionId,item.date,item.amount,item.accountId,item.isInternal]),[['one-off','2027-04-02',25,'a1',false],['move','2027-04-03',50,'a1',true]]);
 const represented=rows.flatMap(item=>item.editorItem.recordedTransactions??[]).map(item=>item.id);
 const displayed=[...represented,...business.actualOnlyRows.map(item=>item.transactionId)].sort();
 assert.deepEqual(displayed,cashCalendarActualTransactions(data,asOf).transactions.filter(item=>item.txn_date>=range.from&&item.txn_date<=range.to).map(item=>item.id).sort());
 assert.equal(new Set(displayed).size,displayed.length);
});

test('계획 외 원장·은행 중복은 같은 canonical 실제 출금 한 행만 표시한다',()=>{
 const actual=row('unmatched','2027-04-02',35,{description:'합성 원본 출금',txn_time:'09:00:00',balance:965});
 const bank:BankPlanActual={account_id:'a1',business_id:'b1',external_transaction_id:'bank-actual',txn_date:actual.txn_date,txn_time:actual.txn_time!,amount:actual.amount,balance:actual.balance,description:actual.description,party:null,source_details:null,currency:'KRW',source:'clobe',collected_at:'2027-04-12T03:00:00Z',synced_at:'2027-04-12T04:00:00Z',transaction_id:actual.id};
 const coverage:BankPlanCoverage={account_id:'a1',business_id:'b1',from:'2027-04-01',to:asOf,collected_at:bank.collected_at,synced_at:bank.synced_at,status:'complete',reason:null,currency:'KRW',source:'clobe'};
 const {business}=review(dataset([actual],{bank_plan_actuals:[bank],bank_plan_coverage:[coverage]}));
 assert.equal(business.rows.length,0);assert.equal(business.actualOnlyRows.length,1);
 assert.deepEqual([business.actualOnlyRows[0].transactionId,business.actualOnlyRows[0].amount,business.actualOnlyRows[0].source],['unmatched',35,'bank-query']);
 assert.deepEqual([business.originalTotal,business.recordedTotal,business.remainingTotal],[0,0,0]);
});

test('제외하거나 조회기간 밖인 계획도 실제 출금을 숨기거나 예정 예산을 부활시키지 않는다',()=>{
 const data=dataset([...history(),row('actual','2027-04-06',40)]);
 const excluded=review(data,[edit({excluded:true})]);
 assert.equal(excluded.rows.length,0);assert.equal(excluded.business.remainingTotal,0);
 assert.deepEqual(excluded.business.actualOnlyRows.map(item=>item.transactionId),['actual']);
 const outside=review(data,[edit({plan_date:'2027-04-25'})],'estimated',{from:'2027-04-01',to:'2027-04-12'});
 assert.equal(outside.rows.length,0);assert.equal(outside.business.remainingTotal,0);
 assert.deepEqual(outside.business.actualOnlyRows.map(item=>item.transactionId),['actual']);
});

test('계획 연결이 모호해도 실제 출금 자체는 계획 외 행으로 한 번 표시한다',()=>{
 const data=dataset([...history(),row('actual','2027-04-06',40)]),editable=buildEditableCashPlan(data,range,asOf,[]);
 const ambiguous={...editable,items:editable.items.map(item=>({...item,recordedAmbiguous:true,reconciliationReason:'합성 연결 후보 중복'}))};
 const business=buildCashPlanWorksheetModel({data,editable:ambiguous,basis:'estimated',range,asOf}).businesses[0];
 assert.deepEqual(business.rows[0].recordedPaymentDates,[]);
 assert.deepEqual(business.actualOnlyRows.map(item=>item.transactionId),['actual']);
 assert.equal(business.remainingTotal,editable.items[0].remainingAmount);
});

test('계획 외 실제 출금은 기간 양끝과 기준일·사업자 계좌 소유·동일ID 충돌을 엄격히 검증한다',()=>{
 const data=dataset([
  row('first','2027-04-02',10,{description:'합성 첫 출금'}),row('last','2027-04-06',20,{description:'합성 마지막 출금'}),row('before','2027-04-01',30),row('after','2027-04-07',40),
  row('future','2027-04-20',50),row('wrong-owner','2027-04-03',60,{business_id:'b2'}),row('missing-account','2027-04-03',70,{account_id:'missing'}),
  row('conflict','2027-04-03',80),row('conflict','2027-04-03',90),row('duplicate','2027-04-04',15),row('duplicate','2027-04-04',15),
 ]);
 const {business}=review(data,[],'estimated',{from:'2027-04-02',to:'2027-04-06'});
 assert.deepEqual(business.actualOnlyRows.map(item=>[item.transactionId,item.amount]),[['first',10],['duplicate',15],['last',20]]);
 assert.equal(business.remainingTotal,0);
});

test('수동 완료 확인액이 실제 출금보다 크면 확인 합계를 유지하고 실제는 날짜가 있는 별도 행으로 보존한다',()=>{
 const data=dataset([...history(),row('later-actual','2027-04-10',4)]);
 const saved=edit({plan_date:'2027-04-05',confirmed_amount:90,confirmed_date:'2027-04-05',confirmation_complete:true,confirmation_memo:'합성 완료 확인'});
 const {rows,business,editable}=review(data,[saved]);
 assert.equal(rows.length,1);assert.equal(rows[0].displayDate,'2027-04-05');assert.equal(rows[0].displayDateIsActual,false);
 assert.deepEqual([rows[0].recordedAmount,rows[0].remainingAmount,rows[0].status],[90,0,'confirmed']);
 assert.deepEqual(business.actualOnlyRows.map(item=>[item.transactionId,item.date,item.amount]),[['later-actual','2027-04-10',4]]);
 assert.deepEqual([business.originalTotal,business.recordedTotal,business.remainingTotal],[100,90,0]);
 assert.equal(editable.estimates.businesses[0].total,0);
 assert.equal(rows[0].editorItem.confirmedAmount,90);assert.equal(rows[0].editorItem.confirmationComplete,true);
});
