import test from 'node:test';
import assert from 'node:assert/strict';
import {clobeAuthorizationUrl,clobeCollectedAt,clobeMoney,clobePanelRequest,createClobeRequestGate,matchesClobeQuery,mergeClobeRows,syncClobePanelBalances} from '../components/finance/clobe-panel-model';
import type {ClobeTransactionRow,ClobeTransactionsResponse} from '../lib/clobe/types';

const row=(id:string,amount=1000):ClobeTransactionRow=>({id,date:'2026-10-01',time:'12:00:00',description:'합성 거래',party:null,category:null,memo:null,direction:'out',amount,balance:5000,currency:'KRW'});
const scope={companyId:'synthetic-company',bankAccountId:7,startDate:'2026-10-01',endDate:'2026-10-07'};
const result=():ClobeTransactionsResponse=>({...scope,fetchedAt:'2026-10-07T03:00:00Z',rows:[row('synthetic-1')],hasNext:false,nextCursor:null,totalElements:1,inAmountSum:0,outAmountSum:1000,scraping:{status:'SUCCESS',lastCollectedAt:'2026-10-07T11:30:00',error:null}});

test('Clobe 승인 이동은 고정된 HTTPS 원본과 승인 경로만 허용한다',()=>{
 const valid='https://api.clobe.ai/oauth/authorize?client_id=synthetic&state=synthetic';
 assert.equal(clobeAuthorizationUrl(valid),valid);
 for(const url of ['http://api.clobe.ai/oauth/authorize','https://api.clobe.ai.evil.example/oauth/authorize','https://api.clobe.ai/oauth/authorize/','https://api.clobe.ai:444/oauth/authorize','https://user:password@api.clobe.ai/oauth/authorize','https://api.clobe.ai/oauth/authorize#token','javascript:alert(1)','/oauth/authorize',null])assert.equal(clobeAuthorizationUrl(url),null);
});

test('더보기는 이미 보인 거래와 페이지 내부의 중복 ID를 추가하지 않는다',()=>{
 const existing=[row('one',1000),row('two',2000)],next=[row('two',9999),row('three',3000),row('three',9999)];
 const merged=mergeClobeRows(existing,next);
 assert.deepEqual(merged.map(value=>[value.id,value.amount]),[['one',1000],['two',2000],['three',3000]]);
 assert.equal(existing.length,2);assert.equal(next.length,3);
});

test('회사·통장·조회 기간이 하나라도 다른 거래 응답은 현재 표에 사용하지 않는다',()=>{
 assert.equal(matchesClobeQuery(result(),scope),true);
 for(const changed of [{companyId:'other-company'},{bankAccountId:8},{startDate:'2026-09-01'},{endDate:'2026-10-08'}])assert.equal(matchesClobeQuery({...result(),...changed},scope),false);
});

test('사용자가 통장을 바꾸면 늦게 도착한 이전 fetch 응답을 폐기한다',async()=>{
 const gate=createClobeRequestGate();
 let resolveOld!:(value:Response)=>void;
 const fakeFetch:typeof fetch=async()=>new Promise<Response>(resolve=>{resolveOld=resolve;});
 const old=gate.begin();
 const oldPromise=clobePanelRequest<{account:string}>('/api/clobe/transactions',{signal:old.signal},fakeFetch);
 const newer=gate.begin();assert.equal(old.signal.aborted,true);
 // Synthetic server deliberately ignores AbortSignal; the request gate still wins.
 resolveOld(Response.json({account:'old-account'}));
 assert.equal((await oldPromise).account,'old-account');
 assert.equal(gate.current(old.version),false);assert.equal(gate.current(newer.version),true);
 gate.cancel();assert.equal(newer.signal.aborted,true);assert.equal(gate.current(newer.version),false);
});

test('조회 helper는 POST body와 AbortSignal을 유지하며 실패를 빈 거래로 바꾸지 않는다',async()=>{
 const controller=new AbortController();
 let observed:RequestInit|undefined;
 const response=await clobePanelRequest<ClobeTransactionsResponse>('/api/clobe/transactions',{method:'POST',signal:controller.signal,body:JSON.stringify(scope),headers:{'Content-Type':'application/json'}},async(_path,options)=>{observed=options;return Response.json(result());});
 assert.equal(observed?.cache,'no-store');assert.equal(observed?.signal,controller.signal);assert.equal(observed?.method,'POST');assert.deepEqual(JSON.parse(observed?.body as string),scope);assert.equal(response.rows.length,1);
 await assert.rejects(clobePanelRequest('/api/clobe/transactions',{},async()=>Response.json({error:'합성 조회 실패'},{status:502})),/합성 조회 실패/);
 await assert.rejects(clobePanelRequest('/api/clobe/accounts',{},async()=>new Response('not-json',{status:200})),/응답을 확인하지 못했습니다/);
 await assert.rejects(clobePanelRequest('/api/clobe/accounts',{},async()=>Response.json({error:'expired'},{status:401})),/로그인 권한/);
});

