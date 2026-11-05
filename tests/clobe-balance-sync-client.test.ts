import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ClobeBalanceSyncButton} from '../components/finance/clobe-balance-sync-button';
import {ClobeDashboardSyncProvider} from '../components/finance/use-clobe-dashboard-sync';
import {syncClobePanelBalances} from '../components/finance/clobe-panel-model';
import {clobeBalanceSyncFeedback,createClobeBalanceSyncActions} from '../lib/finance/clobe-balance-sync-client';
import type {ClobeBalanceSyncResult} from '../lib/clobe/balance-sync';

const saved=(synced=0,unchanged=6):ClobeBalanceSyncResult=>({synced,unchanged,skipped:[],accounts:{companies:[],fetchedAt:'2026-10-08T03:00:00Z'}});
const bankResult=(overrides:Partial<NonNullable<ClobeBalanceSyncResult['plan_actuals']>>={}):ClobeBalanceSyncResult=>({...saved(2,4),plan_actuals:{synced_accounts:2,unchanged_accounts:4,fetched_outflows:17,saved_outflows:17,skipped:[],complete:true,...overrides}});

test('가용자금 버튼도 최근 두 달 거래·현재 잔액의 공통 최신 동기화로 진입한다',()=>{
 const accounts=[{id:'synthetic-account',business_id:'synthetic-business',name:'합성 통장',bank:'합성 은행',masked_number:'0000',opening_balance:0,opening_balance_date:null}];
 const refresh=async()=>{};
 const html=renderToStaticMarkup(createElement(ClobeDashboardSyncProvider,{actorKey:'synthetic-actor',refresh,accounts},createElement(ClobeBalanceSyncButton,{refresh,accounts})));
 assert.match(html,/Clobe 최신 동기화/);
 assert.match(html,/전체 사업자의 저장된 통장 연결/);assert.match(html,/최근 2개월\(이번 달·지난달\) 거래와 현재 잔액/);
 assert.match(html,/type="button"/);
 assert.doesNotMatch(html,/disabled=""/);
});

test('연속 클릭은 하나만 저장하고 0개 갱신·6개 최신 유지에도 화면을 다시 조회한다',async()=>{
 let saves=0,reads=0,resolve!:(response:Response)=>void;
 const refresh=async()=>{reads++;};
 const actions=createClobeBalanceSyncActions(()=>syncClobePanelBalances(refresh,async(path,options)=>{
  saves++;assert.equal(path,'/api/clobe/balance-sync');assert.equal(options?.method,'POST');
  assert.equal(options?.body,'{}');assert.deepEqual(options?.headers,{'Content-Type':'application/json'});
  assert.equal(options?.cache,'no-store');assert.equal(options?.signal,undefined);
  return new Promise<Response>(done=>{resolve=done;});
 }),refresh);
 const first=actions.sync();assert.ok(first);
 assert.equal(actions.sync(),null);
 assert.equal(actions.retryRefresh(),null);
 await Promise.resolve();resolve(Response.json(saved()));
 const completion=await first;
 assert.equal(saves,1);assert.equal(reads,1);assert.equal(completion.refreshed,true);
 const feedback=clobeBalanceSyncFeedback(completion);
 assert.equal(feedback.title,'저장된 잔액이 최신입니다');
 assert.match(feedback.counts,/잔액 갱신 0개 · 최신 유지 6개/);
 assert.equal(feedback.recalculated,true);
 assert.equal(actions.retryRefresh(),null);
});

