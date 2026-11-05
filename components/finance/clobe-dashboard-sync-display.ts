import type {ClobeDashboardSyncAccountFailure,ClobeDashboardSyncCompletion,ClobeDashboardSyncSnapshot} from '@/lib/finance/clobe-dashboard-sync-client';

export function clobeDashboardAccountFailureGroups(failures:ReadonlyArray<ClobeDashboardSyncAccountFailure>){
 const groups=new Map<string,{accountId:string;reason:string;code:ClobeDashboardSyncAccountFailure['code'];months:string[]}>();
 for(const failure of failures){
  const key=JSON.stringify([failure.account_id,failure.code,failure.reason]);
  const group=groups.get(key)??{accountId:failure.account_id,reason:failure.reason,code:failure.code,months:[]};
  if(!group.months.includes(failure.month))group.months.push(failure.month);
  groups.set(key,group);
 }
 return [...groups.values()].map(group=>({...group,months:group.months.sort()}));
}

export function clobeDashboardFailureMonthLabel(months:ReadonlyArray<string>){
 const sorted=[...new Set(months)].sort();
 const values=sorted.map(month=>Number(month.slice(0,4))*12+Number(month.slice(5))-1);
 if(sorted.length>1&&values.every((value,index)=>index===0||value===values[index-1]+1))return `${sorted[0]} ~ ${sorted.at(-1)} (${sorted.length}개월)`;
 return sorted.join(' · ');
}

export function clobeDashboardSyncBusy(phase:ClobeDashboardSyncSnapshot['phase']){
 return phase==='preparing'||phase==='applying'||phase==='balances'||phase==='refreshing';
}

export function clobeDashboardSyncProgress(snapshot:ClobeDashboardSyncSnapshot){
 if(snapshot.phase==='preparing')return snapshot.month?`${snapshot.month} 거래 조회 중`:'전체 통장 연결 확인 중';
 if(snapshot.phase==='applying')return `${snapshot.month||''} 신규 거래 저장 중`.trim();
 if(snapshot.phase==='balances')return '현재 잔액·계획 출금 확인 중';
 if(snapshot.phase==='refreshing')return '다른 탭의 화면 자료 갱신 중';
 return '';
}

export function clobeDashboardSyncResultTitle(result:ClobeDashboardSyncCompletion,phase?:ClobeDashboardSyncSnapshot['phase']){
 if(phase&&clobeDashboardSyncBusy(phase))return phase==='refreshing'?'저장 결과 확인 · 화면 갱신 중':'동기화 진행 중';
 if(!result.refreshed)return '저장 결과 확인 · 화면 조회 필요';
 if(result.fullSuccess)return result.ledger.unclassified?'최신 동기화 완료 · 미분류 확인 필요':'최신 동기화 완료';
 return '최신 동기화 결과 · 일부 확인 필요';
}

export function clobeDashboardSyncResultLine(result:ClobeDashboardSyncCompletion,phase?:ClobeDashboardSyncSnapshot['phase']){
 const refresh=phase==='refreshing'?'화면 갱신 중':result.refreshed?'화면 갱신 완료':'화면 재조회 필요';
 return `신규 거래 ${result.ledger.inserted.toLocaleString('ko-KR')}건 · 미분류 ${result.ledger.unclassified.toLocaleString('ko-KR')}건 · ${refresh}`;
}
