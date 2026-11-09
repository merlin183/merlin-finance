import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import Module from 'node:module';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {register} from 'tsx/cjs/api';

const require=createRequire(import.meta.url),React=require('react');
const previousCssLoader=require.extensions['.css'],originalLoad=Module._load;
const passthrough=({children})=>h('div',null,children);
// Only replace browser-only navigation and the modal portal shell. Every owned
// renderer, form field, formatter, aggregate and privacy component is real.
const dialog={Dialog:({open,children})=>open?h('div',null,children):null,DialogContent:({children})=>h('div',{role:'dialog'},children),DialogHeader:passthrough,DialogFooter:passthrough,DialogTitle:({children})=>h('h2',null,children),DialogDescription:({children})=>h('p',null,children),DialogClose:({children})=>children,DialogTrigger:({children})=>children};
const unregister=require.extensions['.tsx']?()=>{}:register();
let views,privacy,model,createClassificationQueue,createMerchantNoteStore;
try{
 require.extensions['.css']=()=>{};
 Module._load=function(request,parent,isMain){
  if(request.includes('components/ui/dialog'))return dialog;
  if(request==='next/navigation')return {useSearchParams:()=>new URLSearchParams(),usePathname:()=>'/transactions',useRouter:()=>({push:()=>{},replace:()=>{},refresh:()=>{}})};
  return originalLoad.call(this,request,parent,isMain);
 };
 privacy=require('../components/finance/financial-visibility.tsx');
 model=require('../lib/finance/financial-visibility.ts');
 views=Object.assign({},...['dashboard','operating-summary','spending-analysis','account-balances','monthly-report','intercompany-pair-flow','intercompany-register','transactions','transaction-calendar','classification-review','upload','clobe-card-bills-panel','clobe-dashboard-sync-summary','clobe-import-panel','clobe-panel','google-sheet-import','sheet-sync-status','tax-payment-alert','toss-settlements-panel','transaction-transfer-fee-display','transaction-transfer-fee','settings','administrators'].map(name=>require(`../components/finance/${name}.tsx`)));
 ({createClassificationQueue}=require('../lib/finance/classification-queue.ts'));
 ({createMerchantNoteStore}=require('../lib/finance/merchant-note-store.ts'));
}finally{
 Module._load=originalLoad;unregister();
 if(previousCssLoader)require.extensions['.css']=previousCssLoader;else delete require.extensions['.css'];
}