test('저장 성공 후 조회 실패는 결과를 유지하며 재시도에서도 저장을 반복하지 않는다',async()=>{
 let saves=0,reads=0,failRead=true;
 const refresh=async()=>{reads++;if(failRead)throw Error('합성 화면 조회 실패');};
 const actions=createClobeBalanceSyncActions(()=>syncClobePanelBalances(refresh,async()=>{saves++;return Response.json(saved(2,4));}),refresh);
 const task=actions.sync();assert.ok(task);
 const completion=await task;
 assert.equal(completion.refreshed,false);assert.equal(completion.result.synced,2);
 assert.equal(clobeBalanceSyncFeedback(completion).recalculated,false);
 assert.equal(clobeBalanceSyncFeedback(completion).title,'잔액 저장 완료 · 화면 조회 필요');
 assert.equal(actions.sync(),null);
 const retry=actions.retryRefresh();assert.ok(retry);
 assert.equal(actions.retryRefresh(),null);assert.equal(actions.sync(),null);
 const failedAgain=await retry;
 assert.equal(failedAgain.refreshed,false);assert.equal(failedAgain.result,completion.result);
 failRead=false;
 const finalRetry=actions.retryRefresh();assert.ok(finalRetry);
 const finished=await finalRetry;
 assert.equal(finished.refreshed,true);assert.equal(finished.result,completion.result);
 assert.equal(clobeBalanceSyncFeedback(finished).recalculated,true);
 assert.equal(saves,1);assert.equal(reads,3);
});

test('은행 조회·저장 실패에는 화면 성공 메시지가 없으며 저장 재시도가 가능하다',async()=>{
 let saves=0,reads=0;
 const refresh=async()=>{reads++;};
 const actions=createClobeBalanceSyncActions(()=>syncClobePanelBalances(refresh,async()=>{
  saves++;return saves===1?Response.json({error:'합성 Clobe 연결 만료'},{status:409}):Response.json(saved());
 }),refresh);
 const first=actions.sync();assert.ok(first);await assert.rejects(first,/합성 Clobe 연결 만료/);
 assert.equal(reads,0);assert.equal(actions.retryRefresh(),null);
 const retry=actions.sync();assert.ok(retry);assert.equal((await retry).refreshed,true);
 assert.equal(saves,2);assert.equal(reads,1);
});

test('반영 가능한 계좌가 없으면 확인 사유를 보존하며 자금 재계산을 주장하지 않는다',async()=>{
 const result={...saved(0,0),skipped:[{account_id:'synthetic-account',reason:'은행 자료 수집 미완료'}]};
 let reads=0;
 const refresh=async()=>{reads++;};
 const actions=createClobeBalanceSyncActions(()=>syncClobePanelBalances(refresh,async()=>Response.json(result)),refresh);
 const task=actions.sync();assert.ok(task);
 const completion=await task,feedback=clobeBalanceSyncFeedback(completion);
 assert.equal(reads,1);assert.deepEqual(completion.result.skipped,result.skipped);
 assert.equal(feedback.title,'반영 가능한 통장 잔액이 없습니다');
 assert.equal(feedback.recalculated,false);assert.match(feedback.counts,/확인 필요 1개/);
});

test('은행 조회·보관 건수를 구분하며 저장 건수를 지급 완료나 계획 연결 건수로 표현하지 않는다',()=>{
 const feedback=clobeBalanceSyncFeedback({result:bankResult(),refreshed:true});
 assert.equal(feedback.title,'잔액·은행 출금 자료를 확인했습니다');
 assert.equal(feedback.outflowCounts,'은행 출금 조회 17건 · 계획용 보관 17건');
 assert.equal(feedback.outflowAccounts,'출금 자료 갱신 2개 계좌 · 최신 유지 4개 · 확인 필요 0개');
 assert.equal(feedback.recalculated,true);assert.equal(feedback.warning,false);
 assert.doesNotMatch([feedback.title,feedback.outflowCounts,feedback.outflowAccounts,feedback.recalculatedText].join(' '),/지급 완료|모두 완료|계획 연결/);
 const unchanged=clobeBalanceSyncFeedback({result:bankResult({synced_accounts:0,unchanged_accounts:6}),refreshed:true});
 assert.equal(unchanged.outflowCounts,feedback.outflowCounts);
 assert.match(unchanged.outflowAccounts!,/갱신 0개 계좌 · 최신 유지 6개/);
});

