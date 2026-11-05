import type {ClobeDashboardSyncCompletion,ClobeDashboardSyncSnapshot} from '@/lib/finance/clobe-dashboard-sync-client';
import type {Dataset} from '@/lib/finance/types';
import {Button} from '@/components/ui/button';
import {FinanceLink} from './common';
import {clobeDashboardAccountFailureGroups,clobeDashboardFailureMonthLabel,clobeDashboardSyncBusy,clobeDashboardSyncResultTitle} from './clobe-dashboard-sync-display';

const count=(value:number)=>value.toLocaleString('ko-KR');

export function ClobeDashboardSyncSummary({result,phase='done',accounts,businesses=[],onRetryRefresh,onNavigate}:{result:ClobeDashboardSyncCompletion;phase?:ClobeDashboardSyncSnapshot['phase'];accounts:Dataset['accounts'];businesses?:Dataset['businesses'];onRetryRefresh?:()=>void;onNavigate?:()=>void}){
 const balance=result.balanceResult,actuals=balance?.plan_actuals;
 const pending=clobeDashboardSyncBusy(phase),refreshFailed=phase==='refresh-needed';
 const accountFailures=clobeDashboardAccountFailureGroups(result.accountFailures??[]);
 const skippedAccounts=new Set(accountFailures.map(item=>item.accountId)).size;
 const accountName=(id?:string)=>{const account=accounts.find(item=>item.id===id),business=businesses.find(item=>item.id===account?.business_id);return account?[business?.name,account.name,account.masked_number].filter(Boolean).join(' · '):'연결된 통장';};
 return <div className="clobe-dashboard-sync-summary">
  <p className={result.fullSuccess||pending?'':'text-destructive'} role={pending?'status':undefined}>{clobeDashboardSyncResultTitle(result,phase)}</p>
  <p className="text-sm text-muted-foreground">전체 사업자 · 저장된 통장 연결 · 최근 2개월 거래 + 현재 잔액<br/>{result.scope.from} ~ {result.scope.to} (이번 달·지난달)</p>
  {result.sourceThrough.earliest&&<p className="text-xs text-muted-foreground">이번 달 통장 수집 기준일: {result.sourceThrough.earliest}{result.sourceThrough.latest!==result.sourceThrough.earliest&&` ~ ${result.sourceThrough.latest}`}. 이후 은행 거래는 Clobe 수집 후 반영됩니다.</p>}
  <dl className="clobe-dashboard-sync-counts">
   <div><dt>신규 거래 저장</dt><dd>{count(result.ledger.inserted)}건</dd></div>
   <div><dt>기존 거래 연결</dt><dd>{count(result.ledger.referenced)}건</dd></div>
   <div><dt>확인 필요 · 보류</dt><dd>{count(result.ledger.blocked)}건</dd></div>
   <div><dt>신규 미분류</dt><dd>{count(result.ledger.unclassified)}건</dd></div>
   <div><dt>잔액 갱신</dt><dd>{balance?`${count(balance.synced)}개 통장`:'조회 실패'}</dd></div>
   <div><dt>잔액 최신 유지</dt><dd>{balance?`${count(balance.unchanged)}개 통장`:'확인 필요'}</dd></div>
  </dl>
  <p className="text-xs text-muted-foreground">월별 거래 처리 {result.completedMonths}/{result.totalMonths}개월{skippedAccounts>0&&` · 조회 보류 ${skippedAccounts}개 통장`} · 기존 거래의 계정과목·메모·금액은 유지합니다.</p>
  {phase==='refreshing'&&<p className="text-xs text-muted-foreground" role="status">저장한 결과로 거래·잔액·자금계획·분석 화면을 갱신하고 있습니다.</p>}
  {refreshFailed&&<div className="clobe-dashboard-sync-warning" role="alert"><p>{result.refreshError||'화면 자료를 다시 불러오지 못했습니다.'}</p><p>이미 처리한 거래를 다시 저장하지 않고 화면만 재조회합니다.</p>{onRetryRefresh&&<Button type="button" size="sm" variant="outline" onClick={onRetryRefresh}>화면 자료 재조회</Button>}</div>}
  {result.failures.length>0&&<div className="clobe-dashboard-sync-warning"><strong>월별 확인 필요</strong><ul>{result.failures.map((failure,index)=><li key={`${failure.month}:${failure.stage}:${index}`}><strong>{failure.month} · {failure.stage==='prepare'?'거래 조회':'거래 저장'}</strong><span>{failure.message}</span>{failure.uncertain&&<small>저장 여부를 단정할 수 없습니다. 다시 동기화하면 같은 요청의 결과부터 확인합니다.</small>}</li>)}</ul></div>}
  {accountFailures.length>0&&<div className="clobe-dashboard-sync-warning"><strong>통장별 거래 조회 보류</strong><p>아래 통장은 해당 기간의 은행 자료를 확인하지 못해 거래 가져오기를 보류했습니다. 정상 조회된 통장은 별도로 처리하며, 보류된 통장의 기존 거래·분류는 유지합니다.</p><ul>{accountFailures.map(item=><li key={JSON.stringify([item.accountId,item.code,item.reason])}><strong>{accountName(item.accountId)}</strong><small>보류 월: {clobeDashboardFailureMonthLabel(item.months)}</small><span>{item.reason}</span></li>)}</ul></div>}
  {result.balanceError&&<p className="text-sm text-destructive">잔액·출금 조회: {result.balanceError}</p>}
  {!!balance?.skipped.length&&<details><summary>잔액 확인 필요한 통장 {balance.skipped.length}개</summary><ul>{balance.skipped.map((item,index)=><li key={`${item.account_id}:${index}`}><strong>{accountName(item.account_id)}</strong><span>{item.reason}</span></li>)}</ul></details>}
  {!!actuals?.skipped.length&&<details><summary>계획 출금 확인 필요한 통장 {actuals.skipped.length}개</summary><ul>{actuals.skipped.map((item,index)=><li key={`${item.account_id}:${index}`}><strong>{accountName(item.account_id)}</strong><span>{item.reason}</span></li>)}</ul></details>}
  {actuals&&!actuals.complete&&<p className="text-xs text-destructive">일부 계획의 은행 출금은 확인이 필요합니다. 기존 확인 내역은 유지됩니다.</p>}
  {result.ledger.unclassified>0&&<div className="clobe-dashboard-sync-warning"><p>새 거래 {count(result.ledger.unclassified)}건은 기존 분류 규칙으로 확인하지 못해 미분류로 저장했습니다.</p><Button type="button" size="sm" asChild><FinanceLink href="/classification?biz=all" onClick={onNavigate}>미분류 정리</FinanceLink></Button></div>}
  <div className="clobe-dashboard-sync-links"><Button type="button" size="sm" variant="outline" asChild><FinanceLink href="/transactions?biz=all" onClick={onNavigate}>거래 내역 보기</FinanceLink></Button><Button type="button" size="sm" variant="outline" asChild><FinanceLink href="/upload?biz=all" onClick={onNavigate}>통장 연결·미리보기</FinanceLink></Button></div>
  <details className="clobe-sync-method"><summary>동기화 기준</summary>{actuals&&<p className="text-xs text-muted-foreground">은행 출금 조회 {count(actuals.fetched_outflows)}건 · 계획용 보관 {count(actuals.saved_outflows)}건. 보관 건수는 신규 거래 수나 모든 계획의 지급 완료를 뜻하지 않습니다.</p>}<p className="text-xs text-muted-foreground">거래·잔액·자금계획·분석의 공통 자료를 갱신합니다. 화면에서 선택한 기간과 사업자는 유지되므로 새 거래가 필터 밖이면 조회 기간을 변경해주세요. 카드 청구금액은 별도 ‘카드 청구 동기화’에서 확인합니다.</p></details>
 </div>;
}
