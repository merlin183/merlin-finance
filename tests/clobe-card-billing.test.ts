import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aggregateClobeCardBills,parseClobeCardBillingScraping,parseClobeCardBillsRequest,readClobeCardBills} from '../lib/clobe/card-billing';
import {ClobeReadError,type ClobeReadSession,type ClobeReadTool} from '../lib/clobe/mcp';

const request={startDate:'2026-10-01',endDate:'2026-12-31'};
const now=()=>Date.parse('2026-10-07T00:00:00Z');
const company={companyId:'synthetic-company',companyName:'합성 사업자'};
const collected={assets:[{category:'CARD_BILLING',status:'SUCCESS',scrapedAt:'2026-10-07T12:20:00',failureCategory:null}]};
const item={billingItemId:1,billingType:'REGULAR' as const,cardNo:'1234-****-****-5678',paymentAmount:12000,paymentDate:'2026-10-15',userNames:['사용자 비공개'],memberStoreName:'가맹점 비공개',usedDate:'2026-09-22',usedAmount:12000};
const page={content:[item],totalElements:1,page:0,size:100,hasNext:false,totalPayoutAmountSum:12000};
function fixture(overrides:Partial<Record<ClobeReadTool,(input:Record<string,unknown>)=>unknown>>={}){
 const calls:{tool:ClobeReadTool;input:Record<string,unknown>}[]=[];
 const defaults:Partial<Record<ClobeReadTool,(input:Record<string,unknown>)=>unknown>>={get_my_context:()=>({companies:[company]}),get_scraping_status:()=>collected,get_labeled_card_billing_items:()=>page};
 const session:ClobeReadSession={call:async(tool,input={})=>{calls.push({tool,input});const action=overrides[tool]||defaults[tool];assert.ok(action);return action(input);},close:async()=>{}};
 return {session,calls};
}

