"use client";

import {useId,useState} from 'react';
import {format} from 'date-fns';
import {ko} from 'date-fns/locale';
import {CalendarDays,ChevronDown} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Calendar} from '@/components/ui/calendar';
import {Input} from '@/components/ui/input';
import {Popover,PopoverContent,PopoverTrigger} from '@/components/ui/popover';
import {dateRangePreset,formatFinanceDate,isValidDateRange,parseFinanceDate,type DateRange} from '@/lib/finance/date-range';
import {today} from '@/lib/finance/format';
import './date-range-control.css';

const presets=[
 {key:'month',label:'이번 달'},
 {key:'last-month',label:'지난달'},
 {key:'quarter',label:'이번 분기'},
 {key:'year',label:'올해'},
 {key:'all',label:'전체 기간'},
] as const;

function readableDate(value:string){
 const date=parseFinanceDate(value);
 return date?format(date,'yyyy.MM.dd'):'날짜 선택';
}

export function DateRangeControl({label,value,onChange,bounds,compact=false,showPresets=true,validateRange}:{
 label:string;
 value:DateRange;
 onChange:(range:DateRange)=>void;
 bounds?:DateRange;
 compact?:boolean;
 showPresets?:boolean;
 validateRange?:(range:DateRange)=>string;
}){
 const id=useId();
 const [open,setOpen]=useState(false);
 const [draft,setDraft]=useState<DateRange>(value);
 const [selectingEnd,setSelectingEnd]=useState(false);
 const [month,setMonth]=useState<Date>(()=>parseFinanceDate(value.from)||parseFinanceDate(today())||new Date());
 const from=parseFinanceDate(draft.from);
 const to=parseFinanceDate(draft.to);
 const chronological=isValidDateRange(draft);
 const error=!from||!to?'시작일과 종료일을 모두 선택해 주세요.':!chronological?'종료일은 시작일과 같거나 이후여야 합니다.':validateRange?.(draft)||'';
 const valid=chronological&&!error;
 const rangeSummary=`${readableDate(value.from)} – ${readableDate(value.to)}`;
 const currentDate=parseFinanceDate(today())||new Date();
 // Data bounds determine the “all” shortcut, never which dates can be selected.
 const firstYear=Math.min(1900,from?.getFullYear()||currentDate.getFullYear(),month.getFullYear());
 const lastYear=Math.max(currentDate.getFullYear()+20,to?.getFullYear()||currentDate.getFullYear(),month.getFullYear());

 function changeOpen(next:boolean){
  if(next){setDraft({...value});setSelectingEnd(false);setMonth(parseFinanceDate(value.from)||currentDate);}
  setOpen(next);
 }

 function changeInput(endpoint:'from'|'to',date:string){
  setSelectingEnd(false);
  setDraft(current=>({...current,[endpoint]:date}));
  const parsed=parseFinanceDate(date);
  if(parsed)setMonth(parsed);
 }

 return <Popover open={open} onOpenChange={changeOpen}>
  <PopoverTrigger asChild>
   <Button type="button" variant="outline" className={`finance-range-trigger${compact?' finance-range-trigger-compact':''}`} aria-label={`${label} 기간 선택: ${rangeSummary}`}>
    <CalendarDays size={17} aria-hidden="true"/>
    <span className="finance-range-trigger-copy"><span className="finance-range-trigger-label">{label}</span><span className="finance-range-trigger-value">{rangeSummary}</span></span>
    <ChevronDown size={14} aria-hidden="true"/>
   </Button>
  </PopoverTrigger>
  <PopoverContent align="end" sideOffset={8} collisionPadding={12} className="finance-range-popover" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`}>
   <form noValidate onSubmit={event=>{event.preventDefault();if(valid){onChange({...draft});setOpen(false);}}}>
    <div className="finance-range-heading"><CalendarDays size={18} aria-hidden="true"/><h3 id={`${id}-title`}>{label} 기간 선택</h3></div>
    <p id={`${id}-help`} className="finance-range-help">날짜를 입력하거나 달력에서 시작일과 종료일을 차례로 선택해 주세요.</p>
    {showPresets&&<div className="finance-range-presets" aria-label="빠른 기간 선택">
     {presets.map(preset=><Button type="button" key={preset.key} variant="outline" size="sm" disabled={preset.key==='all'&&(!bounds||!isValidDateRange(bounds))} onClick={()=>{const range=dateRangePreset(preset.key,today(),bounds);setDraft(range);setSelectingEnd(false);setMonth(parseFinanceDate(range.from)||currentDate);}}>{preset.label}</Button>)}
    </div>}
    <div className="finance-range-fields">
     <label htmlFor={`${id}-from`}><span>시작일</span><Input id={`${id}-from`} type="date" min="1900-01-01" max="9999-12-31" value={draft.from} onInput={event=>changeInput('from',event.currentTarget.value)} onChange={event=>changeInput('from',event.target.value)} aria-label={`${label} 시작일`} aria-invalid={!from||!!(to&&!valid)} aria-describedby={error?`${id}-status`:undefined}/></label>
     <span className="finance-range-separator" aria-hidden="true">–</span>
     <label htmlFor={`${id}-to`}><span>종료일</span><Input id={`${id}-to`} type="date" min="1900-01-01" max="9999-12-31" value={draft.to} onInput={event=>changeInput('to',event.currentTarget.value)} onChange={event=>changeInput('to',event.target.value)} aria-label={`${label} 종료일`} aria-invalid={!to||!!(from&&!valid)} aria-describedby={error?`${id}-status`:undefined}/></label>
    </div>
    <Calendar
     mode="range"
     locale={ko}
     month={month}
     onMonthChange={setMonth}
     selected={from?{from,to:valid?to:undefined}:undefined}
     onSelect={(_range,day)=>{
      const date=formatFinanceDate(day);
      if(selectingEnd&&from){setDraft(date<draft.from?{from:date,to:draft.from}:{from:draft.from,to:date});setSelectingEnd(false);}
      else{setDraft({from:date,to:''});setSelectingEnd(true);}
     }}
     captionLayout="dropdown"
     startMonth={new Date(firstYear,0,1)}
     endMonth={new Date(lastYear,11,31)}
     today={currentDate}
     fixedWeeks
     className="finance-range-calendar"
     formatters={{formatMonthDropdown:date=>format(date,'M월',{locale:ko}),formatYearDropdown:date=>format(date,'yyyy년',{locale:ko})}}
     labels={{
      labelNav:()=>`${label} 달력 탐색`,
      labelPrevious:()=>'이전 달',
      labelNext:()=>'다음 달',
      labelMonthDropdown:()=>'월 선택',
      labelYearDropdown:()=>'연도 선택',
      labelGrid:date=>format(date,'yyyy년 M월',{locale:ko}),
      labelWeekday:date=>format(date,'EEEE',{locale:ko}),
      labelDayButton:(date,modifiers)=>`${format(date,'yyyy년 M월 d일 EEEE',{locale:ko})}${modifiers.today?', 오늘':''}${modifiers.selected?', 선택됨':''}`,
     }}
    />
    <div id={`${id}-status`} className={`finance-range-status${error&&!selectingEnd?' finance-range-error':''}`} role="status" aria-live="polite">{selectingEnd?`${readableDate(draft.from)} 시작 · 종료일을 선택해 주세요.`:error||`${readableDate(draft.from)} – ${readableDate(draft.to)}`}</div>
    <div className="finance-range-actions"><Button type="button" variant="outline" onClick={()=>setOpen(false)}>취소</Button><Button type="submit" disabled={!valid}>적용</Button></div>
   </form>
  </PopoverContent>
 </Popover>;
}
