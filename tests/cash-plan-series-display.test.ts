import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CashPlanSeriesSummary,type CashPlanSeriesSummaryMonth} from '../components/finance/cash-plan-series-summary';
import {CashPlanSeriesBreakdownDetails} from '../components/finance/cash-plan-series-breakdown';
import {buildCashPlanSeriesMonthly,type CashPlanSeriesBreakdown,type CashPlanSeriesBreakdownRow} from '../lib/finance/cash-plan-series';
import {CashPlanFixedCostForm,CashPlanFixedCostScope,fixedCostFormError,fixedCostFormValues,type FixedCostFormDraft,type FixedCostFormScope} from '../components/finance/cash-plan-fixed-cost-form';
import {emptyDataset,type Account} from '../lib/finance/types';

const months=['2027-04','2027-05','2027-06','2027-07','2027-08','2027-09'];
const rows:CashPlanSeriesSummaryMonth[]=months.map((month,index)=>({businessId:'synthetic',businessName:'합성 사업자',month,operatingAmount:1234000,installmentAmount:index<3?200000:0,total:1234000+(index<3?200000:0),notes:index<3?['카드 수수료 별도','카드 수수료 별도']:[]}));
const render=(items:CashPlanSeriesSummaryMonth[]=rows)=>renderToStaticMarkup(createElement(CashPlanSeriesSummary,{rows:items,fromMonth:'2027-04',selectedMonth:'2027-05',onMonthChange:()=>{},onSelectMonth:()=>{},onOpenBreakdown:()=>{}}));

