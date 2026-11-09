import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {register} from 'tsx/cjs/api';

const require=createRequire(import.meta.url),previousCssLoader=require.extensions['.css'];
const unregister=register();
let FinancialVisibilityContext,FINANCIAL_MASK,financialDisplayValue,redactFinancialText;
let CashPlanWorksheet,CashAccountBalances,CashPlanSeriesSummary,CashPlanSeriesBreakdownDetails,CashPlanFixedCostForm,PaymentConfirmationFields,FundingTimeline,AccountFundingPanel,CalendarExpenseItems;
let emptyDataset,buildEditableCashPlan,buildCashPlanWorksheetModel,buildLatestCashBalances,buildAccountFunding,buildCashCalendarModel;
try{
 require.extensions['.css']=()=>{};
 ({FinancialVisibilityContext}=require('../components/finance/financial-visibility.tsx'));
 ({FINANCIAL_MASK,financialDisplayValue,redactFinancialText}=require('../lib/finance/financial-visibility.ts'));
 ({CashPlanWorksheet}=require('../components/finance/cash-plan-worksheet.tsx'));
 ({CashAccountBalances}=require('../components/finance/cash-account-balances.tsx'));
 ({CashPlanSeriesSummary}=require('../components/finance/cash-plan-series-summary.tsx'));
 ({CashPlanSeriesBreakdownDetails}=require('../components/finance/cash-plan-series-breakdown.tsx'));
 ({CashPlanFixedCostForm}=require('../components/finance/cash-plan-fixed-cost-form.tsx'));
 ({PaymentConfirmationFields}=require('../components/finance/payment-confirmation-fields.tsx'));
 ({FundingTimeline,CalendarExpenseItems}=require('../components/finance/funding-timeline.tsx'));
 ({AccountFundingPanel}=require('../components/finance/account-funding.tsx'));
 ({emptyDataset}=require('../lib/finance/types.ts'));
 ({buildEditableCashPlan}=require('../lib/finance/editable-cash-plan.ts'));
 ({buildCashPlanWorksheetModel}=require('../lib/finance/cash-plan-worksheet-model.ts'));
 ({buildLatestCashBalances}=require('../lib/finance/latest-cash-balances.ts'));
 ({buildAccountFunding}=require('../lib/finance/account-funding.ts'));
 ({buildCashCalendarModel}=require('../lib/finance/cash-calendar.ts'));
}finally{
 unregister();
 if(previousCssLoader)require.extensions['.css']=previousCssLoader;
 else delete require.extensions['.css'];
}

const range={from:'2026-11-01',to:'2026-11-30'},asOf='2026-11-06';
const business={id:'synthetic-business',name:'합성 사업자',representative:'',kind:'법인',reserve:24680,color:'#3267c8'};
const account={id:'synthetic-account',business_id:business.id,name:'합성 운영통장',bank:'합성은행',masked_number:'123-4567-890123',opening_balance:-654321,opening_balance_date:'2026-10-31'};
const data={...emptyDataset,businesses:[business],accounts:[account],
 categories:[{id:'synthetic-fee',name:'합성 비용',group_name:'영업지출',is_internal:false,is_operating:true}],
 transactions:[{id:'synthetic-outflow',business_id:business.id,account_id:account.id,txn_date:'2026-11-04',amount:87653,direction:'out',balance:-741974,description:'합성 실제 품목 97,531원',raw_gwamok:'',category_id:'synthetic-fee',upload_id:null,is_internal:false,tax_invoice:false,dedup_hash:'synthetic-outflow',manually_classified:false}],
 recurring:[{id:'synthetic-recurring',business_id:business.id,title:'합성 임차료',amount:123457,direction:'out',day:10,start_date:range.from,end_date:null,frequency:'monthly',account_id:account.id,memo:'합성 메모 64,321원'}],
};
const edited=buildEditableCashPlan(data,range,asOf,[]);
const worksheet=buildCashPlanWorksheetModel({data,editable:edited,basis:'registered',range,asOf});
const latest=buildLatestCashBalances(data,asOf);
const funding=buildAccountFunding(edited.plan.businesses,new Map(),'registered');
const cashCalendar=buildCashCalendarModel({data,items:edited.items,funding,range,asOf,basis:'registered'});
const context=visible=>({amountsVisible:visible,preferenceReady:true,toggleAmountsVisible:()=>{},privateValue:value=>financialDisplayValue(value,visible),privateText:text=>visible?text:redactFinancialText(text)});
const render=(component,props,visible)=>renderToStaticMarkup(createElement(FinancialVisibilityContext.Provider,{value:context(visible)},createElement(component,props)));
const worksheetProps={plans:edited.plan.businesses,estimates:new Map(),worksheetBusinesses:new Map(worksheet.businesses.map(row=>[row.businessId,row])),latestBalances:new Map(latest.businesses.map(row=>[row.business.id,row])),basis:'registered',selectedBusiness:'',onOpenDetail:()=>{},onEditBusiness:()=>{},onConfirmPayment:()=>{}};
const withoutAmounts=html=>assert.doesNotMatch(html,/741,974|654,321|123,457|87,653|97,531|64,321|24,680|123-4567-890123/);

