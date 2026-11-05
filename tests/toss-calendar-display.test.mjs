import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {register} from 'tsx/cjs/api';

const require=createRequire(import.meta.url);
const previousCssLoader=require.extensions['.css'];
const unregister=register();
let FundingTimeline,tossCalendarIncome,tossFundingIncome,buildFundingTimeline;
try{
 // Ignore styles only. The real calendar, JSX and dialog implementations load
 // unchanged, and the temporary CSS/TypeScript hooks are restored immediately.
 require.extensions['.css']=()=>{};
 ({FundingTimeline}=require('../components/finance/funding-timeline.tsx'));
 ({tossCalendarIncome,tossFundingIncome}=require('../lib/finance/toss-funding.ts'));
 ({buildFundingTimeline}=require('../lib/finance/funding-timeline.ts'));
}finally{
 unregister();
 if(previousCssLoader)require.extensions['.css']=previousCssLoader;
 else delete require.extensions['.css'];
}

const range={from:'2026-11-01',to:'2026-11-30'},due='2026-11-03';
const business=(id,name)=>({id,name,representative:'',kind:'법인',reserve:0,color:'#3267c8'});
const one=business('synthetic-one','합성 정산전용사업자'),two=business('synthetic-two','합성 별도사업자');
const account=owner=>({id:`${owner.id}-account`,business_id:owner.id,name:`${owner.name} 통장`,bank:'합성은행',masked_number:'합성번호',opening_balance:0,opening_balance_date:range.from});
const group=(changes={})=>({id:'synthetic-receipt',businessId:one.id,accountId:account(one).id,date:due,merchantIds:['synthetic-merchant'],amount:12345,receivedAmount:0,pendingAmount:12345,status:'pending',matchedTransactionIds:[],reason:null,...changes});
const funding=(owner,groups,asOf,items=[])=>{
 const expenses=items.reduce((sum,item)=>sum+item.amount,0);
 return {business:owner,accounts:[{account:account(owner),snapshot:{balance:0,date:asOf,source:'statement',transactionId:null,message:'합성'},expenses,datedExpenses:expenses,undatedExpenses:0,afterExpenses:-expenses,requiredTopUp:expenses,items,calculationStatus:'estimated',firstDatedShortfall:null,scheduledIncome:tossFundingIncome(groups,range,asOf).filter(row=>row.businessId===owner.id)}],expenses,requiredTopUp:expenses,knownRequiredTopUp:expenses,unknownAccountCount:0,unassignedExpenses:0,unassignedItems:[]};
};
const render=(groups,asOf,options={})=>renderToStaticMarkup(createElement(FundingTimeline,{
 businesses:[funding(one,groups,asOf,options.items??[]),funding(two,groups,asOf)],range,asOf,
 accountId:options.accountId??'all',focusDate:options.focusDate??'',
 calendarIncome:options.omit?undefined:options.empty?[]:tossCalendarIncome(groups,range,asOf),
}));
const cell=(html,date=due)=>{
 const result=html.match(new RegExp(`<button[^>]*aria-label="${date}[^>]*>[\\s\\S]*?<\\/button>`))?.[0];
 assert.ok(result,`${date} 달력 날짜가 있어야 합니다.`);
 return result;
};
const list=html=>html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]??'';
const kpiValues=html=>{
 const section=html.match(/<div class="funding-timeline-kpis"[\s\S]*?<details class="funding-timeline-calculation-note"/)?.[0];
 assert.ok(section,'추가 필요자금 KPI가 있어야 합니다.');
 return [...section.matchAll(/<strong[^>]*>([^<]*)<\/strong>/g)].map(match=>match[1]);
};

