import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {SupabaseClient} from '@supabase/supabase-js';
import {clobeCardBillsHandler} from '../lib/clobe/card-billing';
import type {ClobeReadRouteDependencies} from '../lib/clobe/read';
import type {ClobeReadTool} from '../lib/clobe/mcp';
import type {ClobeCardBillsResponse} from '../lib/clobe/card-billing-types';

function fixture(authError?:string,providerError?:string){
 let opened=0,closed=0;const called:ClobeReadTool[]=[];
 const db={} as SupabaseClient;
 const dependencies:ClobeReadRouteDependencies={authenticate:async()=>{if(authError)throw Error(authError);return {db,ownerId:'shared-owner'};},getAccessToken:async(value,owner)=>{assert.equal(value,db);assert.equal(owner,'shared-owner');return 'synthetic-token';},getOrigin:()=> 'https://finance.example.test',openSession:async(token,options)=>{
  assert.equal(token,'synthetic-token');assert.ok(options.signal);opened++;
  return {close:async()=>{closed++;},call:async(tool)=>{called.push(tool);if(providerError)throw Error(providerError);if(tool==='get_my_context')return {companies:[{companyId:'synthetic-company',companyName:'합성 사업자'}]};if(tool==='get_scraping_status')return {assets:[]};return {content:[],totalElements:0,page:0,size:100,hasNext:false,totalPayoutAmountSum:0};}};
 }};
 return {dependencies,counts:()=>({opened,closed}),called};
}
const request=(query='startDate=2026-10-01&endDate=2026-10-31')=>new Request('https://finance.example.test/api/clobe/card-bills?'+query);

test('card bill GET requires current finance administrator auth and does not expose credentials',async()=>{
 for(const authError of ['UNAUTHORIZED','ADMIN_REQUIRED']){
  const fake=fixture(authError);const response=await clobeCardBillsHandler(fake.dependencies)(request());assert.equal(response.status,authError==='UNAUTHORIZED'?401:403);assert.equal(fake.counts().opened,0);assert.ok(response.headers.get('cache-control')?.includes('no-store'));
 }
 const fake=fixture(undefined,'private OAuth error');const response=await clobeCardBillsHandler(fake.dependencies)(request());
 assert.equal(response.status,502);assert.equal(fake.counts().closed,1);assert.ok(!(await response.text()).includes('private OAuth error'));
});
test('query periods and duplicates are bounded before Clobe is opened',async()=>{
 for(const query of ['', 'startDate=2026-10-01&endDate=2027-02-01','startDate=2026-10-01&endDate=2026-10-31&companyId=unrelated','startDate=2026-10-01&startDate=2026-09-01&endDate=2026-10-31','startDate=2026-02-29&endDate=2026-03-01']){
  const fake=fixture();const response=await clobeCardBillsHandler(fake.dependencies)(request(query));assert.equal(response.status,400);assert.equal(fake.counts().opened,0);
 }
});
test('a successful read closes the session and has private no-store headers without applying any plan',async()=>{
 const fake=fixture();const response=await clobeCardBillsHandler(fake.dependencies)(request());assert.equal(response.status,200);assert.deepEqual(fake.counts(),{opened:1,closed:1});
 assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 const body=await response.json() as ClobeCardBillsResponse;assert.equal(body.companies[0].bills.length,0);assert.ok(body.companies[0].warnings.length);assert.ok(!JSON.stringify(body).includes('synthetic-token'));
 assert.ok(fake.called.every(tool=>['get_my_context','get_scraping_status','get_labeled_card_billing_items'].includes(tool)));
});
