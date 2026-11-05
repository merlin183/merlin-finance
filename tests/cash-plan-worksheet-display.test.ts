import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CashPlanWorksheet} from '../components/finance/cash-plan-worksheet';
import {buildEditableCashPlan} from '../lib/finance/editable-cash-plan';
import {buildCashPlanWorksheetModel} from '../lib/finance/cash-plan-worksheet-model';
import {buildLatestCashBalances} from '../lib/finance/latest-cash-balances';
import {cashEstimateSourceKey} from '../lib/finance/cash-estimates';
import type {CashPlanEdit} from '../lib/finance/cash-plan-edits';
import type {BankPlanActual,BankPlanCoverage} from '../lib/finance/clobe-plan-actuals';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

const range={from:'2027-04-01',to:'2027-04-30'},asOf='2027-04-12';
const transaction=(id:string,date:string,amount:number,description:string):Transaction=>({id,business_id:'business',account_id:'account',txn_date:date,amount,direction:'out',balance:null,description,raw_gwamok:'',category_id:'fees',upload_id:null,is_internal:false,tax_invoice:false,dedup_hash:id,manually_classified:false});
const bankActual=(amount:number,description='합성 서비스'):BankPlanActual=>({account_id:'account',business_id:'business',external_transaction_id:'synthetic-bank-outflow',txn_date:'2027-04-06',txn_time:'12:00:00',amount,balance:1000000,description,party:null,source_details:null,currency:'KRW',source:'clobe',collected_at:'2027-04-12T03:00:00Z',synced_at:'2027-04-12T04:00:00Z',transaction_id:null});
const bankCoverage=(overrides:Partial<BankPlanCoverage>={}):BankPlanCoverage=>({account_id:'account',business_id:'business',from:'2027-04-01',to:asOf,collected_at:'2027-04-12T03:00:00Z',synced_at:'2027-04-12T04:00:00Z',status:'complete',reason:null,currency:'KRW',source:'clobe',...overrides});
const dataset=(transactions:Transaction[]=[],extra:Partial<Dataset>={}):Dataset=>({...emptyDataset,
 businesses:[{id:'business',name:'합성 사업자',representative:'',kind:'법인',reserve:0,color:'#123456'}],
 accounts:[{id:'account',business_id:'business',name:'합성 계좌',bank:'합성 은행',masked_number:'0001',opening_balance:2000000,opening_balance_date:'2027-03-31'}],
 categories:[{id:'fees',name:'합성 비용',group_name:'영업지출',is_internal:false,is_operating:true}],transactions,...extra,
});
function render(data:Dataset,basis:'estimated'|'registered'='estimated',edits:CashPlanEdit[]=[],options:{saving?:boolean;confirmingKey?:string;range?:typeof range;asOf?:string}={}){
 const {range:selected=range,asOf:now=asOf,...componentOptions}=options;
 const editable=buildEditableCashPlan(data,selected,now,edits);
 const worksheet=buildCashPlanWorksheetModel({data,editable,basis,range:selected,asOf:now});
 return renderToStaticMarkup(createElement(CashPlanWorksheet,{
  plans:editable.plan.businesses,estimates:new Map(editable.estimates.businesses.map(item=>[item.business.id,item])),
  worksheetBusinesses:new Map(worksheet.businesses.map(item=>[item.businessId,item])),
  latestBalances:new Map(buildLatestCashBalances(data,now).businesses.map(item=>[item.business.id,item])),
  basis,selectedBusiness:'',onOpenDetail:()=>{},onEditBusiness:()=>{},onConfirmPayment:()=>{},...componentOptions,
 }));
}

