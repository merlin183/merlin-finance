import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clobeCollectedInstant,syncClobeBalances,type ClobeBalanceInput} from '../lib/clobe/balance-sync';
import {clobeBalanceSyncHandler} from '../lib/clobe/balance-sync-route';
import type {ClobeAccountsResponse} from '../lib/clobe/types';
import type {ClobeReadSession} from '../lib/clobe/mcp';
import {readClobeAccounts} from '../lib/clobe/read';
const account='10000000-0000-4000-8000-000000000001';
const mapping={company_id:'synthetic-company',external_account_id:'1',account_id:account};
const now=()=>Date.parse('2026-10-08T12:00:00+09:00');
function source():ClobeAccountsResponse{return {fetchedAt:'2026-10-08T03:00:00Z',companies:[{id:'synthetic-company',name:'합성 사업자',role:'MASTER',error:null,scraping:{status:'SUCCESS',lastCollectedAt:'2026-10-08T11:00:00',error:null},accounts:[{id:1,name:'합성 통장',bankName:'합성 은행',maskedNumber:'•••• 0001',currency:'KRW',balance:1500,krwBalance:1500,isHidden:false}]}]};}

test('balance sync stores source balance/date even without querying or inserting any transactions',async()=>{
 const accounts=source();let saved:ClobeBalanceInput[]=[];
 const result=await syncClobeBalances({getMappings:async()=>[mapping],readAccounts:async()=>accounts,save:async rows=>{saved=rows;return {synced:rows.length,unchanged:0,skipped:[]};},now});
 assert.deepEqual(saved,[{...mapping,balance:1500,balance_date:'2026-10-08',collected_at:'2026-10-08T11:00:00'}]);
 assert.equal(result.synced,1);assert.equal(result.accounts,accounts);assert.deepEqual(result.skipped,[]);
});
test('FX, unknown balances, fractional KRW and incomplete/failed bank collection leave existing balance unchanged',async()=>{
 const variants=[(a:ClobeAccountsResponse)=>{a.companies[0].accounts[0].currency='USD';},(a:ClobeAccountsResponse)=>{a.companies[0].accounts[0].balance=null;},(a:ClobeAccountsResponse)=>{a.companies[0].accounts[0].balance=1.25;},(a:ClobeAccountsResponse)=>{a.companies[0].scraping.status='ERROR';},(a:ClobeAccountsResponse)=>{a.companies[0].scraping.status='IN_PROGRESS';},(a:ClobeAccountsResponse)=>{a.companies[0].scraping.lastCollectedAt=null;},(a:ClobeAccountsResponse)=>{a.companies[0].error='source unavailable';},(a:ClobeAccountsResponse)=>{a.companies[0].accounts=[];}];
 for(const patch of variants){const accounts=source();patch(accounts);let saved=0;const result=await syncClobeBalances({getMappings:async()=>[mapping],readAccounts:async()=>accounts,save:async rows=>{saved=rows.length;return {synced:0,unchanged:0,skipped:[]};},now});assert.equal(saved,0);assert.equal(result.skipped.length,1);assert.equal(result.skipped[0].account_id,account);}
});
test('invalid/future collected timestamps are rejected and API request time is never a substitute',async()=>{
 for(const stamp of ['2026-02-30T11:00:00','2026-10-08T24:00:00','2026-10-09T11:00:00','2026-10-08T13:00:00','2026-10-08T11:00:00+14:01']){
  const accounts=source();accounts.companies[0].scraping.lastCollectedAt=stamp;
  const result=await syncClobeBalances({getMappings:async()=>[mapping],readAccounts:async()=>accounts,save:async rows=>{assert.equal(rows.length,0);return {synced:0,unchanged:0,skipped:[]};},now});assert.equal(result.skipped.length,1);
 }
 assert.equal(clobeCollectedInstant('2026-10-08T11:00:00'),Date.parse('2026-10-08T11:00:00+09:00'));
 assert.equal(clobeCollectedInstant('2026-10-08T02:00:00Z'),Date.parse('2026-10-08T11:00:00+09:00'));
});
test('only saved unique mappings are accepted and no-mapping response explains why balances cannot update',async()=>{
 let read=0;
 await assert.rejects(syncClobeBalances({getMappings:async()=>[mapping,mapping],readAccounts:async()=>{read++;return source();},save:async()=>({synced:0,unchanged:0,skipped:[]}),now}),/CONFIGURATION/);assert.equal(read,0);
 const result=await syncClobeBalances({getMappings:async()=>[],readAccounts:async()=>source(),save:async rows=>{assert.equal(rows.length,0);return {synced:0,unchanged:0,skipped:[]};},now});assert.equal(result.skipped.length,1);assert.ok(result.skipped[0].reason.includes('연결'));
});
const post=(body:unknown={},origin='https://finance.example.test')=>new Request('https://finance.example.test/api/clobe/balance-sync',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
function route(options:{authError?:string;saveError?:string}={}){
 let opened=0,closed=0,auths=0;const calls:string[]=[];
 const session:ClobeReadSession={close:async()=>{closed++;},call:async tool=>{calls.push(tool);if(tool==='get_my_context')return {companies:[{companyId:'synthetic-company',companyName:'합성',role:'MASTER'}]};if(tool==='get_bank_accounts')return {accounts:[{bankAccountId:1,accountName:'합성 통장',displayAccountNumber:'masked 0001',currencyCode:'KRW',isHidden:false,balance:1500}]};return {overallStatus:'SUCCESS',assets:[{category:'BANK',label:'Bank',status:'SUCCESS',scrapedAt:'2026-10-08T11:00:00'}]};}};
 const handler=clobeBalanceSyncHandler({getOrigin:()=> 'https://finance.example.test',authenticate:async()=>{auths++;if(options.authError)throw Error(options.authError);return {openSession:async()=>{opened++;return session;},makeDependencies:getSession=>({getMappings:async()=>[mapping],readAccounts:async()=>readClobeAccounts(await getSession(),now),save:async rows=>{if(options.saveError)throw Error(options.saveError);assert.equal(rows[0].balance,1500);return {synced:1,unchanged:0,skipped:[]};},now})};}});
 return {handler,calls,counts:()=>({opened,closed,auths})};
}
test('route rejects browser financial/mapping input, foreign origin, forged host and oversized body before auth',async()=>{
 for(const request of [post({balance:0}),post({snapshots:[]}),post({account_id:account}),post({},'https://other.test'),new Request('https://spoof.test/api/clobe/balance-sync',{method:'POST',headers:{Origin:'https://spoof.test','x-forwarded-host':'finance.example.test'}}),post({text:'x'.repeat(300)})]){const mock=route();const response=await mock.handler(request);assert.equal(response.status,400);assert.deepEqual(mock.counts(),{opened:0,closed:0,auths:0});}
});
test('route requires admin, closes MCP transport, reads bank collection only and returns private no-store response',async()=>{
 for(const error of ['UNAUTHORIZED','ADMIN_REQUIRED']){const mock=route({authError:error}),response=await mock.handler(post());assert.equal(response.status,error==='UNAUTHORIZED'?401:403);assert.equal(mock.counts().opened,0);}
 const mock=route(),response=await mock.handler(post());assert.equal(response.status,200);assert.equal(mock.counts().closed,1);assert.ok(response.headers.get('cache-control')?.includes('no-store'));assert.deepEqual(new Set(mock.calls),new Set(['get_my_context','get_bank_accounts','get_scraping_status']));
 assert.equal((await response.json() as {synced:number}).synced,1);
 const failed=route({saveError:'CLOBE_BALANCE_STORAGE'}),error=await failed.handler(post());assert.equal(error.status,502);assert.equal(failed.counts().closed,1);assert.ok(!(await error.text()).includes('CLOBE_BALANCE_STORAGE'));
});
test('route accepts an empty POST body and preserves the source timestamp spelling in the result',async()=>{
 const mock=route(),response=await mock.handler(new Request('https://finance.example.test/api/clobe/balance-sync',{method:'POST',headers:{Origin:'https://finance.example.test'}}));assert.equal(response.status,200);const result=await response.json() as {accounts:ClobeAccountsResponse};assert.equal(result.accounts.companies[0].scraping.lastCollectedAt,'2026-10-08T11:00:00');
});
test('route accepts a non-null zero-byte POST stream without Content-Type',async()=>{
 const mock=route(),body=new ReadableStream<Uint8Array>({start(controller){controller.close();}});
 const request=new Request('https://finance.example.test/api/clobe/balance-sync',{method:'POST',headers:{Origin:'https://finance.example.test'},body,duplex:'half'} as RequestInit&{duplex:'half'});
 assert.ok(request.body);assert.equal(request.headers.get('content-type'),null);
 const response=await mock.handler(request);assert.equal(response.status,200);assert.equal(mock.counts().closed,1);
});
test('route rejects nonempty streamed financial input without Content-Type and enforces actual byte cap',async()=>{
 for(const text of ['{"balance":1}','{}'.padEnd(129,' ')]){
  const mock=route(),body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(text));controller.close();}});
  const request=new Request('https://finance.example.test/api/clobe/balance-sync',{method:'POST',headers:{Origin:'https://finance.example.test'},body,duplex:'half'} as RequestInit&{duplex:'half'});
  const response=await mock.handler(request);assert.equal(response.status,400);assert.equal(mock.counts().auths,0);
 }
});
