import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ClobeDashboardSyncSummary} from '../components/finance/clobe-dashboard-sync-summary';
import {clobeDashboardAccountFailureGroups,clobeDashboardFailureMonthLabel,clobeDashboardSyncBusy,clobeDashboardSyncProgress,clobeDashboardSyncResultLine,clobeDashboardSyncResultTitle} from '../components/finance/clobe-dashboard-sync-display';
import type {ClobeDashboardSyncCompletion,ClobeDashboardSyncSnapshot} from '../lib/finance/clobe-dashboard-sync-client';

const completion=(extra:Partial<ClobeDashboardSyncCompletion>={}):ClobeDashboardSyncCompletion=>({
 scope:{from:'2026-09-01',to:'2026-10-14'},ledger:{inserted:7,referenced:11,unchanged:20,sourceDuplicates:1,blocked:0,updated:0,removed:0,unclassified:0},
 completedMonths:2,totalMonths:2,failures:[],accountFailures:[],monthScopes:[],recoveredMonths:[],sourceThrough:{earliest:'2026-10-12',latest:'2026-10-14'},
 balanceResult:{synced:2,unchanged:4,skipped:[],plan_actuals:{synced_accounts:2,unchanged_accounts:4,fetched_outflows:30,saved_outflows:30,skipped:[],complete:true}},
 balanceError:null,refreshed:true,refreshError:null,fullSuccess:true,...extra,
});
const render=(result:ClobeDashboardSyncCompletion,phase:ClobeDashboardSyncSnapshot['phase']=result.refreshed?'done':'refresh-needed')=>renderToStaticMarkup(createElement(ClobeDashboardSyncSummary,{result,phase,accounts:[],onRetryRefresh:()=>{}}));

test('전체 사업자의 최근 두 달 거래와 현재 잔액 범위를 명시하고 원장 저장·은행 증거 수를 구분한다',()=>{
 const html=render(completion());
 assert.match(html,/전체 사업자 · 저장된 통장 연결 · 최근 2개월 거래 \+ 현재 잔액/);
 assert.match(html,/2026-09-01.*2026-10-14/);assert.match(html,/이번 달·지난달/);
 assert.doesNotMatch(html,/2026-01-01|2026년부터|전체 기간/);
 assert.match(html,/신규 거래 저장/);assert.match(html,/>7건</);assert.match(html,/>11건</);
 assert.match(html,/은행 출금 조회 30건 · 계획용 보관 30건/);
 assert.match(html,/지급 완료를 뜻하지 않습니다/);
 assert.match(html,/기존 거래의 계정과목·메모·금액은 유지/);
 assert.match(html,/화면에서 선택한 기간과 사업자는 유지/);
 assert.match(html,/이번 달 통장 수집 기준일: 2026-10-12.*2026-10-14/);
 assert.match(html,/카드 청구금액은 별도/);
});

test('규칙으로 분류하지 못한 신규 거래는 미분류 수와 정리 진입을 명확히 표시한다',()=>{
 const original=completion(),result={...original,ledger:{...original.ledger,unclassified:3}};
 const html=render(result);
 assert.equal(clobeDashboardSyncResultTitle(result),'최신 동기화 완료 · 미분류 확인 필요');
 assert.match(html,/새 거래 3건.*미분류로 저장/);assert.match(html,/href="\/classification\?biz=all"/);
 assert.match(html,/>미분류 정리</);assert.doesNotMatch(html,/모든.*분류 완료/);
});

test('월별 저장 결과 불명과 은행 조회 실패는 전체 성공을 주장하지 않는다',()=>{
 const result=completion({fullSuccess:false,completedMonths:1,failures:[{month:'2026-09',stage:'apply',message:'합성 저장 결과 확인 필요',uncertain:true,code:'unknown-result'}],balanceResult:null,balanceError:'합성 잔액 조회 실패'});
 const html=render(result);
 assert.equal(clobeDashboardSyncResultTitle(result),'최신 동기화 결과 · 일부 확인 필요');
 assert.match(html,/2026-09 · 거래 저장/);assert.match(html,/저장 여부를 단정할 수 없습니다/);
 assert.match(html,/잔액·출금 조회: 합성 잔액 조회 실패/);assert.match(html,/1\/2개월/);
 assert.doesNotMatch(html,/최신 동기화 완료/);
});

test('원장 저장 후 화면 갱신 실패는 재저장 대신 읽기만 다시 시도할 버튼을 표시한다',()=>{
 const html=render(completion({refreshed:false,fullSuccess:false,refreshError:'합성 화면 조회 실패'}));
 assert.match(html,/화면 조회 필요/);assert.match(html,/합성 화면 조회 실패/);
 assert.match(html,/이미 처리한 거래를 다시 저장하지 않고 화면만 재조회/);
 assert.match(html,/>화면 자료 재조회</);assert.doesNotMatch(html,/최신 동기화 완료/);
});

test('화면 갱신 중의 기본 false 응답이나 이전 재조회 오류를 조기 실패로 표시하지 않는다',()=>{
 const result=completion({refreshed:false,fullSuccess:false,refreshError:'합성 이전 재조회 실패'});
 const html=render(result,'refreshing');
 assert.equal(clobeDashboardSyncResultTitle(result,'refreshing'),'저장 결과 확인 · 화면 갱신 중');
 assert.match(clobeDashboardSyncResultLine(result,'refreshing'),/화면 갱신 중/);
 assert.match(html,/저장 결과 확인 · 화면 갱신 중/);assert.match(html,/분석 화면을 갱신하고 있습니다/);
 assert.doesNotMatch(html,/불러오지 못했습니다|합성 이전 재조회 실패|화면 자료 재조회|role="alert"/);
 const failed=render(result,'refresh-needed');
 assert.match(failed,/합성 이전 재조회 실패/);assert.match(failed,/>화면 자료 재조회</);
});