test('간결한 표는 소진·지난 날짜를 보존하고 다른 금액만 취소선과 실제 출금으로 표시한다',()=>{
 const history=[{day:1,amount:100000,title:'합성 A'},{day:5,amount:200000,title:'합성 B'},{day:8,amount:300000,title:'합성 C'}].flatMap(item=>['01','02','03'].map(month=>transaction(`${item.title}-${month}`,`2027-${month}-${String(item.day).padStart(2,'0')}`,item.amount,item.title)));
 const html=render(dataset([...history,transaction('spent','2027-04-02',100000,'합성 A'),transaction('partial','2027-04-06',80000,'합성 B')]));
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 const rows=[...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(item=>item[1]);
 assert.equal(rows.length,3);
 assert.deepEqual(rows.map(row=>row.match(/<time dateTime="([^"]+)"/i)![1]),['2027-04-02','2027-04-06','2027-04-08']);
 assert.match(rows[0],/class="cash-worksheet-amount">100,000<\/td>/);
 assert.equal((rows[0].match(/100,000/g)||[]).length,1);assert.doesNotMatch(rows[0],/<del|지급 완료/);
 assert.match(rows[0],/>출금 반영<\/span>/);
 assert.match(rows[1],/<del class="cash-worksheet-estimate-changed">[\s\S]*200,000<\/del>/);
 assert.match(rows[1],/class="cash-worksheet-actual">[\s\S]*80,000<\/span>/);
 assert.match(rows[1],/>출금 반영<\/span>/);assert.doesNotMatch(rows[1].match(/<td class="cash-worksheet-amount">([\s\S]*?)<\/td>/)![1],/120,000/);
 assert.match(rows[2],/class="cash-worksheet-amount">300,000<\/td>/);
 assert.match(rows[2],/>미반영<\/span>/);assert.doesNotMatch(rows[2],/<del/);
 assert.doesNotMatch(html,/전체 계획 예산|근거 보기|남은 차감 예산/);
 assert.match(html,/남은 지출 합계<\/strong><b>420,000/);
 assert.match(html,/지출 후 잔액<\/dt><dd class="">1,400,000/);
 assert.match(html,/잔액은 남은 예산만 차감/);
 assert.match(html,/계획 편집/);assert.match(html,/기간 전체 계획 · 3건/);
});

test('실적을 연결하지 않은 직접·등록 항목은 화면에서 0원이나 지급 완료로 단정하지 않는다',()=>{
 const manual:CashPlanEdit={id:'manual',business_id:'business',source_type:'manual',source_key:'manual',month:'2027-04',title:'합성 수동 지출',account_id:'account',plan_date:'2027-04-05',amount:50000,memo:'합성 메모',excluded:false,version:1,updated_at:'2027-04-12T00:00:00Z'};
 const data=dataset([transaction('similar','2027-04-05',80000,'합성 등록 지출')],{recurring:[{id:'registered',business_id:'business',title:'합성 등록 지출',amount:80000,direction:'out',day:5,start_date:'2027-04-01',end_date:null,frequency:'monthly'}]});
 const html=render(data,'registered',[manual]);
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.equal((tbody.match(/>확인 필요<\/span>/g)||[]).length,2);
 assert.doesNotMatch(tbody,/<del|>미반영<\/span>|>출금 반영<\/span>|지급 완료/);
 assert.match(tbody,/class="cash-worksheet-amount">80,000<\/td>/);
 assert.match(tbody,/class="cash-worksheet-amount">50,000<\/td>/);
 assert.doesNotMatch(tbody,/cash-worksheet-memo|합성 메모/);
 assert.doesNotMatch(tbody,/통장 실적 자동 연결 없음|직접 추가 ·|등록 예정 ·/);
 assert.match(html,/남은 지출 합계<\/strong><b>50,000/);
 assert.match(html,/지출 후 잔액<\/dt><dd class="cash-plan-unknown">확인 필요/);
});

test('추정액보다 많이 출금되어도 실제액을 그대로 보여주고 잔액에서 다시 차감하지 않는다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-05`,100000,'합성 서비스'));
 const html=render(dataset([...history,transaction('over','2027-04-06',120000,'합성 서비스')]));
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(tbody,/<del class="cash-worksheet-estimate-changed">[\s\S]*100,000<\/del>/);
 assert.match(tbody,/class="cash-worksheet-actual">[\s\S]*120,000<\/span>/);
 assert.match(tbody,/>출금 반영<\/span>/);
 assert.match(html,/남은 지출 합계<\/strong><b>0/);
 assert.match(html,/지출 후 잔액<\/dt><dd class="">1,880,000/);
});

test('명시적으로 납부 완료한 세금만 완료 표시하고 확인되지 않은 실제액을 만들지 않는다',()=>{
 const paid:CashPlanEdit={id:'paid-tax',business_id:'business',source_type:'manual',source_key:'paid-tax',month:'2027-04',title:'합성 세금',account_id:'account',plan_date:'2027-04-05',amount:250000,memo:'',excluded:false,payment_kind:'tax',payment_status:'paid',version:1,updated_at:'2027-04-12T00:00:00Z'};
 const html=render(dataset(),'estimated',[paid]);
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(tbody,/>납부 완료<\/span>/);
 assert.match(tbody,/class="cash-worksheet-amount">250,000<\/td>/);
 assert.doesNotMatch(tbody,/<del|cash-worksheet-actual|>출금 반영<\/span>/);
 assert.match(html,/남은 지출 합계<\/strong><b>0/);
});

test('사업자가 네 개이면 기존 네 칸 배치와 3열 표를 유지한다',()=>{
 const base=dataset();
 const data={...base,businesses:[1,2,3,4].map(index=>({...base.businesses[0],id:`business-${index}`,name:`합성 사업자 ${index}`}))};
 const html=render(data);
 assert.match(html,/grid-template-columns:repeat\(4,minmax\(216px,1fr\)\)/);
 assert.equal((html.match(/<th scope="col">품목/g)||[]).length,4);
 assert.equal((html.match(/<th scope="col">금액/g)||[]).length,4);
 assert.equal((html.match(/<th scope="col">비고/g)||[]).length,4);
});

test('미래 출금은 현재 실적으로 표시하지 않고 0원 반영은 추정액을 취소하지 않는다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-15`,100000,'합성 미래 서비스'));
 const html=render(dataset([...history,transaction('future','2027-04-15',100000,'합성 미래 서비스')]));
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(tbody,/<time dateTime="2027-04-15"/i);
 assert.match(tbody,/class="cash-worksheet-amount">100,000<\/td>/);
 assert.match(tbody,/>미반영<\/span>/);
 assert.doesNotMatch(tbody,/<del|cash-worksheet-actual|>출금 반영<\/span>|지급 완료/);
 assert.match(html,/남은 지출 합계<\/strong><b>100,000/);
});