const from='2026-11-01',asOf='2026-11-30',range={from,to:asOf},refresh=async()=>{};
const business=(id,name)=>({id,name,representative:'합성 대표',kind:'법인',reserve:456789,color:'#3267c8'});
const businesses=[business('b1','합성 사업자 A'),business('b2','합성 사업자 B')];
const account=(id,business_id)=>({id,business_id,name:'합성 통장 123456789012',bank:'합성은행',masked_number:'012',opening_balance:765431,opening_balance_date:from});
const category=(id,name,extra={})=>({id,name,group_name:'합성 분류',is_operating:true,is_internal:false,...extra});
const row=(id,extra={})=>({id,business_id:'b1',account_id:'a1',upload_id:null,txn_date:'2026-11-06',txn_time:'12:34',amount:123457,direction:'out',description:'합성 서비스 87,231원',raw_gwamok:'급여',category_id:'payroll',is_internal:false,balance:null,tax_invoice:false,dedup_hash:id,manually_classified:false,source_details:{memo:'확인 54,321원 계좌 987654321098',counterparty:'합성 거래처',detail:'분할 31.7% · 2026-11-06',provenance:{sheet:'합성 통장 64,321원',row:2}},...extra});
const data={notes:[],businesses,accounts:[account('a1','b1'),account('a2','b2')],categories:[category('sales','매출'),category('payroll','급여',{is_fixed:true}),category('fees','지급수수료'),category('internal','계좌간이체',{is_internal:true})],rules:[],aliases:[],recurring:[{id:'r1',business_id:'b1',title:'합성 계획 76,543원',amount:234569,direction:'out',day:20,start_date:from,end_date:null,frequency:'monthly'}],transactions:[row('expense'),row('income',{amount:987653,direction:'in',description:'합성 매출',category_id:'sales'}),row('transfer-out',{amount:333337,category_id:'internal',is_internal:true}),row('transfer-in',{business_id:'b2',account_id:'a2',amount:333337,direction:'in',category_id:'internal',is_internal:true})],uploads:[{id:'u1',account_id:'a1',filename:'합성 업로드 67,891원.xlsx',storage_path:'synthetic',success_count:4,duplicate_count:0,error_count:1,created_at:'2026-11-06T01:00:00Z',errors:[{row:3,message:'확인 65,437원'}]}],links:[{id:'link',out_transaction_id:'transfer-out',in_transaction_id:'transfer-in'}],audit:[{id:'audit',action:'합성 수정',detail:'예산 98,765원',created_at:'2026-11-06T01:00:00Z'}]};
const before=JSON.stringify(data);
function render(Component,props,visible,forced={}){
 const value={amountsVisible:visible,preferenceReady:true,toggleAmountsVisible:()=>{},privateValue:v=>model.financialDisplayValue(v,visible),privateText:t=>visible?t:model.redactFinancialText(t)};
 function Harness(){
  const previous=React.useState;let index=0;
  React.useState=initial=>{const position=index++;return previous(Object.hasOwn(forced,position)?forced[position]:initial);};
  try{return Component(props);}finally{React.useState=previous;}
 }
 return renderToStaticMarkup(h(privacy.FinancialVisibilityContext.Provider,{value},h(Harness)));
}
 function privateHtml(html,values=['123,457','987,653','87,231','54,321','64,321','31.7%','123456789012','987654321098']){
 assert.match(html,/••••••/);
 for(const value of values)assert.ok(!html.includes(value),`비공개 화면에 ${value}가 없어야 합니다.`);
 assert.equal(JSON.stringify(data),before,'표시 전환은 금융 원본을 바꾸지 않습니다.');
}
const editState={edits:[],loading:false,saving:false,error:'',save:refresh,refresh};

test('자금 현황·통합분석은 합계와 차트 원문을 숨기고 사업자·날짜를 유지한다',()=>{
 for(const consolidated of [false,true]){
  const props={data,tx:data.transactions,biz:'all',asOf,from,consolidated,refresh};
  const off=render(views.Dashboard,props,false),on=render(views.Dashboard,props,true);
  privateHtml(off);assert.match(off,/합성 사업자 A/);assert.match(off,/2026-11-30/);
  assert.doesNotMatch(off,/recharts|bar-track|color-mix/);
  assert.match(on,/987,653/);assert.match(on,/123,457/);
 }
});

test('통장별 잔액과 영업·내부이동 누계는 동일한 자료를 마스킹한다',()=>{
 const components=[[views.AccountBalances,{data,businesses,accounts:data.accounts,rows:data.transactions,asOf}],[views.OperatingSummary,{data,tx:data.transactions}],[views.TransferPositions,{data,links:[{out:data.transactions[2],incoming:data.transactions[3]}]}]];
 for(const [Component,props] of components){const off=render(Component,props,false);privateHtml(off,['123,457','987,653','333,337','123456789012']);assert.match(off,/합성 사업자 A/);}
 assert.match(render(views.AccountBalances,components[0][1],true),/765,431|1,296,290/);
});

test('자금 사용표의 금액·백분율·색상 강도와 계획 제목의 금액을 숨긴다',()=>{
 const props={data,tx:data.transactions,businesses,from,to:asOf,refresh};
 const off=render(views.SpendingAnalysis,props,false),on=render(views.SpendingAnalysis,props,true);
 privateHtml(off,['123,457','234,569','76,543','100.0%']);
 assert.doesNotMatch(off,/color-mix|\d+\.\d%/);assert.match(off,/급여/);assert.match(off,/2026-11-01/);assert.match(on,/100\.0/);
});

test('월간 보고의 클릭 금액·ARIA·0·업종비교 비율을 함께 숨긴다',()=>{
 const props={data,biz:'all',asOf,editState};
 const off=render(views.MonthlyReportView,props,false),on=render(views.MonthlyReportView,props,true);
 privateHtml(off);assert.doesNotMatch(off,/aria-label="[^"]*\d[\d,]*원 근거 보기|\d+\.\d%|monthly-report-zero">0/);
 assert.match(off,/합성 사업자 A/);assert.match(off,/2026-11/);assert.match(on,/987,653원 근거 보기/);
});

