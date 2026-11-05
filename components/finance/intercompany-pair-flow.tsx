import type {IntercompanyBaseline,IntercompanyPair} from '@/lib/finance/intercompany-register';

export type IntercompanyPairFlowProps={
 pair:IntercompanyPair;
 sourceAdditions?:readonly IntercompanyBaseline['additions'][number][];
};

const won=(amount:number)=>`${amount.toLocaleString('ko-KR')}원`;

/** Read-only view of the existing pair model. Source additions are evidence, never added again. */
export function IntercompanyPairFlow({pair,sourceAdditions=[]}:IntercompanyPairFlowProps){
 const {businessA,businessB}=pair;
 const isThisPair=(from:string,to:string)=>(from===businessA.key&&to===businessB.key)||(from===businessB.key&&to===businessA.key);
 const partyName=(key:string)=>key===businessA.key?businessA.name:key===businessB.key?businessB.name:'사업자 확인 필요';
 const sourceRows=sourceAdditions.filter(row=>isThisPair(row.from_business,row.to_business));
 const activeEntries=pair.manualEntries.filter(entry=>!entry.voided&&isThisPair(entry.from_party,entry.to_party));
 const records=[
  ...sourceRows.map(row=>({id:`source:${row.id}`,date:row.date,from:row.from_business,to:row.to_business,amount:row.amount,memo:row.memo,label:'원본 기재 자금이동',source:true})),
  ...activeEntries.map(entry=>({id:entry.id,date:entry.entry_date,from:entry.from_party,to:entry.to_party,amount:entry.amount,memo:entry.memo,label:entry.kind==='loan'?'등록 · 대여금 지급':'등록 · 대여금 상환',source:false})),
 ].sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
 return <article className={`intercompany-flow-card${pair.amount===0?' is-balanced':''}`} aria-label={`${businessA.name} · ${businessB.name} 주고받은 금액`}>
  <header className="intercompany-flow-heading"><h3>{businessA.name}<span aria-hidden="true">↔</span>{businessB.name}</h3><span>보낸 금액 누계</span></header>
  <div className="intercompany-flow-directions">
   <div className="intercompany-flow-sent" data-from-party={businessA.key} data-to-party={businessB.key}><span className="intercompany-flow-route"><span>{businessA.name}</span><b aria-hidden="true">→</b><span>{businessB.name}</span></span><strong>{won(pair.aToB)} <small>보냄</small></strong></div>
   <div className="intercompany-flow-sent" data-from-party={businessB.key} data-to-party={businessA.key}><span className="intercompany-flow-route"><span>{businessB.name}</span><b aria-hidden="true">→</b><span>{businessA.name}</span></span><strong>{won(pair.bToA)} <small>보냄</small></strong></div>
  </div>
  <div className="intercompany-flow-result"><span>기록상 차액</span>{pair.amount===0?<><strong>양쪽이 보낸 누계가 같습니다.</strong><b>0원</b></>:<><strong>{pair.creditor?.name||'채권자 확인 필요'}가 {pair.debtor?.name||'채무자 확인 필요'}에서 받을 차액</strong><b>{won(pair.amount)}</b></>}<p className="intercompany-flow-formula" aria-label="기록상 차액 계산식">{won(Math.max(pair.aToB,pair.bToA))} − {won(Math.min(pair.aToB,pair.bToA))} = <strong>{won(pair.amount)}</strong></p></div>
  <details className="intercompany-flow-evidence"><summary>기록·메모 보기<span>{records.length}건 개별 기재</span></summary><div className="intercompany-flow-evidence-body">
   {pair.note&&<div className="intercompany-flow-source-memo"><h4>원본 메모</h4><p>{pair.note}</p><small>메모는 원문이며 차액 계산은 위 누계를 기준으로 합니다.</small></div>}
   <div className="intercompany-flow-baseline"><h4>원본 기준 누계</h4><p><span>{businessA.name} → {businessB.name}</span><strong>{won(pair.baselineAtoB)}</strong></p><p><span>{businessB.name} → {businessA.name}</span><strong>{won(pair.baselineBtoA)}</strong></p><small>별도로 기재된 원본 기록과 정상 등록은 아래에서 확인하세요. 반영 결과는 위 보낸 누계에 표시합니다.</small></div>
   <h4>개별 기재 내역</h4><p className="intercompany-flow-record-note">아래는 별도로 기재된 기록입니다. 누계 전체의 개별 은행 거래내역을 뜻하지 않습니다.</p>
   {records.length?<ul className="intercompany-flow-records">{records.map(record=><li key={record.id}><div><time dateTime={record.date}>{record.date}</time><span>{record.label}</span></div><p><span>{partyName(record.from)} → {partyName(record.to)}</span><strong>{won(record.amount)}</strong></p>{record.memo&&<p className="intercompany-flow-record-memo">{record.memo}</p>}{record.source&&<small>위 보낸 누계에 반영된 기록입니다.</small>}</li>)}</ul>:<p className="intercompany-flow-record-note">이 쌍은 누계 자료만 저장되어 있습니다. 개별 기재 내역이 없습니다.</p>}
  </div></details>
 </article>;
}
