import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundedClobeFetch,ClobeReadError,clobeToolPayload,CLOBE_MAX_RESPONSE_BYTES,createClobeReadSession,type ClobeReadSession,type ClobeReadTool} from '../lib/clobe/mcp';
import {maskClobeAccountNumber,parseClobeScraping,parseClobeTransactionPage,parseClobeTransactionsRequest,readClobeAccounts,readClobeTransactions} from '../lib/clobe/read';

const request={companyId:'synthetic-company',bankAccountId:71,startDate:'2026-10-01',endDate:'2026-10-07',size:100};
const account={bankAccountId:71,accountName:'기업 운영통장',aliasName:'운영',accountNumber:'00000000001234',displayAccountNumber:'000-****-1234',currencyCode:'KRW',isHidden:false,balance:150000,krwBalance:150000};
const context={companies:[{companyId:request.companyId,companyName:'합성 사업자',role:'MASTER'}]};
const collected={overallStatus:'SUCCESS',assets:[{category:'BANK',label:'은행 계좌',status:'SUCCESS',scrapedAt:'2026-10-07T12:00:00',failureCategory:null,failureMessage:null}]};
const status=parseClobeScraping(collected);
const row={transactionId:801,accountId:71,transactionAt:'2026-10-07T00:00:01',transactionName:'합성 거래처',transactionDescription:'합성 정기결제',inAmount:0,outAmount:2000,afterBalance:150000,businessEntityName:null,category:'지급수수료',memo:null,accountNumber:account.accountNumber};
const page={content:[row],totalElements:1,hasNext:false,nextCursor:null,inAmountSumKrw:0,outAmountSumKrw:2000};
function fixture(overrides:Partial<Record<ClobeReadTool,(input:Record<string,unknown>)=>unknown>>={}){
 const calls:{tool:ClobeReadTool;input:Record<string,unknown>}[]=[];let closed=0;
 const defaults={get_my_context:()=>context,get_bank_accounts:()=>({accounts:[account]}),get_labeled_transactions:()=>page,get_scraping_status:()=>collected,get_labeled_card_billing_items:()=>({content:[],totalElements:0,page:0,size:100,hasNext:false,totalPayoutAmountSum:0})};
 const session:ClobeReadSession={call:async(tool,input={})=>{calls.push({tool,input});return (overrides[tool]||defaults[tool])(input);},close:async()=>{closed++;}};
 return {session,calls,closed:()=>closed};
}