test('사용자가 제외한 추정 항목은 지급 이력 복원 표시에서도 제외하며 긴 비고는 표에서 숨긴다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-05`,100000,'합성 서비스'));
 const sourceKey=cashEstimateSourceKey(history[0]);
 const edit:CashPlanEdit={id:'edit',business_id:'business',source_type:'estimated',source_key:sourceKey,month:'2027-04',title:'합성 수정 계획',account_id:'account',plan_date:'2027-04-05',amount:100000,memo:'[clobe-card-bill:synthetic-company:synthetic-key]\n대체 계획 키: ["synthetic-source"]\n자동이체 확인\n담당자 메모',excluded:false,version:1,updated_at:'2027-04-12T00:00:00Z'};
 const data=dataset([...history,transaction('paid','2027-04-06',100000,'합성 서비스')]);
 const html=render(data,'estimated',[edit]);
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(tbody,/합성 수정 계획/);
 assert.doesNotMatch(tbody,/cash-worksheet-memo|자동이체 확인|담당자 메모/);
 assert.doesNotMatch(tbody,/clobe-card-bill|synthetic-source|반복 출금 추정|동월 실적|클로브 카드 청구 반영/);
 const excludedHtml=render(data,'estimated',[{...edit,excluded:true}]);
 const excludedBody=excludedHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(excludedBody,/cash-worksheet-actual-only-row/);
 assert.match(excludedBody,/합성 서비스/);
 assert.doesNotMatch(excludedBody,/합성 수정 계획|<button|출금 확인/);
 assert.match(excludedHtml,/남은 지출 합계<\/strong><b>0/);
});

test('직접 확인은 은행 반영 상태와 구분하며 큰 은행 실제액과 기존 취소선 표시를 보존한다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-05`,100000,'합성 서비스'));
 const edit:CashPlanEdit={id:'confirmed',business_id:'business',source_type:'estimated',source_key:cashEstimateSourceKey(history[0]),month:'2027-04',title:'합성 확인 계획',account_id:'account',plan_date:'2027-04-05',amount:100000,memo:'계획 메모',excluded:false,confirmed_amount:60000,confirmed_date:'2027-04-06',confirmation_complete:true,confirmation_memo:'통장 직접 확인',version:1,updated_at:'2027-04-12T00:00:00Z'};
 const data=dataset([...history,transaction('actual','2027-04-06',80000,'합성 서비스')]);
 const html=render(data,'estimated',[edit]);
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(tbody,/>확인 완료<\/span>/);assert.doesNotMatch(tbody,/>출금 반영<\/span>/);
 assert.match(tbody,/<del class="cash-worksheet-estimate-changed">[\s\S]*100,000<\/del>/);
 assert.match(tbody,/class="cash-worksheet-actual">[\s\S]*80,000<\/span>/);assert.doesNotMatch(tbody,/60,000/);
 assert.doesNotMatch(tbody,/계획 메모|통장 직접 확인/);assert.match(tbody,/출금 확인 수정/);
 assert.match(html,/남은 지출 합계<\/strong><b>0/);
 assert.match(html,/지출 후 잔액<\/dt><dd class="">1,920,000/);
 assert.match(html,/동기화한 은행 출금도 계획에 반영합니다/);
});