test('잔액 반영이 성공해도 은행 출금이 일부 실패하면 별도 경고와 통장 사유를 보존한다',async()=>{
 const result=bankResult({synced_accounts:1,unchanged_accounts:4,fetched_outflows:12,saved_outflows:12,complete:false,skipped:[{account_id:'synthetic-account',reason:'합성 다음 페이지 조회 실패'}]});
 const completion=await syncClobePanelBalances(async()=>{},async()=>Response.json(result));
 const feedback=clobeBalanceSyncFeedback(completion);
 assert.equal(completion.refreshed,true);assert.deepEqual(completion.result.plan_actuals,result.plan_actuals);
 assert.equal(feedback.title,'동기화 결과 · 은행 출금 확인 필요');
 assert.equal(feedback.warning,true);assert.equal(feedback.outflowWarning,true);assert.equal(feedback.recalculated,true);
 assert.match(feedback.counts,/확인 필요 0개/);assert.match(feedback.outflowAccounts!,/확인 필요 1개/);
 assert.match(feedback.outflowCounts!,/조회 12건/);
});

test('잔액·은행 출금 저장 후 화면 조회 실패는 두 결과를 유지하고 읽기만 재시도한다',async()=>{
 let saves=0,reads=0,failRead=true;
 const result=bankResult();
 const refresh=async()=>{reads++;if(failRead)throw Error('합성 은행 출금 화면 조회 실패');};
 const actions=createClobeBalanceSyncActions(()=>syncClobePanelBalances(refresh,async()=>{saves++;return Response.json(result);}),refresh);
 const first=actions.sync();assert.ok(first);
 const completion=await first,feedback=clobeBalanceSyncFeedback(completion);
 assert.equal(completion.refreshed,false);assert.deepEqual(completion.result,result);
 assert.equal(feedback.title,'동기화 저장 완료 · 화면 조회 필요');assert.equal(feedback.warning,true);assert.equal(feedback.recalculated,false);
 assert.equal(actions.sync(),null);
 failRead=false;
 const retry=actions.retryRefresh();assert.ok(retry);assert.equal(actions.retryRefresh(),null);
 const final=await retry;
 assert.equal(final.refreshed,true);assert.equal(final.result,completion.result);
 assert.equal(clobeBalanceSyncFeedback(final).recalculated,true);assert.equal(saves,1);assert.equal(reads,2);
});

test('완전 조회의 0건 출금은 조회 결과로 표시하고 모든 계획이 지급됐다고 단정하지 않는다',()=>{
 const feedback=clobeBalanceSyncFeedback({result:bankResult({fetched_outflows:0,saved_outflows:0,synced_accounts:0,unchanged_accounts:6}),refreshed:true});
 assert.equal(feedback.outflowCounts,'은행 출금 조회 0건 · 계획용 보관 0건');
 assert.equal(feedback.outflowWarning,false);assert.equal(feedback.recalculated,true);
 assert.doesNotMatch(JSON.stringify(feedback),/모든.*완료|지급 완료/);
});

test('잔액 없는 응답에서도 보관된 은행 출금은 화면 계산에 사용하되 잔액 확인을 표시한다',()=>{
 const result={...bankResult(),synced:0,unchanged:0};
 const feedback=clobeBalanceSyncFeedback({result,refreshed:true});
 assert.equal(feedback.title,'은행 출금 자료 반영 · 잔액 확인 필요');
 assert.equal(feedback.recalculated,true);assert.equal(feedback.warning,true);
 const empty=clobeBalanceSyncFeedback({result:{...result,plan_actuals:{...result.plan_actuals!,synced_accounts:0,unchanged_accounts:0,fetched_outflows:0,saved_outflows:0}},refreshed:true});
 assert.equal(empty.title,'반영 가능한 통장 자료를 확인해주세요');assert.equal(empty.recalculated,false);assert.equal(empty.warning,true);
});