test('display DTOs omit raw account numbers, tax registration and user identity; unavailable balances remain null',async()=>{
 const fake=fixture({get_bank_accounts:()=>({accounts:[{...account,balance:null,krwBalance:null}]})});
 const response=await readClobeAccounts(fake.session,()=>0);
 assert.equal(response.fetchedAt,'1970-01-01T00:00:00.000Z');
 assert.equal(response.companies[0].accounts[0].maskedNumber,'•••• 1234');
 assert.equal(response.companies[0].accounts[0].balance,null);
 assert.equal(response.companies[0].accounts[0].krwBalance,null);
 assert.ok(!JSON.stringify(response).includes(account.accountNumber));
 assert.equal(maskClobeAccountNumber(null),'번호 미제공');
 assert.equal(maskClobeAccountNumber('1234567891234'),'•••• 1234');
 assert.deepEqual(response.companies[0].scraping,status);
});
test('company account failures are retained explicitly while successful companies remain visible',async()=>{
 const fake=fixture({get_my_context:()=>({companies:[...context.companies,{companyId:'company-two',companyName:'두번째 합성사업자',role:'VIEWER'}]}),get_bank_accounts:input=>{if(input.companyId===request.companyId)throw Error('secret provider data');return {accounts:[account]};}});
 const response=await readClobeAccounts(fake.session);
 assert.equal(response.companies.length,2);
 assert.ok(response.companies[0].error);
 assert.deepEqual(response.companies[0].accounts,[]);
 assert.equal(response.companies[1].accounts.length,1);
 assert.ok(!JSON.stringify(response).includes('secret provider data'));
});
test('scraping reports bank freshness conservatively and does not borrow a newer card/tax timestamp',()=>{
 const value={...collected,assets:[collected.assets[0],{...collected.assets[0],category:'BANK_ACCOUNT',scrapedAt:'2026-10-06T11:00:00'},{...collected.assets[0],category:'CARD',label:'카드',scrapedAt:'2026-10-07T23:59:00'}]};
 assert.equal(parseClobeScraping(value).lastCollectedAt,'2026-10-06T11:00:00');
 assert.equal(parseClobeScraping({...value,assets:[value.assets[2]]}).lastCollectedAt,null);
 const failed=parseClobeScraping({...collected,assets:[{...collected.assets[0],status:'ERROR',failureCategory:'CERTIFICATE_EXPIRED',failureMessage:'sensitive text'}]});
 assert.equal(failed.status,'ERROR');assert.ok(failed.error);assert.ok(!failed.error.includes('sensitive'));
});
test('transaction request rejects invalid real dates, reversed periods, arbitrary fields and excessive paging',()=>{
 for(const override of [{startDate:'2026-02-29'},{endDate:'2026-13-01'},{startDate:'2026-10-08'},{bankAccountId:0},{size:101},{size:1.5},{cursor:''},{tool:'create_bank_transaction'},{companyId:''}])assert.throws(()=>parseClobeTransactionsRequest({...request,...override}),ClobeReadError);
 assert.equal(parseClobeTransactionsRequest({...request,startDate:'2024-02-29'}).startDate,'2024-02-29');
});
test('transactions preserve original local date/time and explicit party, mapping and memo',async()=>{
 const fake=fixture({get_labeled_transactions:()=>({...page,content:[{...row,businessEntityName:'합성 거래처',memo:'검토 메모'}]})});
 const response=await readClobeTransactions(fake.session,request,()=>0);
 assert.deepEqual(response.rows[0],{id:'801',date:'2026-10-07',time:'00:00:01',description:'합성 거래처 · 합성 정기결제',party:'합성 거래처',category:'지급수수료',memo:'검토 메모',direction:'out',amount:2000,balance:150000,currency:'KRW'});
 assert.ok(!JSON.stringify(response).includes(account.accountNumber));
 assert.equal(response.outAmountSum,2000);
 assert.deepEqual(fake.calls.find(call=>call.tool==='get_labeled_transactions')?.input,{companyId:request.companyId,accountId:71,startDate:request.startDate,endDate:request.endDate,size:100});
});
test('FX account balances are visible but transaction tool is blocked because amount currency is not established',async()=>{
 const fake=fixture({get_bank_accounts:()=>({accounts:[{...account,currencyCode:'USD'}]}),get_labeled_transactions:()=>({...page,content:[{...row,outAmount:12.75,afterBalance:50.25}],outAmountSumKrw:17000})});
 const accounts=await readClobeAccounts(fake.session);
 assert.equal(accounts.companies[0].accounts[0].currency,'USD');
 assert.equal(accounts.companies[0].accounts[0].balance,150000);
 await assert.rejects(readClobeTransactions(fake.session,request),error=>error instanceof ClobeReadError&&error.code==='unsupported_currency');
 assert.ok(!fake.calls.some(call=>call.tool==='get_labeled_transactions'));
 // Even a future explicitly verified FX parser path must not label KRW sums
 // as source currency; this parser is not reachable for FX through the API.
 const parsed=parseClobeTransactionPage({...page,outAmountSumKrw:17000},request,'USD',status);
 assert.equal(parsed.inAmountSum,null);assert.equal(parsed.outAmountSum,null);
});
test('unknown company or account never reaches the transaction tool',async()=>{
 for(const input of [{...request,companyId:'unrelated'},{...request,bankAccountId:72}]){
  const fake=fixture();await assert.rejects(readClobeTransactions(fake.session,input),error=>error instanceof ClobeReadError&&error.code==='forbidden');
  assert.ok(!fake.calls.some(call=>call.tool==='get_labeled_transactions'));
 }
});
test('ambiguous directions, wrong account/date, duplicate identity and impossible timestamps reject the whole page',()=>{
 for(const bad of [{inAmount:1},{outAmount:0},{inAmount:-1},{outAmount:Number.POSITIVE_INFINITY},{accountId:72},{transactionAt:'2026-09-30T12:00:00'},{transactionAt:'2026-10-07T24:00:00'},{transactionAt:'2026-10-07T00:00:01Z'}])assert.throws(()=>parseClobeTransactionPage({...page,content:[{...row,...bad}]},request,'KRW',status),ClobeReadError);
 assert.throws(()=>parseClobeTransactionPage({...page,totalElements:2,content:[row,row]},request,'KRW',status),ClobeReadError);
 const missing=parseClobeTransactionPage({...page,content:[{...row,afterBalance:null}],inAmountSumKrw:null,outAmountSumKrw:null},request,'KRW',status);
 assert.equal(missing.rows[0].balance,null);assert.equal(missing.outAmountSum,null);
});
test('keyset paging preserves exact cursors and rejects inconsistent pagination',async()=>{
 const cursor='opaque/synthetic+cursor=';
 const fake=fixture({get_labeled_transactions:()=>({...page,hasNext:true,nextCursor:cursor,totalElements:2})});
 assert.equal((await readClobeTransactions(fake.session,request)).nextCursor,cursor);
 for(const bad of [{hasNext:true,nextCursor:null},{hasNext:true,nextCursor:'same'},{hasNext:false,nextCursor:'unexpected'},{hasNext:true,nextCursor:'new',content:[]}])assert.throws(()=>parseClobeTransactionPage({...page,...bad},{...request,cursor:'same'},'KRW',status),ClobeReadError);
 const continuation=fixture();await readClobeTransactions(continuation.session,{...request,cursor});
 assert.equal(continuation.calls.find(call=>call.tool==='get_labeled_transactions')?.input.cursor,cursor);
});
test('tool responses reject non-JSON, tool errors and oversized bodies without exposing provider errors',()=>{
 assert.deepEqual(clobeToolPayload({content:[{type:'text',text:'{"a":1}'}]}),{a:1});
 assert.deepEqual(clobeToolPayload({content:[],structuredContent:{a:2}}),{a:2});
 for(const value of [{content:[{type:'text' as const,text:'sensitive provider error'}],isError:true},{content:[{type:'text' as const,text:'bad json'}]},{content:[{type:'text' as const,text:'x'.repeat(CLOBE_MAX_RESPONSE_BYTES+1)}]}])assert.throws(()=>clobeToolPayload(value),ClobeReadError);
});
test('HTTP transport bounds actual streamed bytes, refuses another endpoint, and disables redirects/cache',async()=>{
 let invoked=0;
 const fetcher:typeof fetch=async(_url,init)=>{invoked++;assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');return new Response('x'.repeat(CLOBE_MAX_RESPONSE_BYTES+1));};
 const fetcherBounded=boundedClobeFetch(fetcher);
 await assert.rejects(fetcherBounded('https://example.test/mcp'),ClobeReadError);assert.equal(invoked,0);
 const response=await fetcherBounded('https://api.clobe.ai/mcp');await assert.rejects(response.text(),ClobeReadError);
});
test('official SDK handshake and read tool calls send bearer only to Clobe and runtime allowlist rejects writes',async()=>{
 const calls:string[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  assert.equal(input.toString(),'https://api.clobe.ai/mcp');
  assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-access');
  if(init?.method==='GET')return new Response(null,{status:405});
  if(!init?.body)return new Response(null,{status:202});
  const body=JSON.parse(String(init.body));calls.push(body.method);
  if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}}});
  if(body.method==='tools/call')return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify(context)}]}});
  return new Response(null,{status:202});
 };
 const session=await createClobeReadSession('synthetic-access',{fetcher});
 try{assert.deepEqual(await session.call('get_my_context'),context);await assert.rejects(session.call('create_transaction' as ClobeReadTool),ClobeReadError);}finally{await session.close();}
 assert.equal(calls.filter(method=>method==='tools/call').length,1);
 assert.equal(calls[0],'initialize');
});

test('a per-call cancellation rejects only that SDK request and the shared authenticated session remains usable',async()=>{
 let ready!:(value:void)=>void;const started=new Promise<void>(done=>{ready=done;}),methods:string[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  assert.equal(input.toString(),'https://api.clobe.ai/mcp');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-access');
  if(init?.method==='GET')return new Response(null,{status:405});
  if(!init?.body)return new Response(null,{status:202});
  const body=JSON.parse(String(init.body));methods.push(body.method);
  if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}}});
  if(body.method==='tools/call'&&body.params.name==='get_scraping_status'){ready();return new Response(null,{status:202});}
  if(body.method==='tools/call')return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify(context)}]}});
  return new Response(null,{status:202});
 };
 const session=await createClobeReadSession('synthetic-access',{fetcher}),controller=new AbortController();
 try{
  const call=session.call('get_scraping_status',{companyId:'synthetic-company'},{signal:controller.signal}),denied=assert.rejects(call,(error:unknown)=>error instanceof ClobeReadError&&error.code==='timeout');
  await started;controller.abort();await denied;
  assert.deepEqual(await session.call('get_my_context'),context);
  assert.ok(methods.includes('notifications/cancelled'));
 }finally{await session.close();}
});
