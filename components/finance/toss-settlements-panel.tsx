"use client";

import {useMemo} from 'react';
import {LoaderCircle,RefreshCw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Panel} from './common';
import type {Dataset} from '@/lib/finance/types';
import type {DateRange} from '@/lib/finance/date-range';
import type {TossSettlementState} from './use-toss-settlements';
import './toss-settlements-panel.css';

const digits=(n:number)=>n.toLocaleString('ko-KR');
const statusLabels={pending:'입금 예정',received:'입금 확인',overdue:'입금 확인 필요','confirmation-needed':'입금 확인 필요'};

export function TossSettlementSyncButton({state}:{state:TossSettlementState}){
 return <Button type="button" size="sm" variant="outline" disabled={state.syncing} onClick={()=>void state.sync()} title="토스 정산 예정일과 지급액을 조회하고, 통장에 입금된 금액을 대조합니다.">{state.syncing?<LoaderCircle size={15} className="animate-spin" aria-hidden="true"/>:<RefreshCw size={15} aria-hidden="true"/>}{state.syncing?'토스 정산 동기화 중…':'토스 정산 동기화'}</Button>;
}

export function TossSettlementsPanel({state,data,biz='all',range,showButton=false}:{state:TossSettlementState;data:Dataset;biz?:string;range?:DateRange;showButton?:boolean}){
 const rows=useMemo(()=>state.groups.filter(item=>(biz==='all'||item.businessId===biz)&&(!range||item.date>=range.from&&item.date<=range.to)),[state.groups,biz,range]);
 const pending=rows.reduce((sum,item)=>sum+item.pendingAmount,0),received=rows.reduce((sum,item)=>sum+item.receivedAmount,0);
 const unresolved=rows.filter(item=>item.status==='overdue'||item.status==='confirmation-needed').length;
 const businesses=new Map(data.businesses.map(item=>[item.id,item])),accounts=new Map(data.accounts.map(item=>[item.id,item]));
 return <Panel title="토스 정산 입금" subtitle={state.response?.lastSyncedAt?`동기화 ${new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(state.response.lastSyncedAt))}`:undefined} className="toss-settlements-panel" action={showButton?<TossSettlementSyncButton state={state}/>:undefined}>
  {state.error&&<p className="toss-settlements-error" role="alert">{state.error} <button type="button" onClick={()=>void state.reload()}>자료 다시 조회</button></p>}
  {state.loading?<p className="toss-settlements-empty" role="status">정산 자료 조회 중…</p>:!state.response?<p className="toss-settlements-empty">자료 조회 실패 · 정산 예정액 미반영</p>:state.response.configured===false?<p className="toss-settlements-empty">토스 API 연결 필요 · 정산 예정액 미반영</p>:<>
   <div className="toss-settlements-summary"><div><span>앞으로 받을 금액</span><strong className="positive">{digits(pending)}원</strong></div><div><span>통장 입금 확인 · 중복 제외</span><strong>{digits(received)}원</strong></div>{unresolved>0&&<div><span>통장 대조 필요</span><strong className="toss-settlements-warning">{unresolved}건</strong></div>}</div>
   <details className="toss-settlements-details"><summary>날짜·사업자·입금 계좌 보기 <span>{rows.length}건</span></summary>{rows.length?<div className="toss-settlements-scroll" role="region" tabIndex={0} aria-label="토스 정산 입금 목록"><table><caption className="sr-only">토스 정산 지급일별 금액과 통장 입금 대조 상태. 금액 단위 원.</caption><thead><tr><th scope="col">정산 지급일</th><th scope="col">사업자·입금 계좌</th><th scope="col">토스 지급액</th><th scope="col">앞으로 받을 금액</th><th scope="col">입금 상태</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td><time dateTime={row.date}>{row.date}</time></td><td><strong>{businesses.get(row.businessId)?.name||'사업자 확인 필요'}</strong><small>{accounts.get(row.accountId)?.name||'입금 계좌 확인 필요'}</small></td><td>{digits(row.amount)}</td><td className="positive">{digits(row.pendingAmount)}</td><td><span className={`toss-settlements-status is-${row.status}`} title={row.reason||statusLabels[row.status]}>{row.amount===0?'정산액 0원':statusLabels[row.status]}</span></td></tr>)}</tbody></table></div>:<p className="toss-settlements-empty">{state.response?.lastSyncedAt?'이 기간에 조회된 정산 내역이 없습니다.':'동기화 버튼을 눌러 정산 내역을 가져오세요.'}</p>}</details>
   <details className="toss-settlements-footnote"><summary>정산 반영 기준</summary><p>현재 통장 잔액과 별도로 미래 입금 예정액만 합산합니다. 입금 확인 건과 오늘·지난 지급일의 미확인 금액은 중복 합산하지 않습니다.</p></details>
  </>}
 </Panel>;
}