test('OFF masks worksheet balances, actual and planned amounts, description titles and notes without mutating models',()=>{
 const before=JSON.stringify({data,edited,worksheet,latest}),on=render(CashPlanWorksheet,worksheetProps,true),off=render(CashPlanWorksheet,worksheetProps,false);
 assert.match(on,/-741,974/);assert.match(on,/123,457/);assert.match(on,/title="합성 실제 품목 97,531원"/);
 withoutAmounts(off);assert.match(off,/data-financial-masked="true"/);
 assert.match(off,/합성 사업자/);assert.match(off,/합성 운영통장/);assert.match(off,/합성 실제 품목/);
 assert.match(off,/dateTime="2026-11-04"/);assert.match(off,/dateTime="2026-11-10"/);
 assert.match(off,/실제 출금/);assert.match(off,/확인 필요/);
 assert.equal(JSON.stringify({data,edited,worksheet,latest}),before);
 assert.equal(render(CashPlanWorksheet,worksheetProps,true),on);
});

test('OFF masks zero and negative account balances while retaining account names and recorded dates',()=>{
 const fixture={...latest.businesses[0],accounts:[{account,snapshot:{balance:-654321,date:asOf,source:'statement',transactionId:null,message:'합성 잔액'}},{account:{...account,id:'synthetic-zero',name:'합성 영점통장'},snapshot:{balance:0,date:asOf,source:'statement',transactionId:null,message:'합성 잔액'}}]};
 const on=render(CashAccountBalances,{business:fixture},true),off=render(CashAccountBalances,{business:fixture},false);
 assert.match(on,/-654,321/);assert.match(on,/>0<\/b>/);
 withoutAmounts(off);assert.doesNotMatch(off,/>0<\/b>/);assert.equal((off.match(/data-financial-masked="true"/g)||[]).length,2);
 assert.match(off,/합성 영점통장/);assert.match(off,/2026-11-06 거래 기록 기준/);
});