test('일부 확인·해제는 남은 금액과 자동 거래 상태를 다시 표시하며 세금은 전용 납부 확인을 유지한다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-05`,200000,'합성 서비스'));
 const edit:CashPlanEdit={id:'partial-confirmation',business_id:'business',source_type:'estimated',source_key:cashEstimateSourceKey(history[0]),month:'2027-04',title:'합성 일부 계획',account_id:'account',plan_date:'2027-04-05',amount:200000,memo:'',excluded:false,confirmed_amount:120000,confirmed_date:'2027-04-06',confirmation_complete:false,confirmation_memo:'일부 지급',version:1,updated_at:'2027-04-12T00:00:00Z'};
 const data=dataset([...history,transaction('actual','2027-04-06',80000,'합성 서비스')]);
 const html=render(data,'estimated',[edit]);
 assert.match(html,/>일부 확인<\/span>/);assert.doesNotMatch(html,/>확인 완료<\/span>/);
 assert.match(html,/남은 지출 합계<\/strong><b>80,000/);
 assert.match(html,/지출 후 잔액<\/dt><dd class="">1,840,000/);
 const cleared=render(data,'estimated',[{...edit,confirmed_amount:null,confirmed_date:null,confirmation_complete:false,confirmation_memo:''}]);
 assert.match(cleared,/>출금 반영<\/span>/);assert.doesNotMatch(cleared,/>일부 확인<\/span>|출금 확인 수정/);
 assert.match(cleared,/남은 지출 합계<\/strong><b>120,000/);
 const paid:CashPlanEdit={...edit,id:'tax',source_type:'manual',source_key:'tax',title:'합성 세금',payment_kind:'tax',payment_status:'paid',confirmed_amount:null,confirmed_date:null,confirmation_memo:''};
 const tax=render(dataset(),'estimated',[paid]);
 assert.match(tax,/>납부 완료<\/span>/);assert.doesNotMatch(tax,/aria-label="[^"]*합성 세금 출금 확인/);
});

test('원장에 아직 없는 은행 조회 출금도 실제 지급일을 표시하고 남은 계획일을 구분한다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-05`,100000,'합성 서비스'));
 const data=dataset(history,{bank_plan_actuals:[bankActual(60000)],bank_plan_coverage:[bankCoverage()]});
 const html=render(data),tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.equal(data.transactions.length,3);
 assert.match(tbody,/<time dateTime="2027-04-06">4월 6일<\/time>/i);
 assert.match(tbody,/남은 예정 <time dateTime="2027-04-05">4\/5<\/time> 40,000/i);
 assert.match(tbody,/<del class="cash-worksheet-estimate-changed">[\s\S]*100,000<\/del>/);
 assert.match(tbody,/class="cash-worksheet-actual">[\s\S]*60,000<\/span>/);
 assert.match(tbody,/title="[^"]*은행 조회[^\"]*">출금 반영<\/span>/);
 assert.doesNotMatch(tbody,/>확인 완료<\/span>|지급 완료|남은 예산|근거 보기/);
 assert.match(html,/남은 지출 합계<\/strong><b>40,000/);
});

test('은행 조회가 불완전하면 실제액을 보존하면서 확인 필요를 표시하고 직접 확인을 우선한다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-05`,100000,'합성 서비스'));
 const data=dataset(history,{bank_plan_actuals:[bankActual(60000)],bank_plan_coverage:[bankCoverage({to:'2027-04-06',status:'confirmation-needed',reason:'합성 다음 페이지 조회 실패'})]});
 const html=render(data),tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(tbody,/class="cash-worksheet-actual">[\s\S]*60,000<\/span>/);
 assert.match(tbody,/title="통장 출금 조회가 일부이거나 최신 조회를 완료하지 못했습니다\.">확인 필요<\/span>/);
 assert.doesNotMatch(tbody,/>출금 반영<\/span>|>확인 완료<\/span>/);
 const edit:CashPlanEdit={id:'confirmed',business_id:'business',source_type:'estimated',source_key:cashEstimateSourceKey(history[0]),month:'2027-04',title:'합성 서비스',account_id:'account',plan_date:'2027-04-05',amount:100000,memo:'',excluded:false,confirmed_amount:60000,confirmed_date:'2027-04-06',confirmation_complete:true,confirmation_memo:'통장 확인',version:1,updated_at:'2027-04-12T04:00:00Z'};
 const confirmed=render(data,'estimated',[edit]);
 assert.match(confirmed,/title="사용자 출금 완료 확인">확인 완료<\/span>/);assert.doesNotMatch(confirmed,/통장 확인/);
 assert.match(confirmed,/남은 지출 합계<\/strong><b>0/);
});