test('월별 표는 사업자별 고정비와 유한 할부를 구분하고 모든 금액을 원 단위로 표시한다',()=>{
 const html=render(),body=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.match(html,/월별 고정비·부가세 할부/);
 assert.match(body,/scope="rowgroup" rowSpan="3"[^>]*>합성 사업자/);
 assert.match(body,/>기본 고정비<\/th>/);assert.match(body,/>부가세 할부<\/th>/);assert.match(body,/>월 필요자금<\/th>/);
 assert.equal((body.match(/1,234,000/g)||[]).length,9);
 assert.equal((body.match(/1,434,000/g)||[]).length,3);
 assert.equal((body.match(/cash-series-zero">0/g)||[]).length,3);
 assert.doesNotMatch(body,/만|억/);
 assert.match(html,/실제 출금·남은 지출과 구분/);assert.match(html,/잔액에서 다시 차감하지 않습니다/);
 assert.match(html,/다른 변동 지출은 별도/);
 assert.equal((html.match(/<li>카드 수수료 별도<\/li>/g)||[]).length,1);
});

test('월별 계획이 없거나 누락되면 0원을 만들어 표시하지 않는다',()=>{
 assert.equal(render([]),'');
 const html=render(rows.slice(0,1));
 assert.equal((html.match(/>확인 필요<\/td>/g)||[]).length,15);
 assert.doesNotMatch(html,/cash-series-zero">0/);
});

test('계획 등록 전 월은 실제 지출이 0원인 것으로 표시하지 않는다',()=>{
 const html=render(rows.map((row,index)=>index===0?{...row,operatingAmount:0,installmentAmount:0,total:0,registered:false}:row));
 const body=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.equal((body.match(/>등록 전<\//g)||[]).length,3);
 assert.match(html,/해당 월의 계획이 아직 등록되지 않았다는 뜻/);
 assert.equal((body.match(/cash-series-zero">0/g)||[]).length,3);
});

test('월 선택은 접근 가능한 버튼이고 사업자별 금액을 독립해서 표시한다',()=>{
 const other=rows.map(row=>({...row,businessId:'other',businessName:'다른 합성 사업자',operatingAmount:3000,installmentAmount:0,total:3000,notes:[]}));
 const html=render([...rows,...other]);
 assert.equal((html.match(/<tbody>/g)||[]).length,2);
 assert.equal((html.match(/지출계획표 보기" aria-pressed="true"/g)||[]).length,1);
 assert.match(html,/aria-label="2027년 5월 지출계획표 보기" aria-pressed="true"/);
 assert.match(html,/<input(?=[^>]*type="month")(?=[^>]*aria-label="월별 필요자금 시작월")[^>]*>/);
 assert.match(html,/aria-label="월별 필요자금 이전 달"/);assert.match(html,/aria-label="월별 필요자금 다음 달"/);
 assert.match(html,/role="region" aria-label="사업자별 월 고정비와 부가세 할부 계획표"/);
 const bodies=[...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map(match=>match[1]);
 assert.doesNotMatch(bodies[0],/>3,000</);assert.doesNotMatch(bodies[1],/1,234,000|1,434,000/);
});

test('고정비 내역보기와 등록 전 항목 추가는 월 선택과 별도이고 누락월에는 생성하지 않는다',()=>{
 const html=render();
 assert.equal((html.match(/기본 고정비 내역보기" aria-haspopup="dialog"/g)||[]).length,6);
 assert.equal((html.match(/<small>내역보기 /g)||[]).length,6);
 assert.equal((html.match(/지출계획표 보기" aria-pressed/g)||[]).length,6);
 const before=render([{...rows[0],registered:false},rows[1]]);
 assert.equal((before.match(/기본 고정비 내역보기" aria-haspopup="dialog"/g)||[]).length,1);
 assert.equal((before.match(/기본 고정비 항목 추가" aria-haspopup="dialog"/g)||[]).length,1);
 assert.match(before,/>등록 전<\/span><small>항목 추가/);
});

function detailRow(key:string,overrides:Partial<CashPlanSeriesBreakdownRow>={}):CashPlanSeriesBreakdownRow{
 return {id:key,key,kind:'operating',groupLabel:'합성 분류',title:'합성 품목',originalTitle:'합성 품목',baseAmount:1000,currentAmount:1000,included:true,exclusionReason:null,date:'2027-04-15',nominalDay:15,accountId:'synthetic-account',accountName:'합성 은행 · 합성 통장',memo:'합성 원본 메모',editMemo:null,effectiveMemo:'합성 원본 메모',globalMemo:null,sourceType:'manual',sourceKey:key,month:'2027-04',editId:null,version:0,seriesVersion:0,revisionEffectiveMonth:null,revisionExcludedFrom:null,...overrides};
}
function detailFixture():CashPlanSeriesBreakdown{
 return {businessId:'synthetic',businessName:'합성 사업자',month:'2027-04',registered:true,status:'active',operatingAmount:3000,installmentAmount:4000,total:7000,includedCount:3,excludedCount:2,notes:[],
  includedRows:[detailRow('salary',{groupLabel:'급여',title:'수정한 합성 직원',originalTitle:'원본 합성 직원'}),detailRow('service',{groupLabel:'정기 서비스·구독',title:'합성 구독',originalTitle:'합성 구독',currentAmount:2000,date:null,accountId:null,accountName:''}),detailRow('installment',{kind:'installment',title:'합성 부가세 할부',currentAmount:4000})],
  excludedRows:[detailRow('excluded-month',{title:'합성 월 제외 항목',baseAmount:700,currentAmount:700,included:false,exclusionReason:'이번 달 제외',editMemo:'합성 해지 확인',effectiveMemo:'합성 해지 확인'}),detailRow('excluded-all',{title:'합성 전체 제외 항목',baseAmount:800,currentAmount:800,included:false,exclusionReason:'전체 기간 제외',globalMemo:'합성 반복 중단'})],
  groups:[{key:'salary',label:'급여',amount:1000,count:1},{key:'service',label:'정기 서비스·구독',amount:2000,count:1}],
 };
}
const renderDetails=(breakdown:CashPlanSeriesBreakdown)=>renderToStaticMarkup(createElement(CashPlanSeriesBreakdownDetails,{breakdown}));

test('고정비 팝업은 분류 소계와 품목·대상·계좌·일정을 보여주고 부가세 할부를 합계에 섞지 않는다',()=>{
 const html=renderDetails(detailFixture());
 assert.match(html,/월 고정비 합계<\/dt><dd>3,000<small>원/);
 assert.match(html,/포함<\/dt><dd>2<small>건/);assert.match(html,/제외<\/dt><dd>2<small>건 · 합계에 미포함/);
 assert.match(html,/aria-label="고정비 분류별 소계"/);assert.match(html,/정기 서비스·구독/);
 assert.match(html,/>품목·대상<\/th>/);assert.match(html,/>예정일<\/th>/);assert.match(html,/>출금 계좌<\/th>/);
 assert.match(html,/수정한 합성 직원/);assert.match(html,/원래 품목 원본 합성 직원/);
 assert.match(html,/<time dateTime="2027-04-15">2027-04-15<\/time>/);
 assert.match(html,/합성 은행 · 합성 통장/);assert.match(html,/일정 미정/);assert.match(html,/계좌 미지정/);
 assert.doesNotMatch(html,/합성 부가세 할부|4,000|7,000/);
 assert.match(html,/<details class="cash-series-row-memo"><summary>메모<\/summary>/);
 assert.doesNotMatch(html,/<details[^>]* open/);
});

test('팝업의 제외 항목은 사유와 금액을 별도로 보존하고 포함 표에 재가산하지 않는다',()=>{
 const html=renderDetails(detailFixture()),bodies=[...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map(match=>match[1]);
 assert.equal(bodies.length,2);
 assert.doesNotMatch(bodies[0],/합성 월 제외 항목|합성 전체 제외 항목|>700<|>800</);
 assert.match(bodies[1],/합성 월 제외 항목/);assert.match(bodies[1],/이번 달 제외/);assert.match(bodies[1],/합성 해지 확인/);
 assert.match(bodies[1],/합성 전체 제외 항목/);assert.match(bodies[1],/전체 기간 제외/);assert.match(bodies[1],/합성 반복 중단/);
 assert.match(bodies[1],/>700<\/td>/);assert.match(bodies[1],/>800<\/td>/);
 assert.match(html,/위 합계에 더하지 않습니다/);
 const missing=renderDetails({...detailFixture(),registered:false,status:'before-start',includedRows:[],excludedRows:[],groups:[],operatingAmount:0});
 assert.match(missing,/등록된 고정비 계획이 없습니다/);assert.doesNotMatch(missing,/월 고정비 합계|>0</);
});

test('팝업의 포함 항목은 모델 분류 순서와 분류 내 품목 순서를 따르고 원본 배열을 바꾸지 않는다',()=>{
 const data=detailFixture(),included=[data.includedRows[1],detailRow('salary-b',{groupLabel:'급여',title:'나 합성 직원'}),detailRow('salary-a',{groupLabel:'급여',title:'가 합성 직원'})];
 const before=included.map(row=>row.key),html=renderDetails({...data,includedRows:included});
 const body=html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
 assert.ok(body.indexOf('가 합성 직원')<body.indexOf('나 합성 직원'));
 assert.ok(body.indexOf('나 합성 직원')<body.indexOf('합성 구독'));
 assert.deepEqual(included.map(row=>row.key),before);
});

test('제외 항목은 기본 계획액과 해당 월 수정액이 다르면 두 금액을 구분해 보존한다',()=>{
 const data=detailFixture();data.excludedRows[0]={...data.excludedRows[0],baseAmount:1500,currentAmount:700};
 const html=renderDetails(data),body=[...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)][1][1];
 assert.match(html,/>기본 계획액<\/th>/);
 assert.match(body,/cash-series-detail-money">1,500<small class="cash-series-excluded-month-amount">해당 월 수정액 700<\/small>/);
 assert.match(html,/월 고정비 합계<\/dt><dd>3,000<small>원/);
 assert.equal(data.excludedRows[0].baseAmount,1500);assert.equal(data.excludedRows[0].currentAmount,700);
});

test('팝업 편집 버튼은 포함 고정비에만 보이고 이미 제외된 항목에는 복원·편집 동작이 없다',()=>{
 const html=renderToStaticMarkup(createElement(CashPlanSeriesBreakdownDetails,{breakdown:detailFixture(),onEdit:()=>{},onRemove:()=>{}}));
 const bodies=[...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map(match=>match[1]);
 assert.equal((bodies[0].match(/이 달 고정비 수정"/g)||[]).length,2);
 assert.equal((bodies[0].match(/이 달 고정비 삭제"/g)||[]).length,2);
 assert.doesNotMatch(bodies[1],/<button|복원|이 달 고정비 수정|이 달 고정비 삭제/);
});

const formAccounts:Account[]=[{id:'synthetic-account',business_id:'synthetic',name:'합성 통장',bank:'합성 은행',masked_number:'0001',opening_balance:0,opening_balance_date:'2027-01-01'}];
const formDraft:FixedCostFormDraft={title:'합성 고정비',amount:'1,234',date:'2027-04-21',accountId:'synthetic-account',memo:'합성 메모',groupLabel:'통신'};
const renderForm=(options:{mode?:'add'|'edit';scope?:FixedCostFormScope;allowFollowing?:boolean;nominalDay?:number|null;originalDate?:string|null;pending?:boolean;stale?:boolean;error?:string;draft?:FixedCostFormDraft}={})=>renderToStaticMarkup(createElement(CashPlanFixedCostForm,{draft:options.draft??formDraft,month:'2027-04',mode:options.mode??'edit',scope:options.scope??'month',allowFollowing:options.allowFollowing,nominalDay:options.nominalDay,originalDate:options.originalDate,accounts:formAccounts,pending:options.pending??false,stale:options.stale??false,error:options.error??'',dateInput:{current:null},onChange:()=>{},onScopeChange:()=>{},onSave:()=>{},onCancel:()=>{}}));

test('고정비 수정 폼은 선택한 달과 기존 미래 예정일을 유지하고 금액·계좌·메모를 표시한다',()=>{
 const html=renderForm();
 assert.match(html,/2027-04에만 적용/);
 assert.match(html,/<input(?=[^>]*type="date")(?=[^>]*min="2027-04-01")(?=[^>]*max="2027-04-30")(?=[^>]*value="2027-04-21")[^>]*>/);
 assert.match(html,/value="1,234"/);assert.match(html,/합성 메모/);assert.match(html,/합성 은행 · 합성 통장 · 0001/);
 assert.match(html,/이 달 계획 저장/);
 assert.equal(fixedCostFormError(formDraft,'2027-04',formAccounts),'');
 assert.match(fixedCostFormError({...formDraft,date:'2027-05-01'},'2027-04',formAccounts),/선택한 달/);
 assert.match(fixedCostFormError({...formDraft,accountId:'other-business-account'},'2027-04',formAccounts),/이 사업자/);
 assert.deepEqual(fixedCostFormValues({...formDraft,date:'',accountId:''}),{title:'합성 고정비',amount:1234,date:null,accountId:null,memo:'합성 메모',groupLabel:'통신'});
});

test('추가 폼은 명시 분류 선택을 제공하고 저장 실패·충돌 시 입력을 보존한 채 저장만 차단한다',()=>{
 const added=renderForm({mode:'add'});
 assert.match(added,/고정비 분류<select/);assert.match(added,/기타 고정비/);
 const failed=renderForm({stale:true,error:'합성 저장 실패'});
 assert.match(failed,/value="합성 고정비"/);assert.match(failed,/value="1,234"/);assert.match(failed,/value="2027-04-21"/);
 assert.match(failed,/합성 저장 실패/);assert.match(failed,/입력은 유지했습니다/);
 assert.match(failed,/<button(?=[^>]*type="submit")(?=[^>]*disabled="")[^>]*>/);
 assert.doesNotMatch(failed,/<input[^>]*disabled=/);
 const pending=renderForm({pending:true});
 assert.match(pending,/저장 중…/);assert.match(pending,/<input[^>]*disabled=""/);
 assert.match(pending,/<button(?=[^>]*type="button")(?=[^>]*disabled="")[^>]*>입력 취소/);
});

test('추가·수정 폼은 기본 월 적용과 이후 계속 적용 범위를 명확히 구분한다',()=>{
 const monthly=renderForm();
 assert.match(monthly,/>이번 달만<\/span>/);assert.match(monthly,/>이번 달부터 계속<\/span>/);
 assert.match(monthly,/<input(?=[^>]*type="radio")(?=[^>]*value="month")(?=[^>]*checked="")[^>]*>/);
 const forward=renderForm({mode:'add',scope:'following'});
 assert.match(forward,/<input(?=[^>]*type="radio")(?=[^>]*value="following")(?=[^>]*checked="")[^>]*>/);
 assert.match(forward,/2027-04부터 계속/);assert.match(forward,/이전 달은 바뀌지 않습니다/);
 assert.match(forward,/매월 21일에 적용/);assert.match(forward,/짧은 달은 말일/);
 assert.match(forward,/이 달부터 계속 저장/);
 const undated=renderForm({scope:'following',draft:{...formDraft,date:''}});
 assert.match(undated,/빈 날짜는 날짜 미정 월 예산으로 반복/);
 assert.equal(fixedCostFormValues({...formDraft,date:''}).date,null);
});

test('말일로 보정된 날짜를 그대로 저장하는 반복 계획은 원래 반복 일자를 안내한다',()=>{
 const html=renderForm({scope:'following',nominalDay:31,originalDate:'2027-04-30',draft:{...formDraft,date:'2027-04-30'}});
 assert.match(html,/value="2027-04-30"/);assert.match(html,/매월 31일에 적용/);assert.match(html,/짧은 달은 말일/);
});

test('지출계획표에서 연결한 월 추정은 반복 범위를 비활성화하고 월 적용을 유지한다',()=>{
 const html=renderForm({scope:'following',allowFollowing:false});
 assert.match(html,/지출계획표에서 연결한 항목은 이 달에만 적용합니다/);
 assert.match(html,/<input(?=[^>]*value="following")(?=[^>]*disabled="")[^>]*>/);
 assert.match(html,/<input(?=[^>]*value="month")(?=[^>]*checked="")[^>]*>/);
 assert.match(html,/2027-04에만 적용/);assert.match(html,/이 달 계획 저장/);
 assert.doesNotMatch(html,/이 달부터 계속 저장|매월 21일/);
 const remove=renderToStaticMarkup(createElement(CashPlanFixedCostScope,{scope:'following',month:'2027-04',pending:false,removing:true,allowFollowing:false,onChange:()=>{}}));
 assert.match(remove,/<input(?=[^>]*value="following")(?=[^>]*disabled="")[^>]*>/);
 assert.match(remove,/지출계획표에서 연결한 항목은 이 달에만 적용합니다/);
});

test('삭제 확인의 범위 선택도 선택 월부터 계속 제외임을 알리고 저장 중에는 변경하지 못한다',()=>{
 const html=renderToStaticMarkup(createElement(CashPlanFixedCostScope,{scope:'following',month:'2027-04',pending:true,removing:true,onChange:()=>{}}));
 assert.match(html,/<fieldset[^>]*disabled=""/);
 assert.match(html,/2027년 4월 기준/);assert.match(html,/선택한 2027-04부터 이후에도 계속 제외합니다/);
 assert.match(html,/이전 달은 바뀌지 않습니다/);
});

test('계속 제외한 고정비는 시작월을 표시하고 향후에도 복원·편집 버튼을 제공하지 않는다',()=>{
 const data=detailFixture();data.excludedRows[0]={...data.excludedRows[0],seriesVersion:3,revisionEffectiveMonth:'2027-03',revisionExcludedFrom:'2027-03',exclusionReason:'이 달부터 계속 제외'};
 const html=renderToStaticMarkup(createElement(CashPlanSeriesBreakdownDetails,{breakdown:data,onEdit:()=>{},onRemove:()=>{}}));
 const excluded=[...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)][1][1];
 assert.match(excluded,/2027년 3월부터 계속 제외/);assert.doesNotMatch(excluded,/<button|복원/);
 assert.match(html,/월 고정비 합계<\/dt><dd>3,000<small>원/);
});

test('계획을 등록하지 않은 모든 사업자도 월별 항목 추가로 시작할 수 있고 0원 실적으로 보이지 않는다',()=>{
 const data={...structuredClone(emptyDataset),businesses:Array.from({length:4},(_,index)=>({id:`synthetic-${index+1}`,name:`합성 사업자 ${index+1}`,representative:'',kind:'법인',reserve:0,color:'#123456'}))};
 const html=render(buildCashPlanSeriesMonthly(data,[],'2027-04',6));
 assert.equal((html.match(/<tbody>/g)||[]).length,4);
 assert.equal((html.match(/기본 고정비 항목 추가" aria-haspopup="dialog"/g)||[]).length,24);
 assert.equal((html.match(/>등록 전<\//g)||[]).length,72);
 assert.doesNotMatch(html,/cash-series-zero">0|>확인 필요<\/td>/);
 for(const business of data.businesses)assert.ok(html.includes(business.name));
 assert.match(html,/카드대금도 내역보기에서 직접 입력/);
});

test('카드대금 입력은 명시 분류와 월 한정 기본 범위로 사용자 청구 금액을 입력받는다',()=>{
 const html=renderForm({mode:'add',draft:{...formDraft,title:'합성 카드 결제대금',groupLabel:'카드대금'}});
 assert.match(html,/aria-label="이 달 카드대금 입력"/);assert.match(html,/청구 금액 \(원\)/);
 assert.match(html,/<option value="카드대금" selected="">카드대금<\/option>/);
 assert.match(html,/카드사 청구서의 결제 예정 금액과 결제일을 직접 입력/);
 assert.match(html,/기존 카드 청구·구독·할부 계획에 포함된 금액인지 확인/);
 assert.match(html,/<input(?=[^>]*type="radio")(?=[^>]*value="month")(?=[^>]*checked="")[^>]*>/);
 assert.doesNotMatch(html,/clobe-card-bill|자동으로 청구/);
});