test('잔액 성공과 계획용 출금 실패를 통장별로 구분하고 모든 계획 지급을 단정하지 않는다',()=>{
 const base=completion(),balance=base.balanceResult!;
 const result=completion({fullSuccess:false,balanceResult:{...balance,skipped:[{account_id:'synthetic-account',reason:'합성 잔액 확인 사유'}],plan_actuals:{...balance.plan_actuals!,complete:false,skipped:[{account_id:'synthetic-account',reason:'합성 은행 출금 확인 사유'}]}}});
 const html=render(result);
 assert.match(html,/잔액 확인 필요한 통장 1개/);assert.match(html,/계획 출금 확인 필요한 통장 1개/);
 assert.match(html,/합성 잔액 확인 사유/);assert.match(html,/합성 은행 출금 확인 사유/);
 assert.match(html,/기존 확인 내역은 유지/);assert.doesNotMatch(html,/최신 동기화 완료/);
});

test('통장 확인 사유는 현재 앱의 사업자·계좌 이름으로 표시한다',()=>{
 const result=completion({fullSuccess:false,balanceResult:{synced:0,unchanged:0,skipped:[{account_id:'synthetic-account',reason:'합성 은행 연결 확인'}]}});
 const accounts=[{id:'synthetic-account',business_id:'synthetic-business',name:'합성 업무 통장',bank:'합성 은행',masked_number:'0000',opening_balance:0,opening_balance_date:null}];
 const businesses=[{id:'synthetic-business',name:'합성 사업자',kind:'법인',representative:'',reserve:0,color:'#123456'}];
 const html=renderToStaticMarkup(createElement(ClobeDashboardSyncSummary,{result,accounts,businesses}));
 assert.match(html,/합성 사업자 · 합성 업무 통장 · 0000/);assert.match(html,/합성 은행 연결 확인/);
});

test('월별 정상 계좌 처리가 끝나도 일부 통장 보류는 사업자·계좌·원인·해당 월을 표시한다',()=>{
 const accountFailures=['2026-09','2026-10'].map(month=>({month,account_id:'synthetic-account',code:'collection' as const,reason:'합성 은행 자료 수집이 완료되지 않았습니다.'}));
 const result=completion({fullSuccess:false,accountFailures,monthScopes:[{month:'2026-10',configuredAccounts:6,verifiedAccounts:5}]});
 const accounts=[{id:'synthetic-account',business_id:'synthetic-business',name:'합성 기업 통장',bank:'합성 은행',masked_number:'0000',opening_balance:0,opening_balance_date:null}];
 const businesses=[{id:'synthetic-business',name:'합성 사업자',kind:'법인',representative:'',reserve:0,color:'#123456'}];
 const html=renderToStaticMarkup(createElement(ClobeDashboardSyncSummary,{result,phase:'done',accounts,businesses}));
 assert.match(html,/일부 확인 필요/);assert.doesNotMatch(html,/최신 동기화 완료/);
 assert.match(html,/2\/2개월 · 조회 보류 1개 통장/);
 assert.match(html,/합성 사업자 · 합성 기업 통장 · 0000/);
 assert.match(html,/보류 월: 2026-09 ~ 2026-10 \(2개월\)/);
 assert.equal((html.match(/합성 은행 자료 수집이 완료되지 않았습니다\./g)||[]).length,1);
 assert.match(html,/정상 조회된 통장은 별도로 처리/);assert.match(html,/기존 거래·분류는 유지/);
});

test('보류 계좌가 같아도 원인이 다르면 나누고 중복 월은 한 번, 떨어진 월은 정확한 목록으로 표시한다',()=>{
 const failures=[
  {month:'2026-03',account_id:'a',code:'collection' as const,reason:'합성 수집 실패'},
  {month:'2026-01',account_id:'a',code:'collection' as const,reason:'합성 수집 실패'},
  {month:'2026-01',account_id:'a',code:'collection' as const,reason:'합성 수집 실패'},
  {month:'2026-03',account_id:'a',code:'timeout' as const,reason:'합성 조회 시간 초과'},
 ];
 const groups=clobeDashboardAccountFailureGroups(failures);
 assert.equal(groups.length,2);assert.deepEqual(groups[0].months,['2026-01','2026-03']);
 assert.equal(clobeDashboardFailureMonthLabel(groups[0].months),'2026-01 · 2026-03');
 assert.equal(clobeDashboardFailureMonthLabel(['2026-12','2027-01']),'2026-12 ~ 2027-01 (2개월)');
 assert.deepEqual(failures.map(item=>item.month),['2026-03','2026-01','2026-01','2026-03']);
});

test('진행 중 단계를 공유하며 읽기 재시도 상태를 새 동기화 진행으로 표시하지 않는다',()=>{
 const base:ClobeDashboardSyncSnapshot={phase:'preparing',month:'2026-09',completedMonths:0,totalMonths:2,result:null,error:null};
 for(const phase of ['preparing','applying','balances','refreshing'] as const)assert.equal(clobeDashboardSyncBusy(phase),true);
 for(const phase of ['idle','done','refresh-needed'] as const)assert.equal(clobeDashboardSyncBusy(phase),false);
 assert.equal(clobeDashboardSyncProgress(base),'2026-09 거래 조회 중');
 assert.equal(clobeDashboardSyncProgress({...base,phase:'applying'}),'2026-09 신규 거래 저장 중');
 assert.match(clobeDashboardSyncProgress({...base,phase:'refreshing'}),/화면 자료 갱신/);
});
