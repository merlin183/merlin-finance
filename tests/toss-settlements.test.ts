import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tossMerchants,publicTossMerchants} from '../lib/toss/config';
import {normalizeTossSettlement,readTossSettlements,tossSyncRange,TOSS_SETTLEMENT_PAGE_SIZE} from '../lib/toss/client';
import {reconcileTossSettlements} from '../lib/toss/reconcile';
import {tossSettlementHandlers} from '../lib/toss/route';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';
import type {TossSettlement,TossSettlementResponse} from '../lib/toss/types';
import type {TossStore} from '../lib/toss/store';

const business='20000000-0000-4000-8000-000000000001',account='30000000-0000-4000-8000-000000000001';
const merchant={merchantId:'synthetic-mid',businessId:business,accountId:account,label:'합성 상점',secretKey:'live_sk_synthetic_key'};
const range={from:'2026-10-01',to:'2027-01-31'},now=Date.parse('2026-11-02T10:00:00+09:00');
const source=(patch:Record<string,unknown>={})=>({mId:merchant.merchantId,paymentKey:'pay-a',transactionKey:'txn-a',currency:'KRW',amount:1000,payOutAmount:970,supplyAmount:27,vat:3,soldDate:'2026-11-01',paidOutDate:'2026-11-05',cancel:null,...patch});
const row=(patch:Partial<TossSettlement>={}):TossSettlement=>({...normalizeTossSettlement(source(),merchant,range,new Date(now).toISOString()),...patch});
const dataset=():Dataset=>({...emptyDataset,businesses:[{id:business,name:'합성사업자',color:'#00f',representative:'',kind:'',reserve:0}],accounts:[{id:account,business_id:business,name:'입금통장',bank:'합성은행',masked_number:'***1',opening_balance:100,opening_balance_date:'2026-10-01'}]});
const incoming=(patch:Partial<Transaction>={}):Transaction=>({id:'bank-1',business_id:business,account_id:account,upload_id:null,txn_date:'2026-11-05',amount:970,direction:'in',description:'주식회사 토스페이먼츠',raw_gwamok:'',category_id:null,is_internal:false,balance:1070,tax_invoice:false,dedup_hash:'synthetic',manually_classified:false,...patch});