test('거래 표는 원본 내역·계좌·수수료를 숨기고 내보내기만 잠근다',()=>{
 const props={data,tx:data.transactions,biz:'all',refresh,range};
 const off=render(views.Transactions,props,false),on=render(views.Transactions,props,true);
 privateHtml(off);assert.match(off,/2026-11-06/);assert.match(off,/합성 거래처/);
 assert.match(off,/<button[^>]*disabled=""[^>]*title="금액 표시를 켜면 내보낼 수 있습니다"/);assert.match(on,/87,231원/);
 const transaction=row('fee',{category_id:'internal',is_internal:true,transfer_fee_amount:503,transfer_fee_category_id:'fees'});
 privateHtml(render(views.TransferFeeBreakdown,{data,transaction},false),['122,954','503']);
});

test('거래 달력은 모든 금액과 title·ARIA를 숨기며 날짜·건수·월 입력을 보존한다',()=>{
 const props={data,rows:data.transactions,range,onRangeChange:()=>{}};
 const off=render(views.TransactionCalendar,props,false,{0:'2026-11-06'}),on=render(views.TransactionCalendar,props,true,{0:'2026-11-06'});
 privateHtml(off);assert.match(off,/aria-label="2026-11-06 · 4건 · 출금 ••••••/);assert.match(off,/type="month"[^>]*value="2026-11"/);
 assert.match(off,/min-width:700px/);assert.match(off,/합성 거래처/);assert.match(on,/31\.7%/);
});

test('미분류 묶음과 메모는 금액·계좌를 숨기고 분류 및 거래 건수는 유지한다',()=>{
 const reviewData={...data,transactions:[row('unmapped',{category_id:null})]};
 const notes=createMerchantNoteStore([],async()=>({})),queue=createClassificationQueue();
 const props={data:reviewData,biz:'all',refresh,notes,queue,onApplied:refresh};
 const off=render(views.ClassificationReview,props,false),on=render(views.ClassificationReview,props,true);
 privateHtml(off);assert.match(off,/미매핑/);assert.match(off,/1건/);assert.match(on,/87,231원/);notes.dispose();
});

test('대여·상환 양방향 누계·차액·메모를 원본 변경 없이 숨긴다',()=>{
 const pair={key:'synthetic-pair',businessA:{key:'a',name:'합성 사업자 A'},businessB:{key:'b',name:'합성 사업자 B'},aToB:123457,bToA:987653,amount:864196,baselineAtoB:123457,baselineBtoA:987653,creditor:{name:'합성 사업자 B'},debtor:{name:'합성 사업자 A'},manualEntries:[],note:'합성 메모 87,231원 계좌 987654321098'};
 const prior=JSON.stringify(pair),off=render(views.IntercompanyPairFlow,{pair},false),on=render(views.IntercompanyPairFlow,{pair},true);
 privateHtml(off,['123,457','987,653','864,196','87,231','987654321098']);assert.match(off,/합성 사업자 A/);assert.match(on,/864,196원/);assert.equal(JSON.stringify(pair),prior);
});

test('토스 정산과 세금 알림은 예정액·잔액·메모를 숨기고 날짜·상태를 유지한다',()=>{
 const state={groups:[{id:'settlement',businessId:'b1',accountId:'a1',date:'2026-11-10',amount:123457,pendingAmount:123457,receivedAmount:0,status:'pending',reason:null}],response:{configured:true,lastSyncedAt:null},loading:false,error:'',sync:refresh,reload:refresh,syncing:false};
 const off=render(views.TossSettlementsPanel,{state,data,biz:'all',range},false);privateHtml(off);assert.match(off,/2026-11-10/);assert.match(off,/입금 예정/);
 const tax={id:'tax',business_id:'b1',source_type:'manual',source_key:'manual:tax',month:'2026-11',title:'합성 세금 87,231원',account_id:'a1',plan_date:'2026-11-25',amount:123457,memo:'납부계좌 987654321098',excluded:false,version:1,payment_kind:'tax',payment_status:'pending',updated_at:'2026-11-01T00:00:00Z'};
 const taxOff=render(views.TaxPaymentAlert,{data,biz:'all',asOf:'2026-11-06',state:{...editState,edits:[tax]},onViewDate:()=>{}},false,{0:true});privateHtml(taxOff);assert.match(taxOff,/2026년 11월 25일/);
});

test('Google 시트 미리보기와 업로드 기록은 금융 문자열을 숨기고 다운로드를 잠근다',()=>{
 const sheet={name:'합성 시트',account_id:'a1',selected:true,count:1,from:'2026-11-06',to:'2026-11-06',income:0,expense:123457,errors:[{row:2,message:'확인 54,321원'}],sample:[{txn_date:'2026-11-06',description:'합성 거래 87,231원',amount:123457,direction:'out',category_name:'급여',balance:987653}]};
 const preview={sourceUrl:'https://docs.google.com/spreadsheets/d/synthetic/edit',sourceHash:'synthetic',planHash:'synthetic',sheets:[sheet],summary:{inserted:1,updated:0,removed:0,unchanged:0,sourceDuplicates:0,blocked:1},conflicts:[]};
 const props={data,refresh};
 const off=render(views.GoogleSheetImport,props,false,{0:preview.sourceUrl,1:true,2:preview,3:[{sheet:sheet.name,account_id:'a1',selected:true}]});
 privateHtml(off);assert.match(off,/확인 필요 전체/);assert.match(off,/disabled=""[^>]*title="금액 표시를 켜면 내려받을 수 있습니다"/);
 const uploadOff=render(views.UploadView,{data,biz:'all',refresh},false);privateHtml(uploadOff,['67,891','123456789012']);
 assert.match(uploadOff,/<button[^>]*disabled=""[^>]*>원본<\/button>/);assert.match(uploadOff,/<button[^>]*disabled=""[^>]*>오류행<\/button>/);
 const mapping={date:0,description:1,expense:2,balance:3},headers=['거래일자','적요','출금','잔액'],rows=[headers,['2026-11-06','합성 원본',902341,908761,'123456789012']];
 const detected={headerRow:0,headerStart:0,mapping,headers,score:100,ambiguous:[]};
 const sheetName='합성 통장 64,321원',loaded={file:{name:'합성 파일 67,891원.xlsx'},workbook:{SheetNames:[sheetName]},sheet:sheetName,rows,detected,sheets:[{name:sheetName,rows,detected,selected:true,mapping,options:{headerRow:0}}]};
 const forced={5:'a1',8:loaded,9:mapping,15:true},prior=JSON.stringify(loaded);
 const rawOff=render(views.UploadView,{data,biz:'all',refresh},false,forced),rawOn=render(views.UploadView,{data,biz:'all',refresh},true,forced);
 privateHtml(rawOff,['902341','908761','123456789012','64,321','67,891']);assert.match(rawOff,/금액 표시를 켜면 원본 미리보기를 확인할 수 있습니다/);assert.match(rawOn,/902341/);assert.equal(JSON.stringify(loaded),prior);
});

test('설정의 잔액·유보액·제목·작업기록을 숨기고 백업 링크를 비활성화한다',()=>{
 for(const section of ['businesses','recurring','account']){
  const props={data,section,refresh,email:'synthetic@example.test'};
  const off=render(views.SettingsView,props,false);privateHtml(off,['456,789','765,431','234,569','76,543','98,765','123456789012']);
  if(section==='account'){assert.doesNotMatch(off,/href="\/api\/account\?format=/);assert.match(off,/aria-disabled="true"/);assert.match(render(views.SettingsView,props,true),/href="\/api\/account\?format=xlsx"/);}
 }
});

test('설정 금액 입력은 고정 마스크이며 날짜와 비금융 입력·내부 초안은 유지한다',()=>{
 const editor={resource:'accounts',id:'a1',values:{...data.accounts[0]}};
 const props={data,section:'businesses',refresh,email:'synthetic@example.test'},prior=JSON.stringify(editor);
 const off=render(views.SettingsView,props,false,{0:editor}),on=render(views.SettingsView,props,true,{0:editor});
 privateHtml(off,['765431','123456789012']);assert.match(off,/value="••••••"/);assert.match(off,/type="date"[^>]*value="2026-11-01"/);assert.match(on,/value="765431"/);assert.equal(JSON.stringify(editor),prior);
});

test('Clobe 잔액·거래·분류 미리보기·카드청구와 시트 오류의 금융 수치를 함께 숨긴다',()=>{
 const scraping={status:'SUCCESS',lastCollectedAt:'2026-11-06T01:00:00Z',error:null};
 const bank={id:1,name:'합성 통장 123456789012',bankName:'합성은행',maskedNumber:'012',currency:'KRW',balance:987653,krwBalance:987653,isHidden:false};
 const accounts={fetchedAt:'2026-11-06T01:00:00Z',companies:[{id:'company',name:'합성 사업자 A',role:'owner',accounts:[bank],scraping,error:null}]};
 const result={fetchedAt:accounts.fetchedAt,companyId:'company',bankAccountId:1,startDate:from,endDate:asOf,rows:[{id:'raw',date:'2026-11-06',time:'12:34',description:'합성 내역 87,231원',party:'합성 거래처',category:'급여',memo:'확인 54,321원 계좌 987654321098',direction:'out',amount:123457,balance:987653,currency:'KRW'}],hasNext:false,nextCursor:null,totalElements:1,inAmountSum:0,outAmountSum:123457,scraping};
 const clobeProps={};
 const forced={0:{configured:true,connected:true,state:'connected'},1:false,5:accounts,8:'company',9:'1',10:range,11:result};
 const clobeOff=render(views.ClobePanel,clobeProps,false,forced),clobeOn=render(views.ClobePanel,clobeProps,true,forced);
 privateHtml(clobeOff);assert.match(clobeOff,/합성 거래처/);assert.match(clobeOn,/123,457/);
 const summary={inserted:1,referenced:0,unchanged:0,sourceDuplicates:0,blocked:0,updated:0,removed:0};
 const preview={previewId:'synthetic',expiresAt:'2099-01-01T00:00:00Z',scope:{start_date:from,end_date:asOf,account_count:1,business_count:1},rows:[{...row('preview'),key:'preview',kind:'insert',company_id:'company',external_account_id:'1',external_transaction_id:'external',existing_transaction_id:null}],summary,conflicts:[]};
 const importOff=render(views.ClobeImportPanel,{accounts,data,refresh},false,{0:[{company_id:'company',external_account_id:'1',account_id:'a1',selected:true}],1:false,3:range,4:preview});privateHtml(importOff);assert.match(importOff,/2026-11-06/);
 const bills={startDate:from,endDate:asOf,fetchedAt:accounts.fetchedAt,companies:[{id:'company',name:'합성 사업자 A',bills:[{key:'bill',date:'2026-11-20',maskedCard:'합성 카드 012',kind:'REGULAR',itemCount:1,amount:123457,replaceable:true,reason:null}],error:null,scraping,warnings:[]}]};
 const cardOff=render(views.ClobeCardBillsPanel,{data,asOf,biz:'all',state:editState,range},false,{0:true,2:bills});privateHtml(cardOff,['123,457']);assert.match(cardOff,/2026-11-20/);
 const completion={scope:range,ledger:{...summary,unclassified:0},completedMonths:2,totalMonths:2,failures:[],recoveredMonths:[],accountFailures:[],monthScopes:[],sourceThrough:{earliest:null,latest:null},balanceResult:null,balanceError:'확인 잔액 87,231원 계좌 987654321098',refreshed:true,refreshError:null,fullSuccess:false};
 const summaryOff=render(views.ClobeDashboardSyncSummary,{result:completion,accounts:data.accounts,businesses},false);privateHtml(summaryOff,['87,231','987654321098']);assert.match(summaryOff,/2개월/);
 const syncOff=render(views.SheetSyncStatus,{onRefresh:refresh},false,{0:{configured:true,sources:[{id:'source',source_url:'https://docs.google.com/spreadsheets/d/synthetic/edit',enabled:true,last_run_at:null,last_result:{inserted:1,updated:0,removed:0,unchanged:2,blocked:1},last_error:'확인 87,231원',mappings:[]}]},1:false});privateHtml(syncOff,['87,231']);assert.match(syncOff,/1<small>건/);
});
