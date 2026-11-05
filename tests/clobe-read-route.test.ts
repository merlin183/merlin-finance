import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {SupabaseClient} from '@supabase/supabase-js';
import {clobeAccountsHandler,clobeTransactionsHandler,type ClobeReadRouteDependencies} from '../lib/clobe/read';
import type {ClobeReadTool} from '../lib/clobe/mcp';

const input={companyId:'company',bankAccountId:7,startDate:'2026-10-01',endDate:'2026-10-07'};
const db={} as SupabaseClient;
function deps(options:{authError?:string;callError?:string;unknownAccount?:boolean;currency?:string}={}){
 let authenticated=0,opened=0,closed=0;
 const called:ClobeReadTool[]=[];
 const dependencies:ClobeReadRouteDependencies={authenticate:async()=>{authenticated++;if(options.authError)throw Error(options.authError);return {db,ownerId:'shared-owner'};},getAccessToken:async(value,owner)=>{assert.equal(value,db);assert.equal(owner,'shared-owner');return 'synthetic-only';},getOrigin:()=> 'https://finance.example.test',openSession:async token=>{
  opened++;assert.equal(token,'synthetic-only');
  return {close:async()=>{closed++;},call:async tool=>{
   called.push(tool);if(options.callError)throw Error(options.callError);
   if(tool==='get_my_context')return {companies:[{companyId:'company',companyName:'합성 사업자',role:'MASTER'}]};
   if(tool==='get_bank_accounts')return {accounts:options.unknownAccount?[]:[{bankAccountId:7,accountName:'합성 통장',displayAccountNumber:'****-7777',currencyCode:options.currency||'KRW',isHidden:false,balance:null,krwBalance:null}]};
   if(tool==='get_labeled_transactions')return {content:[],hasNext:false,nextCursor:null,totalElements:0,inAmountSumKrw:0,outAmountSumKrw:0};
   return {overallStatus:'SUCCESS',assets:[]};
  }};
 }};
 return {dependencies,counts:()=>({authenticated,opened,closed}),called};
}
const post=(payload:unknown=input,origin:string|null='https://finance.example.test')=>new Request('https://finance.example.test/api/clobe/transactions',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(payload)});

test('read endpoints require existing Merlin administrator auth, and never send errors or tokens to client',async()=>{
 for(const authError of ['UNAUTHORIZED','ADMIN_REQUIRED']){
  const mock=deps({authError});const response=await clobeAccountsHandler(mock.dependencies)(new Request('https://finance.example.test/api/clobe/accounts'));
  assert.equal(response.status,authError==='UNAUTHORIZED'?401:403);assert.equal(mock.counts().opened,0);assert.ok(response.headers.get('cache-control')?.includes('no-store'));
 }
 const mock=deps({callError:'provider secret account data'});const response=await clobeAccountsHandler(mock.dependencies)(new Request('https://finance.example.test/api/clobe/accounts'));
 assert.equal(response.status,502);assert.equal(mock.counts().closed,1);assert.ok(!(await response.text()).includes('secret'));
});
test('transaction POST rejects missing/foreign origins, host spoofing and oversized/unknown fields before opening Clobe',async()=>{
 for(const request of [post(input,null),post(input,'https://other.test'),new Request('https://spoof.test/api/clobe/transactions',{method:'POST',headers:{Origin:'https://spoof.test','Content-Type':'application/json','x-forwarded-host':'finance.example.test'},body:JSON.stringify(input)}),post({...input,tool:'create_transaction'}),post({...input,cursor:'x'.repeat(9000)})]){
  const mock=deps();const response=await clobeTransactionsHandler(mock.dependencies)(request);assert.ok([400,403].includes(response.status));assert.equal(mock.counts().opened,0);
 }
});
test('successful lookup is no-store and closes its SDK session; unrelated accounts fail without transaction query',async()=>{
 const mock=deps();const response=await clobeTransactionsHandler(mock.dependencies)(post());
 assert.equal(response.status,200);assert.deepEqual(mock.counts(),{authenticated:1,opened:1,closed:1});
 const body=await response.json() as {totalElements:number;outAmountSum:number};assert.equal(body.totalElements,0);assert.equal(body.outAmountSum,0);assert.ok(!JSON.stringify(body).includes('synthetic-only'));
 assert.ok(response.headers.get('cache-control')?.includes('no-store'));
 const forbidden=deps({unknownAccount:true});const denied=await clobeTransactionsHandler(forbidden.dependencies)(post());assert.equal(denied.status,403);assert.equal(forbidden.counts().closed,1);assert.ok(!forbidden.called.includes('get_labeled_transactions'));
});
test('FX transaction API gives an explicit unsupported-currency response without querying transaction amounts',async()=>{
 const mock=deps({currency:'USD'});const response=await clobeTransactionsHandler(mock.dependencies)(post());
 assert.equal(response.status,422);assert.equal(mock.counts().closed,1);
 assert.ok(!mock.called.includes('get_labeled_transactions'));
 const text=await response.text();assert.ok(text.includes('외화 통장은 잔액만 조회'));assert.ok(text.includes('원화 통장을 선택'));
});