test('explicit server mappings only accept unique MIDs and live secret keys; public config omits keys',()=>{
 const env={TOSS_SETTLEMENT_MERCHANTS:JSON.stringify([{merchantId:merchant.merchantId,businessId:business,accountId:account,label:'합성 상점'}]),TOSS_SECRET_KEY:merchant.secretKey};
 assert.deepEqual(tossMerchants(env),[merchant]);assert.ok(!JSON.stringify(publicTossMerchants([merchant])).includes('live_sk'));
 assert.deepEqual(tossMerchants({}),[]);
 assert.throws(()=>tossMerchants({...env,TOSS_SECRET_KEY:'test_sk_fake'}));
 assert.throws(()=>tossMerchants({...env,TOSS_SETTLEMENT_MERCHANTS:JSON.stringify([{...publicTossMerchants([merchant])[0],secretKey:'never-inline'}])}));
 assert.throws(()=>tossMerchants({...env,TOSS_SETTLEMENT_MERCHANTS:JSON.stringify([publicTossMerchants([merchant])[0],publicTossMerchants([merchant])[0]])}));
});
test('KRW signed payouts are authoritative; unknown currency, counterparty, unsafe money and unsigned cancellation fail closed',()=>{
 const cancelled=normalizeTossSettlement(source({transactionKey:'cancel-a',amount:-1000,payOutAmount:-970,supplyAmount:-27,vat:-3,cancel:{cancelAmount:1000}}),merchant,range,new Date(now).toISOString());
 assert.equal(cancelled.pay_out_amount,-970);assert.equal(cancelled.fee_amount,-30);
 for(const patch of [{mId:'other'},{currency:'USD'},{payOutAmount:1.5},{paidOutDate:'2026-02-30'},{paidOutDate:'2027-03-01'},{cancel:{cancelAmount:1000}}])assert.throws(()=>normalizeTossSettlement(source(patch),merchant,range,new Date(now).toISOString()));
 assert.deepEqual(tossSyncRange(Date.parse('2026-01-01T00:00:00+09:00')),{from:'2025-12-01',to:'2026-04-01'});
});
test('pagination reads all pages with server-only Basic credentials and no-store; overlapping exact IDs are counted once',async()=>{
 let calls=0;
 const first=Array.from({length:TOSS_SETTLEMENT_PAGE_SIZE},(_,i)=>source({transactionKey:`txn-${i}`}));
 const fetcher=async(input:RequestInfo|URL,options?:RequestInit)=>{calls++;const url=new URL(String(input));assert.equal(url.origin,'https://api.tosspayments.com');assert.equal(url.searchParams.get('dateType'),'paidOutDate');assert.equal(options?.cache,'no-store');assert.equal(options?.redirect,'error');assert.equal((options?.headers as Record<string,string>).Authorization,`Basic ${Buffer.from(merchant.secretKey+':').toString('base64')}`);return Response.json(calls===1?first:[source({transactionKey:'txn-0'}),source({transactionKey:'last'})]);};
 const rows=await readTossSettlements([merchant],range,new AbortController().signal,()=>now,fetcher);assert.equal(rows.length,5001);assert.equal(calls,2);
});
test('provider authorization/errors, repeated full pages, conflicting IDs or invalid rows never form a complete result',async()=>{
 for(const status of [401,403,429,500])await assert.rejects(()=>readTossSettlements([merchant],range,new AbortController().signal,()=>now,async()=>new Response('',{status})));
 await assert.rejects(()=>readTossSettlements([merchant],range,new AbortController().signal,()=>now,async()=>Response.json([source(),source({payOutAmount:900})])));
 await assert.rejects(()=>readTossSettlements([merchant],range,new AbortController().signal,()=>now,async()=>Response.json([source({mId:'foreign'})])));
 const repeated=Array.from({length:TOSS_SETTLEMENT_PAGE_SIZE},(_,i)=>source({transactionKey:`txn-${i}`}));
 await assert.rejects(()=>readTossSettlements([merchant],range,new AbortController().signal,()=>now,async()=>Response.json(repeated)));
});
test('reconciliation never changes cash, adds future net payouts only, and preserves cancelled/split-MID source identity',()=>{
 const data=dataset(),original=JSON.stringify(data),second={...merchant,merchantId:'second'};
 const groups=reconcileTossSettlements(data,[row(),row(),row({merchant_id:'second',transaction_key:'txn-b',pay_out_amount:300}),row({transaction_key:'cancel',pay_out_amount:-70})],[merchant,second],'2026-11-02');
 assert.equal(groups.length,1);assert.equal(groups[0].pendingAmount,1200);assert.equal(groups[0].status,'pending');assert.equal(JSON.stringify(data),original);
});
test('one account/day bank receipt settles the sum exactly once; partial and foreign/generic transfers never inflate cash',()=>{
 const data=dataset();data.transactions=[incoming({amount:970}),incoming({amount:970})];
 let result=reconcileTossSettlements(data,[row()],[merchant],'2026-11-06');assert.equal(result[0].status,'received');assert.deepEqual(result[0].matchedTransactionIds,['bank-1']);assert.equal(result[0].pendingAmount,0);
 data.transactions=[incoming({amount:500}),incoming({id:'bank-2',amount:470})];result=reconcileTossSettlements(data,[row()],[merchant],'2026-11-06');assert.equal(result[0].status,'received');
 data.transactions=[incoming({amount:500})];result=reconcileTossSettlements(data,[row()],[merchant],'2026-11-06');assert.equal(result[0].status,'confirmation-needed');assert.equal(result[0].pendingAmount,0);
 for(const patch of [{business_id:'another'},{account_id:'another'},{txn_date:'2026-11-04'},{description:'토스뱅크 본인계좌 이동'}]){data.transactions=[incoming(patch)];result=reconcileTossSettlements(data,[row()],[merchant],'2026-11-06');assert.equal(result[0].status,'overdue');assert.equal(result[0].pendingAmount,0);}
});
test('today, past and inconsistent expectations remain visible without adding amounts already possibly included in current balance',()=>{
 const data=dataset();
 assert.equal(reconcileTossSettlements(data,[row({paid_out_date:'2026-11-02'})],[merchant],'2026-11-02')[0].status,'confirmation-needed');
 assert.equal(reconcileTossSettlements(data,[row({paid_out_date:'2026-11-01'})],[merchant],'2026-11-02')[0].status,'overdue');
 const conflicting=reconcileTossSettlements(data,[row(),row({pay_out_amount:100})],[merchant],'2026-11-02')[0];assert.equal(conflicting.status,'confirmation-needed');assert.equal(conflicting.pendingAmount,0);
 assert.equal(reconcileTossSettlements(data,[row({pay_out_amount:-100})],[merchant],'2026-11-02')[0].pendingAmount,0);
});
test('HTTP sync authenticates, rejects foreign inputs, saves only after complete fetch and releases failed leases',async()=>{
 let saves=0,claims=0,releases=0,reads=0,auths=0;
 const saved={merchants:publicTossMerchants([merchant]),settlements:[] as TossSettlement[],lastSyncedAt:null,range:null};
 const store:TossStore={read:async()=>{reads++;return saved;},claim:async()=>{claims++;},release:async()=>{releases++;},save:async input=>{saves++;saved.settlements=input.settlements;return {saved:input.settlements.length,from:input.from,to:input.to};}};
 let fail=false;
 const handlers=tossSettlementHandlers({authenticate:async()=>{auths++;return store;},origin:()=> 'https://example.test',merchants:()=>[merchant],now:()=>now,fetcher:async()=>Response.json(fail?[source({currency:'USD'})]:[source()])});
 const request=(body='{}',origin='https://example.test')=>new Request('https://example.test/api/toss/settlements',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body});
 assert.equal((await handlers.POST(request('{}','https://evil.test'))).status,400);assert.equal(auths,0);
 assert.equal((await handlers.POST(request('{"amount":123}'))).status,400);assert.equal(auths,0);
 let response=await handlers.POST(request());assert.equal(response.status,200);assert.equal(saves,1);assert.equal(claims,1);assert.equal(releases,0);assert.equal(reads,1);
 assert.ok(!JSON.stringify(await response.json()).includes(merchant.secretKey));
 fail=true;response=await handlers.POST(request());assert.equal(response.status,502);assert.equal(saves,1);assert.equal(releases,1);
 const unauthorized=tossSettlementHandlers({authenticate:async()=>{throw Error('UNAUTHORIZED');},origin:()=>'',merchants:()=>[]});assert.equal((await unauthorized.GET()).status,401);
 const noConfig=tossSettlementHandlers({authenticate:async()=>store,origin:()=> 'https://example.test',merchants:()=>[]});assert.equal((await noConfig.POST(request())).status,503);
});
test('removing a server MID disables its saved expectations, and no-config responses cannot count archived data',async()=>{
 const second={...merchant,merchantId:'second'},saved={merchants:publicTossMerchants([merchant,second]),settlements:[row(),row({merchant_id:'second',transaction_key:'second-a',pay_out_amount:400})],lastSyncedAt:null,range:null};
 const store:TossStore={read:async()=>saved,claim:async()=>{},release:async()=>{},save:async()=>({saved:0,...range})};
 for(const current of [[merchant],[]]){
  const handlers=tossSettlementHandlers({authenticate:async()=>store,merchants:()=>current,origin:()=> 'https://example.test'});
  const response=await (await handlers.GET()).json() as TossSettlementResponse;assert.equal(response.configured,current.length>0);assert.equal(response.merchants.length,current.length);assert.equal(response.settlements.length,current.length);
  assert.equal(reconcileTossSettlements(dataset(),response.settlements,response.merchants,'2026-11-02').reduce((sum,r)=>sum+r.pendingAmount,0),current.length?970:0);
 }
});