test('계좌 조회 권한 부족은 대시보드 로그인 만료로 오인하지 않는다',async()=>{
 await assert.rejects(clobePanelRequest('/api/clobe/transactions',{},async()=>Response.json({error:'조회 권한이 없는 회사 또는 계좌입니다.'},{status:403})),/조회 권한이 없는 회사 또는 계좌/);
});

test('은행 수집 시각은 KST 원본 날짜를 유지하고 원화와 외화의 숫자 표기를 구분한다',()=>{
 assert.equal(clobeCollectedAt('2026-10-07T00:15:00'),'2026-10-07 00:15:00');
 assert.equal(clobeCollectedAt(null),'수집 시각 미확인');
 assert.equal(clobeCollectedAt('invalid'),'수집 시각 미확인');
 assert.match(clobeCollectedAt('2026-10-06T15:15:00Z'),/2026.*10.*07.*00:15/);
 assert.equal(clobeMoney(1234567,'KRW'),'1,234,567원');
 assert.equal(clobeMoney(1234.56,'USD'),'1,234.56 USD');
 assert.equal(clobeMoney(null,'KRW'),'잔액 미확인');
 assert.equal(clobeMoney(0,'KRW'),'0원');
});

test('신규 거래가 없어도 Clobe 잔액 저장 성공 이후 공유 자료를 갱신한다',async()=>{
 const calls:string[]=[];
 const saved={synced:0,unchanged:2,skipped:[],accounts:{companies:[],fetchedAt:'2026-10-08T03:00:00Z'}};
 const completion=await syncClobePanelBalances(async()=>{calls.push('refresh');},async(path,options)=>{
  calls.push('save');assert.equal(path,'/api/clobe/balance-sync');assert.equal(options?.method,'POST');assert.equal(options?.body,'{}');assert.deepEqual(options?.headers,{'Content-Type':'application/json'});assert.equal(options?.signal,undefined);
  return Response.json(saved);
 });
 assert.deepEqual(calls,['save','refresh']);assert.equal(completion.refreshed,true);assert.deepEqual(completion.result,saved);
});

test('잔액 저장 후 화면 조회만 실패하면 저장을 재시도하지 않고 갱신 실패를 구분한다',async()=>{
 let saves=0;
 const completion=await syncClobePanelBalances(async()=>{throw Error('합성 화면 조회 실패');},async()=>{saves++;return Response.json({synced:1,unchanged:0,skipped:[],accounts:{companies:[],fetchedAt:'2026-10-08T03:00:00Z'}});});
 assert.equal(saves,1);assert.equal(completion.refreshed,false);assert.equal(completion.result.synced,1);
 if(!completion.refreshed)assert.match(completion.refreshError.message,/합성 화면 조회 실패/);
 let refreshed=false;
 await assert.rejects(syncClobePanelBalances(async()=>{refreshed=true;},async()=>Response.json({error:'합성 은행 조회 실패'},{status:502})),/합성 은행 조회 실패/);
 assert.equal(refreshed,false);
});

test('업로드 동기화는 은행 출금의 완전·부분 조회 결과도 화면 재조회 뒤 그대로 반환한다',async()=>{
 const saved={synced:2,unchanged:1,skipped:[],accounts:{companies:[],fetchedAt:'2026-10-08T03:00:00Z'},plan_actuals:{synced_accounts:1,unchanged_accounts:1,fetched_outflows:7,saved_outflows:7,complete:false,skipped:[{account_id:'synthetic-account',reason:'합성 수집 중'}]}};
 const calls:string[]=[];
 const completion=await syncClobePanelBalances(async()=>{calls.push('refresh');},async()=>{calls.push('save');return Response.json(saved);});
 assert.deepEqual(calls,['save','refresh']);assert.equal(completion.refreshed,true);assert.deepEqual(completion.result,saved);
});