test('OFF masks monthly zero budgets and monetary memo tokens while keeping months and item counts',()=>{
 const props={rows:[{businessId:business.id,businessName:business.name,month:'2026-11',operatingAmount:123457,installmentAmount:0,total:123457,notes:['2건 검토 · 합성 조정 64,321원 · 2026-11-10']}],fromMonth:'2026-11',selectedMonth:'2026-11',onMonthChange:()=>{},onSelectMonth:()=>{},onOpenBreakdown:()=>{}};
 const on=render(CashPlanSeriesSummary,props,true),off=render(CashPlanSeriesSummary,props,false);
 assert.match(on,/cash-series-zero">0<\/td>/);assert.match(on,/64,321원/);
 withoutAmounts(off);assert.doesNotMatch(off,/cash-series-zero">0<\/td>/);
 assert.match(off,/2건 검토/);assert.match(off,/2026-11-10/);assert.match(off,/2026년 11월/);
 const unregistered=render(CashPlanSeriesSummary,{...props,rows:props.rows.map(row=>({...row,registered:false}))},false);assert.match(unregistered,/>등록 전</);assert.match(unregistered,/>확인 필요</);
});

const seriesRow={id:'synthetic-series',key:'synthetic-series',kind:'operating',groupLabel:'임차료',title:'합성 임차료 345,678원',originalTitle:'합성 임차료 345,678원',baseAmount:345678,currentAmount:345678,included:true,exclusionReason:null,date:'2026-11-10',nominalDay:10,accountId:account.id,accountName:account.name,memo:'2건 확인 · 합성 고정비 234,567원',editMemo:null,effectiveMemo:'2건 확인 · 합성 고정비 234,567원',globalMemo:null,sourceType:'manual',sourceKey:'synthetic-series',month:'2026-11',editId:null,version:0,seriesVersion:0,revisionEffectiveMonth:null,revisionExcludedFrom:null};
test('OFF masks detailed budgets and money inside edit-button accessible labels and plan memos',()=>{
 const breakdown={businessId:business.id,businessName:business.name,month:'2026-11',registered:true,status:'active',operatingAmount:345678,installmentAmount:0,total:345678,includedCount:1,excludedCount:0,notes:[],includedRows:[seriesRow],excludedRows:[],groups:[{key:'synthetic-rent',label:'임차료',amount:345678,count:1}]};
 const props={breakdown,onEdit:()=>{},onRemove:()=>{}},on=render(CashPlanSeriesBreakdownDetails,props,true),off=render(CashPlanSeriesBreakdownDetails,props,false);
 assert.match(on,/aria-label="합성 임차료 345,678원 이 달 고정비 수정"/);
 assert.doesNotMatch(off,/345,678|234,567/);assert.match(off,/aria-label="합성 임차료 •••••• 이 달 고정비 수정"/);
 assert.match(off,/2건 확인/);assert.match(off,/2026-11-10/);assert.match(off,/합성 운영통장/);
});

test('OFF monetary form controls and monetary memo/title tokens never emit raw draft values and ON restores them',()=>{
 const draft={title:'합성 품목 345,678원',amount:'7123456',date:'2026-11-10',accountId:account.id,memo:'2건 · 합성 청구 234,567원',groupLabel:'카드대금'};
 const props={draft,month:'2026-11',mode:'edit',scope:'month',accounts:[account],pending:false,stale:false,error:'',dateInput:{current:null},onChange:()=>{},onScopeChange:()=>{},onSave:()=>{},onCancel:()=>{}};
 const before=JSON.stringify(draft),on=render(CashPlanFixedCostForm,props,true),off=render(CashPlanFixedCostForm,props,false);
 assert.match(on,/value="7123456"/);assert.match(on,/345,678원/);assert.match(on,/234,567원/);
 assert.doesNotMatch(off,/7123456|345,678|234,567|123-4567-890123/);assert.match(on,/123-4567-890123/);assert.match(off,/value="••••••"/);assert.match(off,/readOnly=""/);
 assert.match(off,/type="date"[^>]*value="2026-11-10"/);assert.match(off,/2건/);assert.equal(JSON.stringify(draft),before);
 assert.equal(render(CashPlanFixedCostForm,props,true),on);
 const confirmation={mode:'actual',draft:{amount:'7123456',date:'2026-11-04',memo:draft.memo,complete:false},pending:false,month:range,lastActualDate:asOf,suggestedDate:false,dateInput:{current:null},onChange:()=>{}};
 const confirmed=render(PaymentConfirmationFields,confirmation,false);
 assert.doesNotMatch(confirmed,/7123456|234,567/);assert.match(confirmed,/id="payment-confirmation-amount"[^>]*readOnly=""/);assert.match(confirmed,/value="2026-11-04"/);
});

test('OFF calendar masks amount geometry text, daily accessible labels, notes, financial zero and settlement adjustments',()=>{
 const receipts=[{key:'synthetic-settlement',businessId:business.id,accountId:account.id,date:'2026-11-10',title:'합성 정산',amount:-543219,status:'confirmation-needed',label:'합성 차액 확인',receivedAmount:0,pendingAmount:0,differenceAmount:-543219,reason:'2건 확인 · 원정산 32,167원',merchantIds:[],matchedTransactionIds:[],noCash:true}];
 const props={businesses:funding,accountId:'all',range,asOf,focusDate:'2026-11-10',cashCalendar,calendarIncome:receipts};
 const before=JSON.stringify({funding,cashCalendar,receipts}),on=render(FundingTimeline,props,true),off=render(FundingTimeline,props,false);
 assert.match(on,/-543,219/);assert.match(on,/32,167원/);assert.match(on,/aria-label="2026-11-10[^\"]*123,457원/);
 withoutAmounts(off);assert.doesNotMatch(off,/543,219|32,167|funding-timeline-zero">0/);
 const label=off.match(/aria-label="2026-11-10[^\"]*"/)?.[0];assert.ok(label);assert.match(label,/예정 ••••••/);assert.match(label,/합성 차액 확인/);
 assert.match(off,/2026년 11월/);assert.match(off,/합성 사업자/);assert.match(off,/2건 확인/);
 assert.equal(JSON.stringify({funding,cashCalendar,receipts}),before);assert.equal(render(FundingTimeline,props,true),on);
});

test('forecast chart and simulator money input use privacy boundaries without replacing the date control',()=>{
 const source=readFileSync(new URL('../components/finance/cash.tsx',import.meta.url),'utf8');
 assert.match(source,/<FinancialChart><div className="chart-box"><ResponsiveContainer[\s\S]*?<LineChart[\s\S]*?<YAxis[\s\S]*?<Tooltip[\s\S]*?<\/ResponsiveContainer><\/div><\/FinancialChart>/);
 assert.match(source,/<FinancialInput id="simulation-amount"/);assert.match(source,/<Input id="simulation-date" type="date"/);
 assert.equal(FINANCIAL_MASK,'••••••');
});


test('OFF account funding keeps business/date controls and scrubs recorded balance-source messages',()=>{
 const current={...latest.businesses[0],accounts:latest.businesses[0].accounts.map(row=>({...row,snapshot:{...row.snapshot,source:'clobe',message:'3건 대조 · 수집 차액 555,555원'}}))};
 const props={plans:edited.plan.businesses,estimates:new Map(),latestBalances:new Map([[business.id,current]]),basis:'registered',range,asOf,focusDate:'2026-11-10',data,planItems:edited.items};
 const on=render(AccountFundingPanel,props,true),off=render(AccountFundingPanel,props,false);
 assert.match(on,/555,555원/);assert.match(on,/-741,974/);assert.match(on,/123-4567-890123/);withoutAmounts(off);assert.doesNotMatch(off,/555,555/);
 const accountTab=off.match(/<button[^>]*role="tab"[^>]*>[\s\S]*?합성 운영통장[\s\S]*?<\/button>/)?.[0];assert.ok(accountTab);assert.doesNotMatch(accountTab,/123-4567-890123/);assert.match(accountTab,/합성은행/);
 assert.match(off,/3건 대조/);assert.match(off,/합성 사업자/);assert.match(off,/2026-11-10/);
});

test('OFF calendar scrubs real generated manual-confirmation notes while preserving confirmation state',()=>{
 const edits=[{id:'synthetic-manual-confirmation',business_id:business.id,source_type:'manual',source_key:'synthetic-manual-confirmation',month:'2026-11',title:'합성 확인 항목',account_id:account.id,plan_date:'2026-11-10',amount:444444,memo:'합성 확인',excluded:false,version:1,updated_at:'2026-11-06T00:00:00Z',confirmed_amount:333333,confirmed_date:'2026-11-04',confirmation_complete:false,confirmation_memo:'2건 확인 · 차액 22,222원'}];
 const editable=buildEditableCashPlan(data,range,asOf,edits),businesses=buildAccountFunding(editable.plan.businesses,new Map(),'registered');
 const calendar=buildCashCalendarModel({data,items:editable.items,funding:businesses,range,asOf,basis:'registered'});
 // Render the real detail section directly: browser dialog portals intentionally
 // do not emit their children during static server rendering.
 const props={businesses,kind:'confirmed',items:calendar.days.flatMap(day=>day.items)};
 const before=JSON.stringify({edits,editable,calendar}),on=render(CalendarExpenseItems,props,true),off=render(CalendarExpenseItems,props,false);
 assert.match(on,/사용자 누적 출금 확인 333,333원/);assert.match(on,/22,222원/);assert.doesNotMatch(off,/333,333|444,444|22,222|123-4567-890123/);assert.match(on,/123-4567-890123/);
 assert.match(off,/사용자 누적 출금 확인/);assert.match(off,/일부 출금 확인/);assert.match(off,/2건 확인/);assert.equal(JSON.stringify({edits,editable,calendar}),before);
});
