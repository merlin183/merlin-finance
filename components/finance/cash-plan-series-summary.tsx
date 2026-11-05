import {useId,type MouseEvent} from 'react';
import {ChevronLeft,ChevronRight,RefreshCw} from 'lucide-react';
import {Input} from '@/components/ui/input';
import {Button} from '@/components/ui/button';
import {Panel} from './common';
import {calendarMonthRange,shiftCalendarMonth} from '@/lib/finance/transaction-calendar';

export type CashPlanSeriesSummaryMonth={
 businessId:string;businessName:string;month:string;operatingAmount:number;installmentAmount:number;total:number;notes:string[];registered?:boolean;
};

const amounts=new Intl.NumberFormat('ko-KR',{maximumFractionDigits:0});
const monthLabel=(month:string)=>`${Number(month.slice(0,4))}년 ${Number(month.slice(5,7))}월`;
const amountLabel=(value:number|undefined)=>value===undefined?'확인 필요':amounts.format(value);
const plannedAmount=(row:CashPlanSeriesSummaryMonth|undefined,kind:'operatingAmount'|'installmentAmount'|'total')=>row?.registered===false?'등록 전':amountLabel(row?.[kind]);

/** A full-month budget view. These totals never become a second cash deduction. */
export function CashPlanSeriesSummary({rows,fromMonth,selectedMonth,onMonthChange,onSelectMonth,onOpenBreakdown,openedBreakdown,onSync,syncing=false,syncDisabled=false,syncError=''}:{
 rows:readonly CashPlanSeriesSummaryMonth[];fromMonth:string;selectedMonth:string;
 onMonthChange:(month:string)=>void;onSelectMonth:(month:string)=>void;
 onOpenBreakdown:(businessId:string,month:string,event:MouseEvent<HTMLButtonElement>)=>void;
 openedBreakdown?:{businessId:string;month:string}|null;
 onSync?:()=>void;syncing?:boolean;syncDisabled?:boolean;syncError?:string;
}){
 const monthId=useId();
 const months=Array.from({length:6},(_,index)=>shiftCalendarMonth(fromMonth,index));
 const byBusiness=new Map<string,{name:string;months:Map<string,CashPlanSeriesSummaryMonth>;notes:Set<string>}>();
 for(const row of rows){
  const group=byBusiness.get(row.businessId)??{name:row.businessName,months:new Map<string,CashPlanSeriesSummaryMonth>(),notes:new Set<string>()};
  group.months.set(row.month,row);
  for(const note of row.notes)if(note.trim())group.notes.add(note);
  byBusiness.set(row.businessId,group);
 }
 if(byBusiness.size===0)return null;
 const previous=shiftCalendarMonth(fromMonth,-1),next=shiftCalendarMonth(fromMonth,1);
 const changeMonth=(value:string)=>{
  if(value<'1900-01'||value>'9999-07')return;
  try{calendarMonthRange(value);onMonthChange(value);}catch{/* Keep the last valid month while a date field is incomplete. */}
 };
 return <Panel title="월별 고정비·부가세 할부" subtitle="월 전체 계획액 · 할부 기간이 끝나면 자동 제외 · 단위: 원" className="cash-series-panel" action={<div className="cash-series-controls">
  {onSync&&<Button type="button" variant="outline" size="sm" aria-label={`${monthLabel(fromMonth)} 지출계획표 반영`} title={`${monthLabel(fromMonth)}의 현재 지출계획을 이 달 고정비에만 반영합니다.`} disabled={syncing||syncDisabled} onClick={onSync}><RefreshCw size={14} className={syncing?'animate-spin':undefined}/>{syncing?'반영 중…':'지출계획표 반영'}</Button>}
  <Button type="button" variant="outline" size="icon-sm" aria-label="월별 필요자금 이전 달" disabled={previous===fromMonth} onClick={()=>onMonthChange(previous)}><ChevronLeft size={15}/></Button>
  <label htmlFor={monthId} className="sr-only">월별 필요자금 시작월</label><Input id={monthId} aria-label="월별 필요자금 시작월" type="month" min="1900-01" max="9999-07" value={fromMonth} onChange={event=>changeMonth(event.target.value)}/>
  <Button type="button" variant="outline" size="icon-sm" aria-label="월별 필요자금 다음 달" disabled={next===fromMonth||next>'9999-07'} onClick={()=>onMonthChange(next)}><ChevronRight size={15}/></Button>
 </div>}>
  {syncError&&<p className="cash-series-fixed-error" role="alert">{syncError}</p>}
  <div className="cash-series-scroll" tabIndex={0} role="region" aria-label="사업자별 월 고정비와 부가세 할부 계획표">
   <table className="cash-series-table">
    <caption className="sr-only">사업자별 기본 고정비와 한시적 부가세 할부를 합친 월 필요자금입니다. 월을 누르면 해당 월 지출계획표를 확인합니다.</caption>
    <thead><tr><th scope="col">사업자</th><th scope="col">구분</th>{months.map(month=><th scope="col" key={month}><button type="button" aria-label={`${monthLabel(month)} 지출계획표 보기`} aria-pressed={selectedMonth===month} onClick={()=>onSelectMonth(month)}><time dateTime={`${month}-01`}>{monthLabel(month)}</time></button></th>)}</tr></thead>
    {[...byBusiness].map(([businessId,group])=><tbody key={businessId}>
     <tr><th scope="rowgroup" rowSpan={3} className="cash-series-business">{group.name}</th><th scope="row">기본 고정비</th>{months.map(month=>{const row=group.months.get(month);return <td key={month}>{row?<button type="button" className="cash-series-detail-button" aria-label={`${group.name} ${monthLabel(month)} 기본 고정비 ${row.registered===false?'항목 추가':'내역보기'}`} aria-haspopup="dialog" aria-expanded={openedBreakdown?.businessId===businessId&&openedBreakdown.month===month} onClick={event=>onOpenBreakdown(businessId,month,event)}><span>{plannedAmount(row,'operatingAmount')}</span><small>{row.registered===false?'항목 추가':'내역보기'} <ChevronRight size={11}/></small></button>:plannedAmount(row,'operatingAmount')}</td>;})}</tr>
     <tr><th scope="row">부가세 할부</th>{months.map(month=>{const row=group.months.get(month);return <td key={month} className={row?.registered!==false&&row?.installmentAmount===0?'cash-series-zero':''}>{plannedAmount(row,'installmentAmount')}</td>;})}</tr>
     <tr className="cash-series-total"><th scope="row">월 필요자금</th>{months.map(month=><td key={month}>{plannedAmount(group.months.get(month),'total')}</td>)}</tr>
    </tbody>)}
   </table>
  </div>
  <div className="cash-series-notes"><p>사업자별 기본 고정비의 내역보기·항목 추가에서 추가·수정·삭제합니다. 카드대금도 내역보기에서 직접 입력할 수 있습니다.</p><p>저장한 고정비·카드대금·부가세 할부 예산이며 다른 변동 지출은 별도입니다. 실제 출금·남은 지출과 구분하며 위 합계를 잔액에서 다시 차감하지 않습니다.</p>{rows.some(row=>row.registered===false)&&<p>등록 전은 해당 월의 계획이 아직 등록되지 않았다는 뜻입니다. 항목 추가를 누르면 새 계획을 입력할 수 있습니다.</p>}{[...byBusiness].map(([businessId,group])=>group.notes.size>0&&<details key={businessId}><summary>{group.name} 계획 메모 · {group.notes.size}건</summary><ul>{[...group.notes].map(note=><li key={note}>{note}</li>)}</ul></details>)}</div>
 </Panel>;
}