test('billing lookup is limited to current Clobe companies and only emits masked card, date and grouped sum',async()=>{
 const fake=fixture();const result=await readClobeCardBills(fake.session,request,now);
 assert.equal(result.companies.length,1);const bill=result.companies[0].bills[0];
 assert.equal(bill.maskedCard,'•••• 5678');assert.equal(bill.date,'2026-10-15');assert.equal(bill.amount,12000);assert.equal(bill.replaceable,true);assert.equal(bill.itemCount,1);
 assert.match(bill.key,/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 for(const secret of ['1234-****-****-5678','사용자 비공개','가맹점 비공개','2026-09-22','usedAmount'])assert.ok(!JSON.stringify(result).includes(secret));
 assert.deepEqual(fake.calls.find(call=>call.tool==='get_labeled_card_billing_items')?.input,{companyId:company.companyId,...request,page:0,size:100});
 assert.ok(!fake.calls.some(call=>['get_bank_accounts','get_labeled_transactions'].includes(call.tool)));
});
test('all pages are fetched and stable bill identity does not depend on row order or changed amount',async()=>{
 const rows=Array.from({length:103},(_,index)=>({...item,billingItemId:index+1,paymentAmount:100}));
 const fake=fixture({get_labeled_card_billing_items:input=>({...page,content:rows.slice(Number(input.page)*100,(Number(input.page)+1)*100),page:input.page,totalElements:103,totalPayoutAmountSum:10300,hasNext:input.page===0})});
 const result=await readClobeCardBills(fake.session,request,now);const bill=result.companies[0].bills[0];
 assert.equal(bill.amount,10300);assert.equal(bill.itemCount,103);assert.equal(bill.replaceable,true);
 assert.deepEqual(fake.calls.filter(call=>call.tool==='get_labeled_card_billing_items').map(call=>call.input.page),[0,1]);
 const reordered=aggregateClobeCardBills(company.companyId,rows.toReversed().map(row=>({...row,paymentAmount:200})),'2026-10-07');
 assert.equal(reordered[0].key,bill.key);assert.equal(reordered[0].amount,20600);
 assert.notEqual(aggregateClobeCardBills('other-company',rows,'2026-10-07')[0].key,bill.key);
});
test('malformed or partial paging never produces a replaceable partial total',async()=>{
 const badPages=[{hasNext:true,totalElements:2},{totalElements:2},{page:1},{size:50},{totalElements:20001},{totalPayoutAmountSum:11999},{content:[{...item,billingItemId:0}]},{content:[{...item,paymentDate:'2026-09-30'}]},{content:[{...item,paymentDate:'2026-02-30'}]},{content:[{...item,paymentAmount:12.5}]},{content:[{...item,paymentAmount:Number.MAX_SAFE_INTEGER+1}]},{content:[{...item,billingType:'FORECAST'}]}];
 for(const bad of badPages){
  const fake=fixture({get_labeled_card_billing_items:()=>({...page,...bad})});const result=await readClobeCardBills(fake.session,request,now);
  assert.deepEqual(result.companies[0].bills,[]);assert.ok(result.companies[0].error);
 }
 const first=Array.from({length:100},(_,index)=>({...item,billingItemId:index+1,paymentAmount:1}));
 for(const second of [{content:[first[0]],totalElements:101},{content:[{...item,billingItemId:101}],totalElements:102},{content:[],totalElements:101}]){
  const fake=fixture({get_labeled_card_billing_items:input=>({...page,...(input.page===0?{content:first,totalElements:101,hasNext:true,page:0,totalPayoutAmountSum:null}:{...second,page:1,hasNext:false,totalPayoutAmountSum:null})})});
  const result=await readClobeCardBills(fake.session,request,now);assert.deepEqual(result.companies[0].bills,[]);assert.ok(result.companies[0].error);
 }
});
test('company provider failures are sanitized and do not conceal other successful companies',async()=>{
 const fake=fixture({get_my_context:()=>({companies:[company,{companyId:'second',companyName:'두 번째 합성사업자'}]}),get_labeled_card_billing_items:input=>{if(input.companyId===company.companyId)throw Error('private OAuth-token PAN');return page;}});
 const result=await readClobeCardBills(fake.session,request,now);
 assert.ok(result.companies[0].error);assert.equal(result.companies[0].bills.length,0);assert.equal(result.companies[1].bills[0].amount,12000);
 assert.ok(!JSON.stringify(result).includes('private OAuth-token PAN'));
});
test('a missing bill or unavailable CARD_BILLING collection never means a zero bill',async()=>{
 const fake=fixture({get_labeled_card_billing_items:()=>({...page,content:[],totalElements:0,totalPayoutAmountSum:0}),get_scraping_status:()=>({assets:[{category:'CARD_APPROVAL',status:'SUCCESS',scrapedAt:'2026-10-07T23:59:00'}]})});
 const result=await readClobeCardBills(fake.session,request,now);const shown=result.companies[0];
 assert.deepEqual(shown.bills,[]);assert.equal(shown.error,null);assert.equal(shown.scraping.status,'UNKNOWN');assert.equal(shown.scraping.lastCollectedAt,null);
 assert.ok(shown.warnings.some(warning=>warning.includes('0원')));
 assert.ok(shown.warnings.some(warning=>warning.includes('기존 계획')));
});
test('billing freshness uses only CARD_BILLING, preserving source time and sanitizing collection failures',()=>{
 const status=parseClobeCardBillingScraping({assets:[...collected.assets,{category:'CARD_APPROVAL',status:'SUCCESS',scrapedAt:'2026-10-07T23:59:00'},{category:'CARD_BILLING',status:'SUCCESS',scrapedAt:'2026-10-06T10:00:00'}]});
 assert.equal(status.status,'SUCCESS');assert.equal(status.lastCollectedAt,'2026-10-06T10:00:00');
 const failed=parseClobeCardBillingScraping({assets:[{category:'CARD_BILLING',status:'ERROR',failureCategory:'private bank error',failureMessage:'secret user',scrapedAt:null}]});
 assert.equal(failed.status,'ERROR');assert.ok(!JSON.stringify(failed).includes('private bank error'));assert.ok(!JSON.stringify(failed).includes('secret user'));
});
test('prepayment, adjustments, past, nonpositive, missing amounts and ambiguous cards cannot replace plans',()=>{
 for(const update of [{billingType:'PRE_PAYMENT' as const},{billingType:'ADJUSTMENT' as const},{paymentDate:'2026-10-06'},{paymentAmount:0},{paymentAmount:-100},{paymentAmount:null},{cardNo:'********' }]){
  const bill=aggregateClobeCardBills(company.companyId,[{...item,...update}],'2026-10-07')[0];assert.equal(bill.replaceable,false);assert.ok(bill.reason);
 }
 for(const other of [{...item,billingItemId:2,billingType:'PRE_PAYMENT' as const},{...item,billingItemId:2,billingType:'ADJUSTMENT' as const},{...item,billingItemId:2,billingType:'PRE_PAYMENT' as const,paymentDate:'2026-10-06'},{...item,billingItemId:2,cardNo:'9999-****-****-5678'}]){
  const bills=aggregateClobeCardBills(company.companyId,[item,other],'2026-10-07');assert.ok(bills.every(bill=>!bill.replaceable));
 }
 assert.equal(aggregateClobeCardBills(company.companyId,[{...item,paymentAmount:null},{...item,billingItemId:2}],'2026-10-07')[0].amount,null);
});
test('failed bill collection blocks otherwise valid replacement amounts',async()=>{
 const fake=fixture({get_scraping_status:()=>({assets:[{category:'CARD_BILLING',status:'FAILED',scrapedAt:null}]})});
 const bill=(await readClobeCardBills(fake.session,request,now)).companies[0].bills[0];
 assert.equal(bill.amount,12000);assert.equal(bill.replaceable,false);assert.ok(bill.reason?.includes('수집 오류'));
});
test('request validates exact dates, reversed periods, strict fields and a bounded 93 day interval',()=>{
 assert.deepEqual(parseClobeCardBillsRequest(request),request);
 assert.equal(parseClobeCardBillsRequest({startDate:'2026-10-01',endDate:'2027-01-01'}).endDate,'2027-01-01');
 for(const input of [{...request,endDate:'2027-01-02'},{...request,startDate:'2026-02-29'},{...request,startDate:'2027-01-01'},{...request,companyId:'outside'},{startDate:'2026-10-01'}])assert.throws(()=>parseClobeCardBillsRequest(input),error=>error instanceof ClobeReadError&&error.code==='invalid_request');
});
test('duplicate current-company identity rejects context instead of querying an ambiguous company',async()=>{
 const fake=fixture({get_my_context:()=>({companies:[company,company]})});
 await assert.rejects(readClobeCardBills(fake.session,request,now),ClobeReadError);
 assert.ok(!fake.calls.some(call=>call.tool==='get_labeled_card_billing_items'));
});
test('group overflow fails only that company and deadline prevents unbounded subsequent calls',async()=>{
 const fake=fixture({get_labeled_card_billing_items:()=>({...page,content:[{...item,paymentAmount:Number.MAX_SAFE_INTEGER},{...item,billingItemId:2,paymentAmount:1}],totalElements:2,totalPayoutAmountSum:null})});
 const result=await readClobeCardBills(fake.session,request,now);assert.ok(result.companies[0].error);assert.deepEqual(result.companies[0].bills,[]);
 let ticks=0;const late=fixture();const timeout=await readClobeCardBills(late.session,request,()=>now()+ticks++*50000);
 assert.ok(timeout.companies[0].error?.includes('초과'));assert.ok(!late.calls.some(call=>call.tool==='get_labeled_card_billing_items'));
});