test('날짜 미정 계획은 확인된 실제 지급일을 주 날짜로 보여주고 남은 월 예산은 날짜 미정으로 구분한다',()=>{
 const history=['01','02','03'].flatMap(month=>[transaction(`early-${month}`,`2027-${month}-02`,100000,'합성 서비스'),transaction(`late-${month}`,`2027-${month}-15`,100000,'합성 서비스')]);
 const html=render(dataset([...history,transaction('actual','2027-04-02',60000,'합성 서비스')]));
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(tbody,/<time dateTime="2027-04-02">4월 2일<\/time> <span>합성 서비스<\/span>/i);
 assert.match(tbody,/cash-worksheet-actual-date-badge">실제 출금/);
 assert.match(tbody,/남은 월예산 140,000 <span>· 일자 미정/);
 assert.equal((tbody.match(/<time /g)||[]).length,1);
 assert.doesNotMatch(tbody,/cash-worksheet-undated|class="cash-worksheet-payment-date"/);
 assert.doesNotMatch(tbody,/cash-worksheet-payment-dates|실제 지급|예정 4\/2/);
 assert.match(html,/남은 지출 합계<\/strong><b>140,000/);
});

test('여러 실제 지급일은 접힌 목록으로 날짜별 금액을 표시하고 월 합계를 늘리지 않는다',()=>{
 const history=['01','02','03'].flatMap(month=>[transaction(`early-${month}`,`2027-${month}-02`,100000,'합성 서비스'),transaction(`late-${month}`,`2027-${month}-15`,100000,'합성 서비스')]);
 const html=render(dataset([...history,transaction('first','2027-04-02',30000,'합성 서비스'),transaction('same-day','2027-04-02',20000,'합성 서비스'),transaction('second','2027-04-10',40000,'합성 서비스')]));
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(tbody,/<details class="cash-worksheet-payment-dates"><summary>실제 지급 2일<\/summary>/);
 assert.match(tbody,/<time dateTime="2027-04-02">4월 2일<\/time><span class="cash-worksheet-other-payment-dates"> 외 1일<\/span>/i);
 assert.match(tbody,/cash-worksheet-actual-date-badge">실제 출금/);
 assert.match(tbody,/남은 월예산 110,000 <span>· 일자 미정/);
 assert.doesNotMatch(tbody,/<details[^>]*\bopen/);
 assert.match(tbody,/<time dateTime="2027-04-02">4\/2<\/time><span>50,000원<\/span>/i);
 assert.match(tbody,/<time dateTime="2027-04-10">4\/10<\/time><span>40,000원<\/span>/i);
 assert.match(html,/남은 지출 합계<\/strong><b>110,000/);
});

test('직접 확인만 있는 계획에는 실제 통장 지급일 목록을 만들지 않는다',()=>{
 const manual:CashPlanEdit={id:'manual-confirmed',business_id:'business',source_type:'manual',source_key:'manual-confirmed',month:'2027-04',title:'합성 직접 확인',account_id:'account',plan_date:null,amount:100000,memo:'',excluded:false,confirmed_amount:60000,confirmed_date:'2027-04-02',confirmation_complete:false,confirmation_memo:'',version:1,updated_at:'2027-04-12T04:00:00Z'};
 const html=render(dataset(),'estimated',[manual]),tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.doesNotMatch(tbody,/cash-worksheet-payment-date|실제 지급|<time/);
 assert.match(tbody,/>일부 확인<\/span>/);
 assert.match(html,/남은 지출 합계<\/strong><b>40,000/);
});

test('날짜 미정 11월 2일 실제 출금이 5일·6일 예정 항목보다 먼저 나타나며 3열과 합계를 유지한다',()=>{
 const months=['08','09','10'];
 const history=months.flatMap(month=>[
  transaction(`variable-a-${month}`,`2027-${month}-02`,100000,'합성 다회 결제'),transaction(`variable-b-${month}`,`2027-${month}-15`,100000,'합성 다회 결제'),
  transaction(`fixed-a-${month}`,`2027-${month}-05`,50000,'합성 보험 A'),transaction(`fixed-b-${month}`,`2027-${month}-06`,30000,'합성 보험 B'),
 ]);
 const base=dataset([...history,transaction('actual-a','2027-11-02',30000,'합성 다회 결제'),transaction('actual-b','2027-11-02',40000,'합성 다회 결제')]);
 const data={...base,accounts:base.accounts.map(account=>({...account,opening_balance_date:'2027-10-31'}))};
 const html=render(data,'estimated',[],{range:{from:'2027-11-01',to:'2027-11-30'},asOf:'2027-11-03'});
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 const rows=[...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(item=>item[1]);
 assert.equal(rows.length,3);
 assert.deepEqual(rows.map(row=>row.match(/<time dateTime="([^"]+)"/i)![1]),['2027-11-02','2027-11-05','2027-11-06']);
 assert.match(rows[0],/합성 다회 결제<\/span><span class="cash-worksheet-actual-date-badge">실제 출금/);
 assert.match(rows[0],/cash-worksheet-actual">[\s\S]*70,000<\/span>/);
 assert.match(rows[0],/남은 월예산 130,000 <span>· 일자 미정/);
 assert.doesNotMatch(rows[0],/cash-worksheet-undated|2027-11-15|04\/01/);
 assert.equal((rows[0].match(/<time /g)||[]).length,1);
 assert.equal((rows[0].match(/<td /g)||[]).length,2);
 assert.equal((html.match(/남은 지출 합계<\/strong><b>210,000/g)||[]).length,1);
 assert.match(html,/지출 후 잔액<\/dt><dd class="">1,720,000/);
});

test('수동 확인액이 통장 실적보다 크면 확인 행은 유지하고 실제 출금은 별도 날짜 행으로 한 번 표시한다',()=>{
 const history=['01','02','03'].flatMap(month=>[transaction(`early-${month}`,`2027-${month}-02`,100000,'합성 서비스'),transaction(`late-${month}`,`2027-${month}-15`,100000,'합성 서비스')]);
 const saved:CashPlanEdit={id:'confirmed-undated',business_id:'business',source_type:'estimated',source_key:cashEstimateSourceKey(history[0]),month:'2027-04',title:'합성 서비스',account_id:'account',plan_date:null,amount:200000,memo:'',excluded:false,confirmed_amount:90000,confirmed_date:'2027-04-08',confirmation_complete:false,confirmation_memo:'',version:1,updated_at:'2027-04-12T04:00:00Z'};
 const html=render(dataset([...history,transaction('actual','2027-04-02',60000,'합성 서비스')]),'estimated',[saved]);
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 const rows=[...tbody.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)].map(item=>({attributes:item[1],content:item[2]}));
 assert.equal(rows.length,2);assert.match(rows[0].attributes,/cash-worksheet-actual-only-row/);
 assert.match(rows[0].content,/<time dateTime="2027-04-02">4월 2일<\/time>/i);
 assert.match(rows[0].content,/cash-worksheet-amount">60,000<\/td>/);
 assert.doesNotMatch(rows[0].content,/<button|출금 확인/);
 assert.match(rows[1].content,/cash-worksheet-undated">04\/01 ~ 04\/30/);
 assert.doesNotMatch(rows[1].content,/cash-worksheet-actual-date-badge|cash-worksheet-remaining-month-budget|<time|60,000|2027-04-08/);
 assert.equal((tbody.match(/60,000/g)||[]).length,1);
 assert.match(html,/기간 전체 계획 · 1건 · 별도 실제 1건/);
 assert.match(html,/남은 지출 합계<\/strong><b>110,000/);
});

test('지정 계획의 조기·지연 실제 출금을 실제 날짜순으로 표시하고 소진한 예정액은 다시 더하지 않는다',()=>{
 const history=['01','02','03'].flatMap(month=>[
  transaction(`early-${month}`,`2027-${month}-15`,100000,'합성 조기 지급'),
  transaction(`late-${month}`,`2027-${month}-01`,200000,'합성 지연 지급'),
  transaction(`pending-${month}`,`2027-${month}-05`,50000,'합성 미지급'),
 ]);
 const html=render(dataset([...history,transaction('early-actual','2027-04-02',100000,'합성 조기 지급'),transaction('late-actual','2027-04-10',200000,'합성 지연 지급')]));
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 const rows=[...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(item=>item[1]);
 assert.deepEqual(rows.map(row=>row.match(/<time dateTime="([^"]+)"/i)![1]),['2027-04-02','2027-04-05','2027-04-10']);
 assert.match(rows[0],/합성 조기 지급<\/span><span class="cash-worksheet-actual-date-badge">실제 출금/);
 assert.match(rows[2],/합성 지연 지급<\/span><span class="cash-worksheet-actual-date-badge">실제 출금/);
 assert.doesNotMatch(rows[0]+rows[2],/남은 예정|cash-worksheet-payment-date|2027-04-15|2027-04-01/);
 assert.equal((rows[0].match(/<time /g)||[]).length,1);assert.equal((rows[2].match(/<time /g)||[]).length,1);
 assert.match(html,/남은 지출 합계<\/strong><b>50,000/);
});

test('지정일 일부 출금은 실제 계좌와 날짜를 우선하고 남은 예정의 원래 일자·다른 계좌를 함께 표시한다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-15`,100000,'합성 서비스'));
 const base=dataset([...history,transaction('actual','2027-04-02',40000,'합성 서비스')]);
 const data={...base,accounts:[...base.accounts,{...base.accounts[0],id:'destination',name:'새 계획 계좌',opening_balance:0}]};
 const saved:CashPlanEdit={id:'moved-plan',business_id:'business',source_type:'estimated',source_key:cashEstimateSourceKey(history[0]),month:'2027-04',title:'합성 서비스',account_id:'destination',plan_date:'2027-04-15',amount:100000,memo:'',excluded:false,version:1,updated_at:'2027-04-12T04:00:00Z'};
 const html=render(data,'estimated',[saved]),tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(tbody,/<time dateTime="2027-04-02">4월 2일<\/time>/i);
 assert.match(tbody,/cash-worksheet-actual-date-badge">실제 출금/);
 assert.match(tbody,/남은 예정 <time dateTime="2027-04-15">4\/15<\/time> 60,000<small>예정 계좌 새 계획 계좌<\/small>/i);
 assert.match(tbody,/class="cash-worksheet-source">합성 계좌<\/span>/);
 assert.doesNotMatch(tbody,/class="cash-worksheet-source">새 계획 계좌/);
 assert.match(html,/남은 지출 합계<\/strong><b>60,000/);
});

test('계획일과 실제 지급일이 같아도 실제 배지를 붙이고 단일 지급일은 한 번만 표시한다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-05`,100000,'합성 동일일 지급'));
 const html=render(dataset([...history,transaction('actual','2027-04-05',100000,'합성 동일일 지급')])),tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.equal((tbody.match(/<time /g)||[]).length,1);
 assert.match(tbody,/<time dateTime="2027-04-05">4월 5일<\/time>/i);
 assert.match(tbody,/cash-worksheet-actual-date-badge">실제 출금/);
 assert.doesNotMatch(tbody,/cash-worksheet-payment-date|남은 예정/);
 assert.match(html,/남은 지출 합계<\/strong><b>0/);
});

test('지정 계획의 복수 실제 지급일은 첫 실제일과 추가 일수·상세 목록을 보이고 잔여 원래 계획일은 유지한다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-15`,100000,'합성 분할 지급'));
 const html=render(dataset([...history,transaction('second','2027-04-10',30000,'합성 분할 지급'),transaction('first','2027-04-02',40000,'합성 분할 지급')]));
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(tbody,/<time dateTime="2027-04-02">4월 2일<\/time><span class="cash-worksheet-other-payment-dates"> 외 1일<\/span>/i);
 assert.match(tbody,/<details class="cash-worksheet-payment-dates"><summary>실제 지급 2일<\/summary>/);
 assert.match(tbody,/남은 예정 <time dateTime="2027-04-15">4\/15<\/time> 30,000/i);
 assert.match(tbody,/<time dateTime="2027-04-02">4\/2<\/time><span>40,000원<\/span>[\s\S]*<time dateTime="2027-04-10">4\/10<\/time><span>30,000원<\/span>/i);
 assert.match(html,/남은 지출 합계<\/strong><b>30,000/);
});

test('계획 없는 실제 출금은 날짜순 읽기 전용 행으로 추가하고 예정 금액과 합계는 유지한다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-05`,100000,'합성 예정 서비스'));
 const data=dataset([...history,transaction('one-off','2027-04-02',25000,'합성 일회 출금'),transaction('late-one-off','2027-04-10',35000,'합성 다른 출금')]);
 const html=render(data),tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 const rows=[...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(item=>item[1]);
 assert.equal(rows.length,3);
 assert.deepEqual(rows.map(row=>row.match(/<time dateTime="([^"]+)"/i)![1]),['2027-04-02','2027-04-05','2027-04-10']);
 for(const row of [rows[0],rows[2]]){
  assert.match(row,/cash-worksheet-actual-date-badge">실제 출금/);
  assert.match(row,/cash-worksheet-source">합성 계좌/);
  assert.match(row,/통장 거래/);
  assert.doesNotMatch(row,/<button|<del|출금 확인|계획 편집|남은 예정|남은 월예산/);
  assert.equal((row.match(/<td /g)||[]).length,2);
 }
 assert.match(rows[0],/cash-worksheet-amount">25,000<\/td>/);
 assert.match(rows[2],/cash-worksheet-amount">35,000<\/td>/);
 assert.match(html,/기간 전체 계획 · 1건 · 별도 실제 2건/);
 assert.match(html,/남은 지출 합계<\/strong><b>100,000/);
});

test('계획 외 내부 자금이동도 통장 출금으로 보이되 비용 계획으로 추가하거나 확인 버튼을 만들지 않는다',()=>{
 const actual={...transaction('transfer','2027-04-02',250000,'합성 계좌 이동'),category_id:'transfer',is_internal:true};
 const data=dataset([actual],{categories:[{id:'transfer',name:'계좌간이체',group_name:'내부이동',is_internal:true,is_operating:false}]});
 const html=render(data),tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(tbody,/cash-worksheet-actual-only-row/);
 assert.match(tbody,/내부 자금 이동/);assert.match(tbody,/계좌간이체/);
 assert.doesNotMatch(tbody,/<button|출금 확인|남은 예정|남은 월예산|영업비용/);
 assert.match(html,/기간 전체 계획 · 0건 · 별도 실제 1건/);
 assert.match(html,/남은 지출 합계<\/strong><b>0/);
});

test('수동 완료된 지급일 뒤에 적은 실제 출금이 있어도 원본 실제일·금액을 별도 표시하고 예정액을 부활시키지 않는다',()=>{
 const history=['01','02','03'].map(month=>transaction(`history-${month}`,`2027-${month}-05`,100000,'합성 완료 확인'));
 const saved:CashPlanEdit={id:'confirmed-plan',business_id:'business',source_type:'estimated',source_key:cashEstimateSourceKey(history[0]),month:'2027-04',title:'합성 완료 확인',account_id:'account',plan_date:'2027-04-05',amount:100000,memo:'',excluded:false,confirmed_amount:90000,confirmed_date:'2027-04-05',confirmation_complete:true,confirmation_memo:'',version:1,updated_at:'2027-04-12T04:00:00Z'};
 const html=render(dataset([...history,transaction('late-small-actual','2027-04-10',4000,'합성 완료 확인')]),'estimated',[saved]);
 const tbody=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 const rows=[...tbody.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)].map(item=>({attributes:item[1],content:item[2]}));
 assert.equal(rows.length,2);
 assert.match(rows[0].content,/<time dateTime="2027-04-05">4월 5일<\/time>/i);
 assert.match(rows[0].content,/>확인 완료<\/span>/);
 assert.doesNotMatch(rows[0].content,/cash-worksheet-payment-dates|cash-worksheet-actual-date-badge|2027-04-10|4,000|남은 예정/);
 assert.match(rows[1].attributes,/cash-worksheet-actual-only-row/);
 assert.match(rows[1].content,/<time dateTime="2027-04-10">4월 10일<\/time>/i);
 assert.match(rows[1].content,/cash-worksheet-amount">4,000<\/td>/);
 assert.doesNotMatch(rows[1].content,/<button|출금 확인|확인 완료|90,000/);
 assert.equal((tbody.match(/4,000/g)||[]).length,1);
 assert.match(html,/기간 전체 계획 · 1건 · 별도 실제 1건/);
 assert.match(html,/남은 지출 합계<\/strong><b>0/);
});