test('같은 정산은 지급일 전날·당일·다음날에도 원래 날짜와 지출 0 사업자를 유지한다',()=>{
 const future=cell(render([group()],'2026-11-02'));
 const today=cell(render([group()],'2026-11-03'));
 const past=cell(render([group()],'2026-11-04'));
 assert.match(future,/입금 예정/);assert.match(future,/\+12,345/);
 assert.match(today,/오늘 입금 확인 필요/);assert.match(today,/정산액/);
 assert.match(past,/지급일 경과 · 입금 확인 필요/);
 for(const value of [future,today,past]){
  assert.match(value,/합성 정산전용사업자/);
  assert.match(value,/funding-timeline-zero">0/);
  assert.match(value,/funding-timeline-income-line positive/);
  assert.doesNotMatch(value,/disabled/);
 }
 assert.doesNotMatch(today,/\+12,345/);
 assert.doesNotMatch(past,/입금 예정/);
});

test('지출 없는 정산 사업자는 날짜 목록과 선택일 요약에도 표시한다',()=>{
 const html=render([group()],'2026-11-03',{focusDate:due});
 assert.match(list(html),/합성 정산전용사업자/);
 assert.match(list(html),/오늘 입금 확인 필요/);
 assert.match(html,/11월 3일 토스 정산 입금 상태/);
 assert.match(html,/사업자·계좌·확인 근거 보기/);
});

test('통장 입금 확인 후 예정 대신 완료를 표시하고 미래 자금에 다시 더하지 않는다',()=>{
 const received=group({status:'received',receivedAmount:12345,pendingAmount:0,matchedTransactionIds:['synthetic-bank-in']});
 const day=cell(render([received],'2026-11-03'));
 assert.match(day,/입금 완료/);assert.match(day,/\+12,345/);
 assert.doesNotMatch(day,/오늘 입금 확인 필요|입금 예정/);
 assert.equal(tossFundingIncome([received],range,'2026-11-03').length,0);
});

test('부분 입금은 원정산액과 차액 확인 상태를 유지하고 별도 현금처럼 중복 표시하지 않는다',()=>{
 const partial=group({status:'confirmation-needed',receivedAmount:4000,pendingAmount:0,matchedTransactionIds:['synthetic-partial']});
 const day=cell(render([partial],'2026-11-03'));
 assert.match(day,/부분 입금 · 차액 확인/);assert.match(day,/정산액/);assert.match(day,/12,345/);
 assert.doesNotMatch(day,/\+12,345|\+4,000|\+8,345/);
});

test('충돌·0원·음수 정산도 숨기지 않고 가산 입금으로 표시하지 않는다',()=>{
 const conflict=cell(render([group(),group({amount:13345,pendingAmount:13345})],'2026-11-03'));
 assert.match(conflict,/정산 자료 확인 필요/);assert.doesNotMatch(conflict,/\+12,345|\+13,345/);
 const zero=cell(render([group({amount:0,pendingAmount:0})],'2026-11-03'));
 assert.match(zero,/정산액 0/);assert.doesNotMatch(zero,/\+0|income-line positive/);
 const adjustment=cell(render([group({amount:-700,pendingAmount:0})],'2026-11-03'));
 assert.match(adjustment,/정산 차감액 확인/);assert.match(adjustment,/income-line negative/);assert.match(adjustment,/-700/);
 assert.doesNotMatch(adjustment,/\+-/);
});

test('단일 계좌 필터와 명시적 빈 정산 목록을 지키고 미전달 시 기존 미래 예정만 유지한다',()=>{
 const otherAccount=cell(render([group()],'2026-11-03',{accountId:account(two).id}));
 assert.doesNotMatch(otherAccount,/합성 정산전용사업자|오늘 입금 확인 필요/);
 assert.doesNotMatch(cell(render([group()],'2026-11-02',{empty:true})),/입금 예정|12,345/);
 assert.match(cell(render([group()],'2026-11-02',{omit:true})),/입금 예정/);
});

test('당일 정산 표시 유무는 필요자금 KPI를 바꾸지 않고 미래 정산 계산도 보존한다',()=>{
 const items=[{key:'synthetic-budget',date:due,title:'합성 예정지출',amount:20000,note:'합성'}];
 const visible=render([group()],'2026-11-03',{focusDate:due,items});
 const hidden=render([group()],'2026-11-03',{focusDate:due,items,empty:true});
 assert.deepEqual(kpiValues(visible),['20,000원','20,000원']);
 assert.deepEqual(kpiValues(hidden),kpiValues(visible));
 const before=buildFundingTimeline([funding(one,[group()],'2026-11-02',items)],range,'2026-11-02').days.find(row=>row.date===due);
 assert.equal(before.additionalTopUp,7655);
});
